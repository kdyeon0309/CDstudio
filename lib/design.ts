/**
 * design.ts — 로컬 Claude CLI(`claude -p`) 헤드리스 래퍼
 *
 * 앨범 아트워크 3안(앞커버/뒷커버/CD라벨)을 완전 자립형 HTML 로 생성한다.
 *
 * ★ 규칙
 *  - 모든 외부 프로세스 실행은 인자 배열로만 spawn 한다 (셸 문자열 조합 금지).
 *  - 사용자 입력(앨범명/아티스트/컨셉/피드백)은 프롬프트 텍스트로만 들어가고
 *    stdin 을 통해 전달된다 — 셸을 거치지 않는다.
 *  - 생성 결과는 artwork/variant-{n}-{part}.html 로 저장된다 (ArtworkVariant.files 계약).
 */
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import type {
  AlbumProject,
  ArtworkPart,
  ArtworkVariant,
  Track,
} from "./types";
import { PRINT_SPECS, formatDuration } from "./types";
import { artworkDir, assetsDir } from "./storage";

/** claude CLI 경로 (PATH 비의존). 환경변수로 덮어쓸 수 있다. */
export const CLAUDE_BIN = process.env.CDSTUDIO_CLAUDE_BIN ?? "/opt/homebrew/bin/claude";

/** 안 1개당 생성 타임아웃 (기본 10분) */
const DEFAULT_TIMEOUT_MS = Number(process.env.CDSTUDIO_DESIGN_TIMEOUT_MS ?? 10 * 60 * 1000);

/** 프롬프트에 첨부할 사진 제한 */
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 개당 5MB
const MAX_PHOTO_TOTAL_BYTES = 12 * 1024 * 1024; // 합계 12MB

/** refine 시 기존 HTML 을 컨텍스트로 넣을 때의 문자 수 상한 */
const MAX_CONTEXT_CHARS = 16000;

export const ARTWORK_PARTS: ArtworkPart[] = ["front", "back", "label"];

const PART_LABEL: Record<ArtworkPart, string> = {
  front: "앞커버",
  back: "뒷커버(트레이 카드)",
  label: "CD 라벨",
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 3안을 서로 다른 방향으로 밀어주기 위한 힌트 */
const STYLE_HINTS: Record<number, string> = {
  1: "미니멀 타이포그래피 중심. 여백이 넉넉하고, 큰 제목 활자와 절제된 2~3색 팔레트. 인쇄했을 때 정갈한 느낌.",
  2: "아날로그 질감 중심. 필름 그레인/종이 결/빈티지 인쇄 느낌, 따뜻한 색조, 살짝 어긋난 레이어와 손맛 나는 배치.",
  3: "대담한 그래픽 중심. 강한 색면 대비와 기하학적 도형, 굵은 활자, 포스터 같은 존재감.",
};

/** 생성 중 진행 상황 보고용 콜백 */
export type StatusFn = (message: string) => void;

export class DesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignError";
  }
}

// ── 파일명 계약 ────────────────────────────────────────────────

export function variantFileName(index: number, part: ArtworkPart): string {
  return `variant-${index}-${part}.html`;
}

export function variantFiles(index: number): Record<ArtworkPart, string> {
  return {
    front: variantFileName(index, "front"),
    back: variantFileName(index, "back"),
    label: variantFileName(index, "label"),
  };
}

// ── 사진(assets) 로딩 ─────────────────────────────────────────

interface Photo {
  token: string; // 프롬프트에서 쓰는 치환 토큰
  filename: string;
  dataUri: string;
  bytes: number;
}

/**
 * assets/ 의 사진을 base64 data URI 로 읽는다.
 * 프롬프트에는 토큰만 넣고, 생성된 HTML 의 토큰을 실제 data URI 로 치환한다.
 * (프롬프트가 수 MB 로 부풀지 않게 하기 위함)
 */
async function loadPhotos(projectId: string, onStatus?: StatusFn): Promise<Photo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(assetsDir(projectId));
  } catch {
    return [];
  }

  const candidates = entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()))
    .sort();

  const photos: Photo[] = [];
  let total = 0;
  let skippedBig = 0;

  for (const name of candidates) {
    if (photos.length >= MAX_PHOTOS) break;
    const file = path.join(assetsDir(projectId), name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_PHOTO_BYTES || total + stat.size > MAX_PHOTO_TOTAL_BYTES) {
      skippedBig += 1;
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "image/png";
    photos.push({
      token: `__PHOTO_${photos.length + 1}__`,
      filename: name,
      dataUri: `data:${mime};base64,${buf.toString("base64")}`,
      bytes: stat.size,
    });
    total += stat.size;
  }

  if (onStatus) {
    if (photos.length > 0) {
      onStatus(`업로드 사진 ${photos.length}장을 디자인에 사용합니다.`);
    }
    if (skippedBig > 0) {
      onStatus(
        `사진 ${skippedBig}장은 용량 제한(개당 5MB · 합계 12MB · 최대 ${MAX_PHOTOS}장)으로 제외했습니다.`,
      );
    }
    if (candidates.length > MAX_PHOTOS) {
      onStatus(`사진은 최대 ${MAX_PHOTOS}장까지만 사용합니다.`);
    }
  }

  return photos;
}

/** 생성된 HTML 의 사진 토큰을 실제 data URI 로 치환 */
function applyPhotos(html: string, photos: Photo[]): string {
  let out = html;
  for (const photo of photos) {
    out = out.split(photo.token).join(photo.dataUri);
  }
  // 남은 미지의 토큰은 투명 1px 로 대체 (깨진 이미지 방지)
  out = out.replace(
    /__PHOTO_\d+__/g,
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  );
  return out;
}

/** refine 컨텍스트용: 거대한 data URI 를 토큰/축약형으로 되돌린다 */
function stripDataUris(html: string, photos: Photo[]): string {
  let out = html;
  for (const photo of photos) {
    out = out.split(photo.dataUri).join(photo.token);
  }
  // 알 수 없는 대용량 data URI 는 축약
  out = out.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]{200,}/g, "__PHOTO_1__");
  return out;
}

/** 외부 리소스 참조 경고 (자립형 HTML 위반 감지) */
function externalRefWarnings(html: string): string[] {
  const warnings: string[] = [];
  if (/<link[^>]+href=["']?https?:/i.test(html)) warnings.push("외부 스타일시트(<link>)");
  if (/<script[^>]+src=["']?https?:/i.test(html)) warnings.push("외부 스크립트(<script src>)");
  if (/<img[^>]+src=["']?https?:/i.test(html)) warnings.push("외부 이미지(<img src>)");
  if (/@import\s+url\(\s*["']?https?:/i.test(html)) warnings.push("@import 외부 폰트/CSS");
  return warnings;
}

// ── claude CLI 실행 ───────────────────────────────────────────

interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `claude -p` 헤드리스 호출. 프롬프트는 stdin 으로 전달한다(셸 미경유·길이 제한 회피).
 *  --tools ""      : 도구 사용 없이 텍스트만 생성 (파일 쓰기는 우리가 한다)
 *  --safe-mode     : CLAUDE.md/훅/플러그인/MCP 비활성 — 인증·모델은 정상 동작(API 키 불필요)
 */
export function runClaude(prompt: string, opts: RunOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["-p", "--output-format", "text", "--tools", "", "--safe-mode"];
  const model = process.env.CDSTUDIO_CLAUDE_MODEL;
  if (model) args.push("--model", model);

  return new Promise<string>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DesignError("생성이 중단되었습니다"));
      return;
    }

    const child = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedBy: "timeout" | "abort" | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      killedBy = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      killedBy = "abort";
      child.kill("SIGKILL");
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      finish(() =>
        reject(
          new DesignError(
            `claude CLI 실행 실패 (${CLAUDE_BIN}): ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      if (killedBy === "timeout") {
        finish(() =>
          reject(new DesignError(`생성 시간 초과 (${Math.round(timeoutMs / 60000)}분)`)),
        );
        return;
      }
      if (killedBy === "abort") {
        finish(() => reject(new DesignError("생성이 중단되었습니다")));
        return;
      }
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" / ").slice(0, 500);
        finish(() =>
          reject(new DesignError(`claude CLI 오류(종료코드 ${code}): ${tail || "출력 없음"}`)),
        );
        return;
      }
      finish(() => resolve(stdout));
    });

    // stdin 으로 프롬프트 전달
    child.stdin.on("error", () => {
      /* EPIPE 등은 close 처리에서 잡는다 */
    });
    child.stdin.end(prompt, "utf8");
  });
}

// ── 프롬프트 ──────────────────────────────────────────────────

function trackListText(tracks: Track[]): string {
  const sorted = [...tracks].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return "(트랙 없음)";
  return sorted
    .map(
      (t) =>
        `${String(t.order).padStart(2, "0")}. ${t.title}${t.artist ? ` — ${t.artist}` : ""} (${formatDuration(t.durationSec)})`,
    )
    .join("\n");
}

function specText(): string {
  const { front, back, label } = PRINT_SPECS;
  const inner = back.widthMm - back.spineMm * 2;
  return [
    `- 앞커버(front): 정확히 ${front.widthMm}mm × ${front.heightMm}mm 정사각형.`,
    `- 뒷커버(back, 트레이 카드): 정확히 ${back.widthMm}mm × ${back.heightMm}mm.`,
    `  좌우 끝에 각각 폭 ${back.spineMm}mm 의 접히는 스파인(측면)이 있고, 가운데 본문 패널은 ${inner}mm 폭이다.`,
    `  스파인에는 세로쓰기(writing-mode: vertical-rl)로 앨범명과 아티스트명을 넣는다.`,
    `  가운데 패널에는 트랙리스트(번호·제목·재생시간)를 모두 읽기 쉽게 넣는다.`,
    `- CD 라벨(label): 지름 ${label.outerDiameterMm}mm 정원. 중앙에 지름 ${label.innerDiameterMm}mm 의 구멍 영역을 완전히 비운다(흰색 원 + 내용 없음).`,
    `  라벨의 바깥 캔버스는 ${label.outerDiameterMm}mm × ${label.outerDiameterMm}mm 이고, 원 밖은 흰 여백으로 둔다.`,
    `  ★ 중앙 허브(지름 46mm 이내)에는 글자·중요 그래픽을 절대 두지 않는다. 구멍에 가려진다.`,
    `  앨범명·아티스트명은 중앙에서 위/아래로 비켜난 링 영역(중심에서 반지름 25~55mm 사이)에 배치한다.`,
  ].join("\n");
}

const OUTPUT_RULES = `
## 출력 형식 (반드시 그대로 지킬 것)

아래 마커를 각각 독립된 줄에 정확히 그대로 출력하고, 마커 사이에 해당 HTML 문서 전체를 넣는다.
설명·머리말·꼬리말·마크다운 코드펜스(\`\`\`)를 절대 쓰지 말 것.

###NAME###
(이 안의 컨셉 이름 한 줄. 한국어 2~8자 정도, 예: 미드나잇 네온)
###FRONT###
(앞커버 HTML 문서 전체 — <!DOCTYPE html> 로 시작)
###BACK###
(뒷커버 HTML 문서 전체 — <!DOCTYPE html> 로 시작)
###LABEL###
(CD 라벨 HTML 문서 전체 — <!DOCTYPE html> 로 시작)
###END###
`.trim();

function htmlRules(photos: Photo[]): string {
  const lines = [
    "## HTML 요구사항 (3개 파일 공통)",
    "",
    "1. 각 파일은 그 자체로 완결된 HTML 문서다: <!DOCTYPE html> … </html>.",
    "2. 완전 자립형이어야 한다. 외부 리소스 참조 절대 금지 —",
    "   외부 CSS/JS/폰트/이미지 URL, @import, <link href=\"http…\">, <script src=\"http…\"> 모두 금지.",
    "   CSS 는 <style> 안에 인라인으로 넣고, 이미지는 아래 사진 토큰 또는 인라인 SVG/CSS 그라디언트만 사용한다.",
    "3. 자바스크립트를 쓰지 않는다 (정적 인쇄물이다).",
    "4. 폰트는 system-ui, -apple-system, 'Apple SD Gothic Neo', 'Helvetica Neue', sans-serif 등 시스템 폰트 스택만 사용한다.",
    "   (한글이 반드시 깨지지 않게 할 것)",
    "5. 실치수 인쇄 보장:",
    "   - <style> 안에 @page { size: <가로>mm <세로>mm; margin: 0; } 를 넣는다.",
    "   - html, body { margin:0; padding:0; }",
    "   - 루트 요소(예: .canvas)의 width/height 를 mm 단위로 정확히 지정한다. px/%/vw 금지.",
    "   - 내부 치수도 가급적 mm 단위를 쓴다.",
    "   - body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } 로 배경색이 인쇄되게 한다.",
    "   - overflow: hidden 으로 캔버스를 넘치는 요소가 잘리게 한다.",
    "6. 배경이 어두운 디자인이라면 텍스트 대비를 충분히 확보한다. 글자는 절대 잘리거나 겹치지 않게 한다.",
    "7. 앨범명/아티스트명은 반드시 주어진 문자열 그대로 표기한다.",
  ];
  if (photos.length > 0) {
    lines.push(
      "8. 아래 사진 토큰을 이미지 src 로 그대로 쓸 수 있다. 서버가 실제 base64 데이터로 치환한다.",
      ...photos.map(
        (p, i) =>
          `   - ${p.token}  (원본 파일명: ${p.filename}, ${Math.round(p.bytes / 1024)}KB) → <img src="${p.token}" …> 형태로 사용, 사진 ${i + 1}`,
      ),
      "   사진은 object-fit: cover 로 크롭해 배치하고, 위에 텍스트를 얹을 때는 어두운/밝은 오버레이로 가독성을 확보한다.",
      "   토큰은 반드시 위 형태 그대로 써야 한다(임의 변형 금지). 사진을 안 쓰는 면이 있어도 된다.",
    );
  } else {
    lines.push(
      "8. 업로드된 사진이 없다. 이미지 파일 대신 CSS 그라디언트/도형/인라인 SVG/타이포그래피로만 표현한다.",
    );
  }
  return lines.join("\n");
}

interface PromptInput {
  project: AlbumProject;
  index: number;
  photos: Photo[];
  /** refine 시: 기존 HTML + 피드백 */
  refine?: {
    feedback: string;
    current: Partial<Record<ArtworkPart, string>>;
    currentName?: string;
  };
}

export function buildPrompt(input: PromptInput): string {
  const { project, index, photos, refine } = input;
  const concept = project.concept?.trim();

  const head = [
    "너는 음반 아트워크 디자이너다. 개인 소장용 부틀렉 CD 의 인쇄용 아트워크를 HTML/CSS 로 만든다.",
    "아래 앨범 정보를 바탕으로 앞커버·뒷커버·CD라벨 3개의 HTML 문서를 만들어라.",
    "",
    "## 앨범 정보",
    `- 앨범명: ${project.title}`,
    `- 아티스트: ${project.artist}`,
    `- 컨셉 요청: ${concept || "(지정 없음 — 트랙 분위기에 어울리게 자유롭게)"}`,
    `- 트랙 수: ${project.tracks.length}`,
    "",
    "### 트랙리스트",
    trackListText(project.tracks),
    "",
    "## 실치수 규격 (반드시 준수)",
    specText(),
    "",
    htmlRules(photos),
  ].join("\n");

  if (refine) {
    const currentBlocks = ARTWORK_PARTS.filter((p) => refine.current[p])
      .map((p) => {
        const html = refine.current[p] as string;
        const trimmed =
          html.length > MAX_CONTEXT_CHARS
            ? `${html.slice(0, MAX_CONTEXT_CHARS)}\n<!-- …(이하 생략) -->`
            : html;
        return `#### 현재 ${PART_LABEL[p]} HTML\n${trimmed}`;
      })
      .join("\n\n");

    return [
      head,
      "",
      "## 수정 요청",
      `아래는 현재 ${index}안${refine.currentName ? `("${refine.currentName}")` : ""} 의 HTML 이다.`,
      "이 디자인의 방향과 정체성은 유지하면서, 사용자 피드백을 반영해 3개 파일을 다시 만들어라.",
      "",
      `### 사용자 피드백`,
      refine.feedback,
      "",
      "### 현재 HTML",
      currentBlocks || "(기존 HTML 없음 — 새로 만들어라)",
      "",
      OUTPUT_RULES,
    ].join("\n");
  }

  return [
    head,
    "",
    "## 이번 안의 방향",
    `${index}안: ${STYLE_HINTS[index] ?? "자유로운 방향"}`,
    "세 개 면(앞커버·뒷커버·라벨)은 하나의 시리즈로 보이도록 색·활자·그래픽 요소를 공유해야 한다.",
    "",
    OUTPUT_RULES,
  ].join("\n");
}

// ── 출력 파싱 ─────────────────────────────────────────────────

export interface ParsedVariant {
  name: string;
  html: Record<ArtworkPart, string>;
}

function stripFences(block: string): string {
  let s = block.trim();
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, "");
  s = s.replace(/\n?```\s*$/, "");
  return s.trim();
}

/** 마커 기반 파싱. 실패 시 DesignError */
export function parseDesignOutput(raw: string, fallbackName: string): ParsedVariant {
  const text = raw.replace(/\r\n/g, "\n");

  const findMarker = (marker: string): number => {
    const re = new RegExp(`^[ \\t]*${marker}[ \\t]*$`, "m");
    const m = re.exec(text);
    return m ? m.index : -1;
  };
  const markerEnd = (marker: string, start: number): number => {
    const re = new RegExp(`^[ \\t]*${marker}[ \\t]*$`, "m");
    const m = re.exec(text.slice(start));
    return m ? start + m.index + m[0].length : -1;
  };

  const iName = findMarker("###NAME###");
  const iFront = findMarker("###FRONT###");
  const iBack = findMarker("###BACK###");
  const iLabel = findMarker("###LABEL###");
  const iEnd = findMarker("###END###");

  if (iFront < 0 || iBack < 0 || iLabel < 0 || !(iFront < iBack && iBack < iLabel)) {
    throw new DesignError("생성 결과에서 HTML 구분 마커를 찾지 못했습니다");
  }

  const nameStart = iName >= 0 ? markerEnd("###NAME###", iName) : -1;
  const name =
    nameStart >= 0
      ? stripFences(text.slice(nameStart, iFront))
          .split("\n")[0]
          .replace(/^[#*\-\s]+/, "")
          .trim()
          .slice(0, 40)
      : "";

  const frontStart = markerEnd("###FRONT###", iFront);
  const backStart = markerEnd("###BACK###", iBack);
  const labelStart = markerEnd("###LABEL###", iLabel);
  const labelEnd = iEnd > iLabel ? iEnd : text.length;

  const html: Record<ArtworkPart, string> = {
    front: stripFences(text.slice(frontStart, iBack)),
    back: stripFences(text.slice(backStart, iLabel)),
    label: stripFences(text.slice(labelStart, labelEnd)),
  };

  for (const part of ARTWORK_PARTS) {
    const body = html[part];
    if (!body || body.length < 80 || !/<html[\s>]/i.test(body)) {
      throw new DesignError(`${PART_LABEL[part]} HTML 이 올바르지 않습니다`);
    }
  }

  return { name: name || fallbackName, html };
}

// ── 저장 ──────────────────────────────────────────────────────

async function writeVariant(
  projectId: string,
  index: number,
  parsed: ParsedVariant,
  photos: Photo[],
  onStatus?: StatusFn,
): Promise<ArtworkVariant> {
  const dir = artworkDir(projectId);
  await fs.mkdir(dir, { recursive: true });

  for (const part of ARTWORK_PARTS) {
    const html = applyPhotos(parsed.html[part], photos);
    const warnings = externalRefWarnings(html);
    if (warnings.length > 0 && onStatus) {
      onStatus(
        `⚠ ${index}안 ${PART_LABEL[part]}에 외부 리소스 참조가 있습니다(${warnings.join(", ")}) — 오프라인 인쇄 시 누락될 수 있습니다.`,
      );
    }
    const file = path.join(dir, variantFileName(index, part));
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, html, "utf8");
    await fs.rename(tmp, file);
  }

  return { index, name: parsed.name, files: variantFiles(index) };
}

// ── 공개 API ──────────────────────────────────────────────────

export interface GenerateOptions {
  onStatus?: StatusFn;
  onVariant?: (variant: ArtworkVariant) => void | Promise<void>;
  onVariantError?: (index: number, message: string) => void;
  signal?: AbortSignal;
  /** 생성할 안 번호 (기본 [1,2,3]) */
  indexes?: number[];
}

/**
 * 3안 생성. 안 하나가 실패해도 나머지는 계속 진행한다.
 * @returns 성공한 안 목록
 */
export async function generateVariants(
  project: AlbumProject,
  opts: GenerateOptions = {},
): Promise<ArtworkVariant[]> {
  const indexes = opts.indexes ?? [1, 2, 3];
  const photos = await loadPhotos(project.id, opts.onStatus);
  const cwd = artworkDir(project.id);
  await fs.mkdir(cwd, { recursive: true });

  const done: ArtworkVariant[] = [];

  for (const index of indexes) {
    if (opts.signal?.aborted) break;
    opts.onStatus?.(`${index}안 생성 중… (Claude 로컬 CLI 호출, 수 분 걸릴 수 있습니다)`);
    try {
      const prompt = buildPrompt({ project, index, photos });
      const raw = await runClaude(prompt, { cwd, signal: opts.signal });
      const parsed = parseDesignOutput(raw, `${index}안`);
      const variant = await writeVariant(project.id, index, parsed, photos, opts.onStatus);
      done.push(variant);
      opts.onStatus?.(`${index}안 "${variant.name}" 완료`);
      await opts.onVariant?.(variant);
    } catch (err) {
      if (opts.signal?.aborted) break;
      const message = err instanceof Error ? err.message : String(err);
      opts.onVariantError?.(index, message);
      opts.onStatus?.(`${index}안 실패: ${message}`);
    }
  }

  return done;
}

/** 기존 안의 HTML 을 읽어온다 (refine 컨텍스트용) */
async function readVariantHtml(
  projectId: string,
  variant: ArtworkVariant,
  photos: Photo[],
): Promise<Partial<Record<ArtworkPart, string>>> {
  const dir = artworkDir(projectId);
  const out: Partial<Record<ArtworkPart, string>> = {};
  for (const part of ARTWORK_PARTS) {
    const name = variant.files?.[part];
    if (!name) continue;
    try {
      const html = await fs.readFile(path.join(dir, path.basename(name)), "utf8");
      out[part] = stripDataUris(html, photos);
    } catch {
      /* 파일 없음 — 컨텍스트에서 제외 */
    }
  }
  return out;
}

export interface RefineOptions {
  onStatus?: StatusFn;
  signal?: AbortSignal;
}

/** 특정 안만 피드백을 반영해 재생성 (같은 파일명에 덮어쓰기) */
export async function refineVariant(
  project: AlbumProject,
  index: number,
  feedback: string,
  opts: RefineOptions = {},
): Promise<ArtworkVariant> {
  const existing = project.artwork?.variants?.find((v) => v.index === index);
  const photos = await loadPhotos(project.id, opts.onStatus);
  const cwd = artworkDir(project.id);
  await fs.mkdir(cwd, { recursive: true });

  const current = existing ? await readVariantHtml(project.id, existing, photos) : {};

  opts.onStatus?.(`${index}안 수정 중… (Claude 로컬 CLI 호출, 수 분 걸릴 수 있습니다)`);

  const prompt = buildPrompt({
    project,
    index,
    photos,
    refine: {
      feedback,
      current,
      ...(existing?.name ? { currentName: existing.name } : {}),
    },
  });

  const raw = await runClaude(prompt, { cwd, signal: opts.signal });
  const parsed = parseDesignOutput(raw, existing?.name ?? `${index}안`);
  const variant = await writeVariant(project.id, index, parsed, photos, opts.onStatus);
  opts.onStatus?.(`${index}안 "${variant.name}" 수정 완료`);
  return variant;
}

// ── 동시 실행 방지 (1인 로컬 전제의 간단한 인메모리 락) ─────────

const running = new Set<string>();

export function isDesignRunning(projectId: string): boolean {
  return running.has(projectId);
}
export function acquireDesignLock(projectId: string): boolean {
  if (running.has(projectId)) return false;
  running.add(projectId);
  return true;
}
export function releaseDesignLock(projectId: string): void {
  running.delete(projectId);
}
