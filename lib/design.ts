/**
 * design.ts — 로컬 AI CLI 래퍼 (기본 엔진: `codex exec -m gpt-5.6-sol`)
 *
 * 앨범 아트워크 5영역(앞표지/앞표지 내부/CD라벨/뒷표지/뒷표지 내부)을
 * 완전 자립형 인쇄용 HTML 로 만든다.
 *
 * 영역별 제작 방식(`ArtworkState.partModes`)
 *  - ai       : AI CLI 가 해당 영역 HTML 을 생성
 *  - photo    : `partPhotos[part]` 사진을 풀블리드로 깐 HTML 을 서버가 로컬 생성 (AI 호출 없음)
 *  - template : 단색 배경 + 앨범명/아티스트(뒷면은 트랙리스트·스파인) 기본형을 서버가 로컬 생성
 *  - blank    : 파일을 만들지 않는다 (files 에 키 없음)
 *
 * ★ 규칙
 *  - 모든 외부 프로세스 실행은 인자 배열로만 spawn 한다 (셸 문자열 조합 금지).
 *  - 사용자 입력(앨범명/아티스트/컨셉/피드백)은 프롬프트 텍스트로만 들어가고
 *    stdin 을 통해 전달된다 — 셸을 거치지 않는다.
 *  - 생성 결과는 artwork/variant-{n}-{part}.html 로 저장된다 (ArtworkVariant.files 계약).
 */
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import type {
  AlbumProject,
  ArtworkPart,
  ArtworkVariant,
  PartMode,
  Track,
} from "./types";
import {
  ARTWORK_PARTS,
  DEFAULT_PART_MODES,
  PART_LABELS,
  PRINT_SPECS,
  formatDuration,
} from "./types";
import { artworkDir, assetsDir } from "./storage";

// ── 엔진 설정 ─────────────────────────────────────────────────

export type DesignEngine = "codex" | "claude";

/** 기본 엔진은 codex. claude 는 폴백으로 남겨둔다. */
export function currentEngine(): DesignEngine {
  const raw = (process.env.CDSTUDIO_DESIGN_ENGINE ?? "codex").trim().toLowerCase();
  return raw === "claude" ? "claude" : "codex";
}

/** codex CLI 경로 (PATH 의존). 환경변수로 덮어쓸 수 있다. */
export const CODEX_BIN = process.env.CDSTUDIO_CODEX_BIN ?? "codex";
/** codex 모델 */
export const CODEX_MODEL = process.env.CDSTUDIO_CODEX_MODEL ?? "gpt-5.6-sol";
/** claude CLI 경로 (폴백 엔진) */
export const CLAUDE_BIN = process.env.CDSTUDIO_CLAUDE_BIN ?? "/opt/homebrew/bin/claude";

const ENGINE_LABEL: Record<DesignEngine, string> = {
  codex: "codex CLI",
  claude: "Claude CLI",
};

/** 안 1개당 생성 타임아웃 (기본 10분) */
const DEFAULT_TIMEOUT_MS = Number(process.env.CDSTUDIO_DESIGN_TIMEOUT_MS ?? 10 * 60 * 1000);

/** 프롬프트에 첨부할 사진 제한 (ai 모드 참고용) */
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 개당 5MB
const MAX_PHOTO_TOTAL_BYTES = 12 * 1024 * 1024; // 합계 12MB

/** refine/part 재생성 시 기존 HTML 을 컨텍스트로 넣을 때의 문자 수 상한 */
const MAX_CONTEXT_CHARS = 9000;
const MAX_REFERENCE_CHARS = 6000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 영역별 출력 마커 이름 */
const PART_MARKER: Record<ArtworkPart, string> = {
  front: "FRONT",
  "front-inner": "FRONT_INNER",
  label: "LABEL",
  back: "BACK",
  "back-inner": "BACK_INNER",
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

// ── 파일명 / 영역 계약 ────────────────────────────────────────

export function variantFileName(index: number, part: ArtworkPart): string {
  return `variant-${index}-${part}.html`;
}

/** 영역별 제작 방식 (기본값 병합) */
export function resolvePartModes(project: AlbumProject): Record<ArtworkPart, PartMode> {
  const configured = project.artwork?.partModes;
  const modes = { ...DEFAULT_PART_MODES };
  if (configured) {
    for (const part of ARTWORK_PARTS) {
      const mode = configured[part];
      if (mode === "ai" || mode === "photo" || mode === "template" || mode === "blank") {
        modes[part] = mode;
      }
    }
  }
  return modes;
}

/** 인쇄 캔버스 크기 (mm) */
export function pageSizeMm(part: ArtworkPart): { widthMm: number; heightMm: number } {
  if (part === "label") {
    const d = PRINT_SPECS.label.outerDiameterMm;
    return { widthMm: d, heightMm: d };
  }
  const spec = PRINT_SPECS[part];
  return { widthMm: spec.widthMm, heightMm: spec.heightMm };
}

// ── 사진(assets) 로딩 ─────────────────────────────────────────

interface Photo {
  token: string; // 프롬프트에서 쓰는 치환 토큰
  filename: string;
  dataUri: string;
  bytes: number;
}

/**
 * assets/ 의 사진을 base64 data URI 로 읽는다 (ai 프롬프트 참고용).
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

/** photo 모드용: 지정된 assets 파일 1장을 data URI 로 읽는다 */
async function loadPhotoAsset(projectId: string, filename: string): Promise<string> {
  const base = path.basename(filename);
  if (!base || base !== filename || base === "." || base === "..") {
    throw new DesignError("사진 파일명이 올바르지 않습니다");
  }
  const ext = path.extname(base).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new DesignError("지원하지 않는 이미지 형식입니다");
  }
  const file = path.join(assetsDir(projectId), base);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new DesignError(`사진을 찾을 수 없습니다: ${base}`);
  }
  if (!stat.isFile()) throw new DesignError(`사진을 찾을 수 없습니다: ${base}`);
  if (stat.size > MAX_PHOTO_BYTES) {
    throw new DesignError(
      `사진이 너무 큽니다 (최대 ${MAX_PHOTO_BYTES / 1024 / 1024}MB): ${base}`,
    );
  }
  const buf = await fs.readFile(file);
  const mime = MIME_BY_EXT[ext] ?? "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
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

/** 정적 인쇄 HTML에서 실행 코드와 외부 리소스를 거부한다. */
function unsafeHtmlReasons(html: string): string[] {
  const normalized = html.replace(
    /&#(?:x([0-9a-f]+)|([0-9]+));?/gi,
    (_match, hex: string | undefined, decimal: string | undefined) =>
      String.fromCodePoint(Number.parseInt(hex ?? decimal ?? "0", hex ? 16 : 10)),
  ).replace(/&(?:colon|tab|newline);/gi, (entity) => {
    const name = entity.toLowerCase();
    if (name === "&colon;") return ":";
    return name === "&tab;" ? "\t" : "\n";
  });
  const reasons: string[] = [];
  if (/<script(?:\s|>)/i.test(normalized)) reasons.push("<script>");
  if (/\son[a-z][\w:-]*\s*=/i.test(normalized)) reasons.push("인라인 이벤트 핸들러");
  if (/javascript[\s\u0000-\u001f]*:/i.test(normalized)) reasons.push("javascript: URL");
  if (/<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.test(normalized)) {
    reasons.push("외부 스타일시트(<link>)");
  }
  if (/<(?:img|iframe|embed|source|video|audio|object)\b[^>]*\b(?:src|data)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(normalized)) {
    reasons.push("외부 미디어");
  }
  if (/@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//i.test(normalized)) {
    reasons.push("@import 외부 CSS");
  }
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(normalized)) reasons.push("외부 CSS URL");
  return [...new Set(reasons)];
}

// ── CLI 실행 ──────────────────────────────────────────────────

interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 인자 배열 spawn + stdin 프롬프트 전달. stdout 전체를 문자열로 반환. */
function spawnText(
  bin: string,
  args: string[],
  prompt: string,
  opts: RunOptions,
  label: string,
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DesignError("생성이 중단되었습니다"));
      return;
    }

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedBy: "timeout" | "abort" | "stdout-limit" | null = null;
    let stdoutBytes = 0;

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
      if (killedBy) return;
      killedBy = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      if (killedBy) return;
      killedBy = "abort";
      child.kill("SIGKILL");
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!killedBy) {
          killedBy = "stdout-limit";
          child.kill("SIGKILL");
        }
        return;
      }
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      // 오류 보고용이므로 마지막 64KB만 유지 (무제한 누적 방지)
      stderr = (stderr + d.toString()).slice(-MAX_STDERR_BYTES);
    });

    child.on("error", (err) => {
      finish(() =>
        reject(
          new DesignError(
            `${label} 실행 실패 (${bin}): ${err instanceof Error ? err.message : String(err)}`,
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
      if (killedBy === "stdout-limit") {
        finish(() =>
          reject(new DesignError(`${label} 출력이 허용 크기(10MB)를 초과했습니다`)),
        );
        return;
      }
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" / ").slice(0, 500);
        finish(() =>
          reject(new DesignError(`${label} 오류(종료코드 ${code}): ${tail || "출력 없음"}`)),
        );
        return;
      }
      finish(() => resolve(stdout));
    });

    // stdin 으로 프롬프트 전달 (셸 미경유·길이 제한 회피)
    child.stdin.on("error", () => {
      /* EPIPE 등은 close 처리에서 잡는다 */
    });
    child.stdin.end(prompt, "utf8");
  });
}

/**
 * `codex exec` 헤드리스 호출.
 *  -m <model>              : 모델 지정
 *  --sandbox read-only     : 모델이 실행하는 셸이 파일을 쓰지 못하게 한다 (파일 쓰기는 우리가 한다)
 *  --skip-git-repo-check   : cwd(아트워크 폴더)가 git 저장소가 아니어도 실행
 *  --ephemeral             : 세션 파일을 디스크에 남기지 않음
 *  --color never           : ANSI 이스케이프로 출력 오염 방지
 *  -o <file>               : 최종 응답만 파일로 받아 로그 오염 없이 파싱
 *  -                       : 프롬프트를 stdin 으로 읽는다
 */
export async function runCodex(prompt: string, opts: RunOptions): Promise<string> {
  const outFile = path.join(os.tmpdir(), `cdstudio-design-${randomUUID()}.txt`);
  const args = [
    "exec",
    "-m",
    CODEX_MODEL,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "-C",
    opts.cwd,
    "-o",
    outFile,
    "-",
  ];
  try {
    const stdout = await spawnText(CODEX_BIN, args, prompt, opts, "codex CLI");
    let last = "";
    try {
      last = await fs.readFile(outFile, "utf8");
    } catch {
      /* --output-last-message 실패 시 stdout 폴백 */
    }
    return last.trim() ? last : stdout;
  } finally {
    await fs.rm(outFile, { force: true }).catch(() => {});
  }
}

/**
 * `claude -p` 헤드리스 호출 (폴백 엔진).
 *  --tools ""      : 도구 사용 없이 텍스트만 생성
 *  --safe-mode     : CLAUDE.md/훅/플러그인/MCP 비활성
 */
export function runClaude(prompt: string, opts: RunOptions): Promise<string> {
  const args = ["-p", "--output-format", "text", "--tools", "", "--safe-mode"];
  const model = process.env.CDSTUDIO_CLAUDE_MODEL;
  if (model) args.push("--model", model);
  return spawnText(CLAUDE_BIN, args, prompt, opts, "claude CLI");
}

/** 현재 엔진으로 프롬프트를 실행한다 */
export function runEngine(prompt: string, opts: RunOptions): Promise<string> {
  return currentEngine() === "claude" ? runClaude(prompt, opts) : runCodex(prompt, opts);
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

/** 영역별 실치수·구성 규격 */
function partSpecText(part: ArtworkPart): string {
  const { front, back, label } = PRINT_SPECS;
  const innerPanel = back.widthMm - back.spineMm * 2;
  switch (part) {
    case "front":
      return [
        `- 앞표지(front): 정확히 ${front.widthMm}mm × ${front.heightMm}mm 정사각형.`,
        `  앨범명과 아티스트명이 가장 눈에 띄어야 한다. 이 안의 얼굴이다.`,
      ].join("\n");
    case "front-inner":
      return [
        `- 앞표지 내부(front-inner): 정확히 ${PRINT_SPECS["front-inner"].widthMm}mm × ${PRINT_SPECS["front-inner"].heightMm}mm 정사각형.`,
        `  북릿을 펼쳤을 때 보이는 안쪽면. 앞표지와 같은 시리즈 톤을 유지하되,`,
        `  짧은 라이너 노트풍 문구·트랙리스트·그래픽 중 하나로 담백하게 채운다.`,
        `  가장자리 5mm 는 재단 여유이므로 중요한 글자를 두지 않는다.`,
      ].join("\n");
    case "label":
      return [
        `- CD 라벨(label): 지름 ${label.outerDiameterMm}mm 정원. 바깥 캔버스는 ${label.outerDiameterMm}mm × ${label.outerDiameterMm}mm 이고 원 밖은 흰 여백으로 둔다.`,
        `  중앙에 지름 ${label.innerDiameterMm}mm 의 구멍 영역을 완전히 비운다(흰색 원 + 내용 없음).`,
        `  ★ 중앙 허브(지름 46mm 이내)에는 글자·중요 그래픽을 절대 두지 않는다. 구멍/클램프에 가려진다.`,
        `  앨범명·아티스트명은 중앙에서 위/아래로 비켜난 링 영역(중심에서 반지름 25~55mm 사이)에 배치한다.`,
      ].join("\n");
    case "back":
      return [
        `- 뒷표지(back, 트레이 카드 겉면): 정확히 ${back.widthMm}mm × ${back.heightMm}mm.`,
        `  좌우 끝에 각각 폭 ${back.spineMm}mm 의 접히는 스파인(측면)이 있고, 가운데 본문 패널은 ${innerPanel}mm 폭이다.`,
        `  스파인에는 세로쓰기(writing-mode: vertical-rl)로 앨범명과 아티스트명을 넣는다.`,
        `  가운데 패널에는 트랙리스트(번호·제목·재생시간)를 빠짐없이, 읽기 쉽게 넣는다.`,
      ].join("\n");
    case "back-inner":
      return [
        `- 뒷표지 내부(back-inner, 트레이 카드 안쪽면): 정확히 ${PRINT_SPECS["back-inner"].widthMm}mm × ${PRINT_SPECS["back-inner"].heightMm}mm.`,
        `  트레이 밑에 깔려 비쳐 보이는 면. 좌우 ${PRINT_SPECS["back-inner"].spineMm}mm 는 접히는 스파인이므로 중요한 요소를 두지 않는다.`,
        `  이미지·패턴·큰 타이포 중심으로 시원하게 채운다. 작은 글자는 피한다.`,
      ].join("\n");
  }
}

function htmlRules(photos: Photo[], partCount: number): string {
  const lines = [
    `## HTML 요구사항 (${partCount}개 파일 공통)`,
    "",
    "1. 각 파일은 그 자체로 완결된 HTML 문서다: <!DOCTYPE html> … </html>.",
    "2. 완전 자립형이어야 한다. 외부 리소스 참조 절대 금지 —",
    "   외부 CSS/JS/폰트/이미지 URL, @import, <link href=\"http…\">, <script src=\"http…\"> 모두 금지.",
    "   CSS 는 <style> 안에 인라인으로 넣고, 이미지는 아래 사진 토큰 또는 인라인 SVG/CSS 그라디언트만 사용한다.",
    "3. 자바스크립트를 쓰지 않는다 (정적 인쇄물이다). on* 인라인 이벤트 속성도 금지.",
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

/** 요청한 영역만 마커로 받는 출력 형식 규칙 */
function outputRules(parts: ArtworkPart[], withName: boolean): string {
  const lines = [
    "## 출력 형식 (반드시 그대로 지킬 것)",
    "",
    "아래 마커를 각각 독립된 줄에 정확히 그대로 출력하고, 마커 사이에 해당 HTML 문서 전체를 넣는다.",
    "설명·머리말·꼬리말·요약·마크다운 코드펜스(```)를 절대 쓰지 말 것.",
    "파일을 직접 만들거나 셸 명령을 실행하지 말 것 — 결과는 오직 아래 텍스트 형식으로만 답한다.",
    "",
  ];
  if (withName) {
    lines.push("###NAME###", "(이 안의 컨셉 이름 한 줄. 한국어 2~8자 정도, 예: 미드나잇 네온)");
  }
  for (const part of parts) {
    lines.push(`###${PART_MARKER[part]}###`, `(${PART_LABELS[part]} HTML 문서 전체 — <!DOCTYPE html> 로 시작)`);
  }
  lines.push("###END###");
  return lines.join("\n");
}

interface PromptInput {
  project: AlbumProject;
  index: number;
  parts: ArtworkPart[];
  photos: Photo[];
  /** 이름 마커까지 받을지 (영역 단독 재생성 시 false) */
  withName?: boolean;
  /** refine 시: 기존 HTML + 피드백 */
  refine?: {
    feedback: string;
    current: Partial<Record<ArtworkPart, string>>;
    currentName?: string;
  };
  /** 영역 단독 재생성 시: 같은 안의 다른 면(톤 참고) */
  reference?: {
    variantName?: string;
    part: ArtworkPart;
    html: string;
  };
}

export function buildPrompt(input: PromptInput): string {
  const { project, index, parts, photos, refine, reference } = input;
  const withName = input.withName ?? true;
  const concept = project.concept?.trim();
  const partNames = parts.map((p) => PART_LABELS[p]).join(" · ");

  const head = [
    "너는 음반 아트워크 디자이너다. 개인 소장용 부틀렉 CD 의 인쇄용 아트워크를 HTML/CSS 로 만든다.",
    `아래 앨범 정보를 바탕으로 ${partNames} ${parts.length}개의 HTML 문서를 만들어라.`,
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
    parts.map(partSpecText).join("\n"),
    "",
    htmlRules(photos, parts.length),
  ].join("\n");

  if (refine) {
    const currentBlocks = parts
      .filter((p) => refine.current[p])
      .map((p) => {
        const html = refine.current[p] as string;
        const trimmed =
          html.length > MAX_CONTEXT_CHARS
            ? `${html.slice(0, MAX_CONTEXT_CHARS)}\n<!-- …(이하 생략) -->`
            : html;
        return `#### 현재 ${PART_LABELS[p]} HTML\n${trimmed}`;
      })
      .join("\n\n");

    return [
      head,
      "",
      "## 수정 요청",
      `아래는 현재 ${index}안${refine.currentName ? `("${refine.currentName}")` : ""} 의 HTML 이다.`,
      "이 디자인의 방향과 정체성은 유지하면서, 사용자 피드백을 반영해 다시 만들어라.",
      "",
      "### 사용자 피드백",
      refine.feedback,
      "",
      "### 현재 HTML",
      currentBlocks || "(기존 HTML 없음 — 새로 만들어라)",
      "",
      outputRules(parts, withName),
    ].join("\n");
  }

  const tail: string[] = [head, ""];

  if (reference) {
    const trimmed =
      reference.html.length > MAX_REFERENCE_CHARS
        ? `${reference.html.slice(0, MAX_REFERENCE_CHARS)}\n<!-- …(이하 생략) -->`
        : reference.html;
    tail.push(
      "## 시리즈 톤 참고",
      `같은 안${reference.variantName ? `("${reference.variantName}")` : ""}의 ${PART_LABELS[reference.part]} HTML 이다.`,
      "색·활자·그래픽 요소를 이어받아 같은 시리즈로 보이게 만들되, 그대로 베끼지는 말 것.",
      "",
      trimmed,
      "",
    );
  } else {
    tail.push(
      "## 이번 안의 방향",
      `${index}안: ${STYLE_HINTS[index] ?? "자유로운 방향"}`,
      "",
    );
  }

  if (parts.length > 1) {
    tail.push(
      "각 면은 하나의 시리즈로 보이도록 색·활자·그래픽 요소를 공유해야 한다.",
      "",
    );
  }

  tail.push(outputRules(parts, withName));
  return tail.join("\n");
}

// ── 출력 파싱 ─────────────────────────────────────────────────

export interface ParsedVariant {
  name: string;
  html: Partial<Record<ArtworkPart, string>>;
}

function stripFences(block: string): string {
  let s = block.trim();
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, "");
  s = s.replace(/\n?```\s*$/, "");
  return s.trim();
}

/** 마커 기반 파싱 (마커 순서 무관). 실패 시 DesignError */
export function parseDesignOutput(
  raw: string,
  parts: ArtworkPart[],
  fallbackName: string,
): ParsedVariant {
  const text = raw.replace(/\r\n/g, "\n");

  const found: { key: string; contentStart: number; markerStart: number }[] = [];
  const locate = (key: string, marker: string) => {
    const re = new RegExp(`^[ \\t]*###${marker}###[ \\t]*$`, "m");
    const m = re.exec(text);
    if (m) found.push({ key, markerStart: m.index, contentStart: m.index + m[0].length });
  };

  locate("__name__", "NAME");
  for (const part of parts) locate(part, PART_MARKER[part]);
  locate("__end__", "END");
  found.sort((a, b) => a.markerStart - b.markerStart);

  const sliceFor = (key: string): string | null => {
    const i = found.findIndex((f) => f.key === key);
    if (i < 0) return null;
    const next = found[i + 1];
    return text.slice(found[i].contentStart, next ? next.markerStart : text.length);
  };

  const rawName = sliceFor("__name__");
  const name = rawName
    ? stripFences(rawName)
        .split("\n")[0]
        .replace(/^[#*\-\s]+/, "")
        .trim()
        .slice(0, 40)
    : "";

  const html: Partial<Record<ArtworkPart, string>> = {};
  const missing: ArtworkPart[] = [];
  for (const part of parts) {
    const block = sliceFor(part);
    if (block === null) {
      missing.push(part);
      continue;
    }
    html[part] = stripFences(block);
  }

  if (missing.length > 0) {
    throw new DesignError(
      `생성 결과에서 ${missing.map((p) => PART_LABELS[p]).join(", ")} 구분 마커를 찾지 못했습니다`,
    );
  }

  for (const part of parts) {
    const body = html[part];
    if (!body || body.length < 80 || !/<html[\s>]/i.test(body)) {
      throw new DesignError(`${PART_LABELS[part]} HTML 이 올바르지 않습니다`);
    }
  }

  return { name: name || fallbackName, html };
}

// ── 로컬 생성 (photo / template) ──────────────────────────────

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FONT_STACK =
  "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Helvetica Neue', Arial, sans-serif";

function docShell(part: ArtworkPart, title: string, css: string, body: string): string {
  const { widthMm, heightMm } = pageSizeMm(part);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
html, body { margin: 0; padding: 0; }
body {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  background: #ffffff;
  font-family: ${FONT_STACK};
}
.canvas {
  width: ${widthMm}mm;
  height: ${heightMm}mm;
  box-sizing: border-box;
  overflow: hidden;
  position: relative;
}
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** photo 모드: 사진 풀블리드 */
function photoHtml(project: AlbumProject, part: ArtworkPart, dataUri: string): string {
  const title = `${project.title} — ${PART_LABELS[part]}`;
  const alt = esc(project.title);

  if (part === "label") {
    const { outerDiameterMm, innerDiameterMm } = PRINT_SPECS.label;
    const half = innerDiameterMm / 2;
    const css = `
.canvas { background: #ffffff; }
.disc {
  position: absolute; inset: 0;
  width: ${outerDiameterMm}mm; height: ${outerDiameterMm}mm;
  border-radius: 50%; overflow: hidden; background: #000000;
}
.disc img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hole {
  position: absolute; left: 50%; top: 50%;
  width: ${innerDiameterMm}mm; height: ${innerDiameterMm}mm;
  margin: -${half}mm 0 0 -${half}mm;
  border-radius: 50%; background: #ffffff;
}`;
    const body = `<div class="canvas">
  <div class="disc"><img src="${dataUri}" alt="${alt}"></div>
  <div class="hole"></div>
</div>`;
    return docShell(part, title, css, body);
  }

  const css = `
.canvas { background: #000000; }
.canvas img { width: 100%; height: 100%; object-fit: cover; display: block; }`;
  const body = `<div class="canvas"><img src="${dataUri}" alt="${alt}"></div>`;
  return docShell(part, title, css, body);
}

function trackRows(tracks: Track[]): string {
  const sorted = [...tracks].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return `<li class="empty">트랙 없음</li>`;
  return sorted
    .map(
      (t) =>
        `<li><span class="no">${String(t.order).padStart(2, "0")}</span>` +
        `<span class="ti">${esc(t.title)}</span>` +
        `<span class="du">${formatDuration(t.durationSec)}</span></li>`,
    )
    .join("\n    ");
}

/** template 모드: 단색 배경 기본형 */
function templateHtml(project: AlbumProject, part: ArtworkPart): string {
  const title = `${project.title} — ${PART_LABELS[part]}`;
  const albumName = esc(project.title);
  const artistName = esc(project.artist);
  const bg = part === "back-inner" ? "#16171a" : "#111214";

  if (part === "front" || part === "front-inner") {
    const isCover = part === "front";
    const css = `
.canvas {
  background: ${bg};
  color: #f4f4f2;
  padding: 14mm;
  display: flex;
  flex-direction: column;
  justify-content: ${isCover ? "flex-end" : "center"};
  gap: 4mm;
}
.rule { width: 26mm; height: 0.6mm; background: #c9a227; }
h1 { margin: 0; font-size: ${isCover ? "11mm" : "8mm"}; line-height: 1.1; letter-spacing: -0.02em; font-weight: 700; word-break: keep-all; overflow-wrap: anywhere; }
p.artist { margin: 0; font-size: ${isCover ? "5mm" : "4.2mm"}; letter-spacing: 0.08em; color: #b9b8b3; }
p.meta { margin: 0; font-size: 3.2mm; letter-spacing: 0.14em; color: #7d7c78; text-transform: uppercase; }`;
    const body = `<div class="canvas">
  <div class="rule"></div>
  <h1>${albumName}</h1>
  <p class="artist">${artistName}</p>
  <p class="meta">${project.tracks.length} tracks</p>
</div>`;
    return docShell(part, title, css, body);
  }

  if (part === "label") {
    const { outerDiameterMm, innerDiameterMm } = PRINT_SPECS.label;
    const half = innerDiameterMm / 2;
    const css = `
.canvas { background: #ffffff; }
.disc {
  position: absolute; inset: 0;
  width: ${outerDiameterMm}mm; height: ${outerDiameterMm}mm;
  border-radius: 50%; overflow: hidden;
  background: ${bg};
  color: #f4f4f2;
  display: flex; flex-direction: column; align-items: center; justify-content: space-between;
  padding: 12mm 16mm; box-sizing: border-box; text-align: center;
}
.top, .bottom { width: 100%; }
.top { padding-top: 2mm; }
.bottom { padding-bottom: 2mm; }
h1 { margin: 0; font-size: 6mm; line-height: 1.15; font-weight: 700; word-break: keep-all; overflow-wrap: anywhere; }
p.artist { margin: 1.5mm 0 0; font-size: 3.6mm; letter-spacing: 0.1em; color: #b9b8b3; }
p.meta { margin: 0; font-size: 3mm; letter-spacing: 0.16em; color: #7d7c78; }
.hole {
  position: absolute; left: 50%; top: 50%;
  width: ${innerDiameterMm}mm; height: ${innerDiameterMm}mm;
  margin: -${half}mm 0 0 -${half}mm;
  border-radius: 50%; background: #ffffff;
}`;
    const body = `<div class="canvas">
  <div class="disc">
    <div class="top">
      <h1>${albumName}</h1>
      <p class="artist">${artistName}</p>
    </div>
    <div class="bottom">
      <p class="meta">${project.tracks.length} TRACKS</p>
    </div>
  </div>
  <div class="hole"></div>
</div>`;
    return docShell(part, title, css, body);
  }

  // back / back-inner — 스파인 + 트랙리스트
  const spec = PRINT_SPECS[part];
  const panelWidth = spec.widthMm - spec.spineMm * 2;
  const manyTracks = project.tracks.length > 12;
  const css = `
.canvas { background: ${bg}; color: #f4f4f2; display: flex; }
.spine {
  width: ${spec.spineMm}mm; height: ${spec.heightMm}mm;
  flex: 0 0 ${spec.spineMm}mm;
  background: rgba(255,255,255,0.06);
  writing-mode: vertical-rl;
  display: flex; align-items: center; justify-content: center;
  font-size: 2.6mm; letter-spacing: 0.06em; color: #d6d5d0;
  overflow: hidden; white-space: nowrap;
}
.spine.left { transform: rotate(180deg); }
.panel {
  width: ${panelWidth}mm; height: ${spec.heightMm}mm;
  flex: 0 0 ${panelWidth}mm;
  box-sizing: border-box; padding: 9mm 10mm; overflow: hidden;
}
h1 { margin: 0; font-size: 6.5mm; line-height: 1.1; font-weight: 700; word-break: keep-all; overflow-wrap: anywhere; }
p.artist { margin: 1.5mm 0 5mm; font-size: 3.6mm; letter-spacing: 0.08em; color: #b9b8b3; }
ol.tracks {
  margin: 0; padding: 0; list-style: none;
  font-size: 3.1mm; line-height: 1.75;
  ${manyTracks ? "column-count: 2; column-gap: 8mm;" : ""}
}
ol.tracks li { display: flex; gap: 2.5mm; break-inside: avoid; }
ol.tracks .no { color: #8b8a86; font-variant-numeric: tabular-nums; }
ol.tracks .ti { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
ol.tracks .du { color: #8b8a86; font-variant-numeric: tabular-nums; }
ol.tracks .empty { color: #8b8a86; }`;
  const spineText = `${albumName} · ${artistName}`;
  const body = `<div class="canvas">
  <div class="spine left">${spineText}</div>
  <div class="panel">
    <h1>${albumName}</h1>
    <p class="artist">${artistName}</p>
    <ol class="tracks">
    ${trackRows(project.tracks)}
    </ol>
  </div>
  <div class="spine right">${spineText}</div>
</div>`;
  return docShell(part, title, css, body);
}

/** photo/template 영역의 HTML 을 서버에서 만든다 */
async function buildLocalPartHtml(
  project: AlbumProject,
  part: ArtworkPart,
  mode: Extract<PartMode, "photo" | "template">,
): Promise<string> {
  if (mode === "template") return templateHtml(project, part);

  const filename = project.artwork?.partPhotos?.[part];
  if (!filename) {
    throw new DesignError(
      `${PART_LABELS[part]}: 사진 모드인데 사용할 사진이 지정되지 않았습니다`,
    );
  }
  const dataUri = await loadPhotoAsset(project.id, filename);
  return photoHtml(project, part, dataUri);
}

// ── 저장 / 삭제 ───────────────────────────────────────────────

function artworkFilePath(projectId: string, filename: string): string | null {
  const base = path.basename(filename);
  if (!base || base === "." || base === ".." || base !== filename) return null;
  return path.join(artworkDir(projectId), base);
}

/** artwork/ 안의 파일 1개 삭제 (없으면 무시) */
export async function removeArtworkFile(projectId: string, filename: string): Promise<void> {
  const file = artworkFilePath(projectId, filename);
  if (!file) return;
  await fs.rm(file, { force: true }).catch(() => {});
}

/** 안 하나의 모든 파일 삭제 */
export async function removeVariantFiles(
  projectId: string,
  variant: ArtworkVariant,
): Promise<void> {
  for (const part of ARTWORK_PARTS) {
    const name = variant.files?.[part];
    if (name) await removeArtworkFile(projectId, name);
  }
}

/**
 * AI 가 만든 HTML 을 검사한다. 서버가 만든 photo/template HTML 은
 * 우리가 전량 제어하고 사용자 문자열도 이스케이프하므로 검사 대상이 아니다
 * (앨범명에 우연히 걸리는 오탐으로 저장이 막히는 것을 피한다).
 */
function assertSafeHtml(index: number, part: ArtworkPart, html: string): void {
  const reasons = unsafeHtmlReasons(html);
  if (reasons.length > 0) {
    throw new DesignError(
      `${index}안 ${PART_LABELS[part]} HTML에 허용되지 않는 내용이 있습니다: ${reasons.join(", ")}`,
    );
  }
}

/** 원자적으로 저장, 저장된 파일명 반환 */
async function writePartHtml(
  projectId: string,
  index: number,
  part: ArtworkPart,
  html: string,
): Promise<string> {
  const dir = artworkDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const name = variantFileName(index, part);
  const file = path.join(dir, name);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, html, "utf8");
  await fs.rename(tmp, file);
  return name;
}

/** 기존 안의 HTML 을 읽어온다 (refine/참고 컨텍스트용) */
async function readVariantHtml(
  projectId: string,
  variant: ArtworkVariant,
  photos: Photo[],
  parts: readonly ArtworkPart[] = ARTWORK_PARTS,
): Promise<Partial<Record<ArtworkPart, string>>> {
  const out: Partial<Record<ArtworkPart, string>> = {};
  for (const part of parts) {
    const name = variant.files?.[part];
    if (!name) continue;
    const file = artworkFilePath(projectId, name);
    if (!file) continue;
    try {
      out[part] = stripDataUris(await fs.readFile(file, "utf8"), photos);
    } catch {
      /* 파일 없음 — 컨텍스트에서 제외 */
    }
  }
  return out;
}

// ── 공개 API ──────────────────────────────────────────────────

export interface GenerateOptions {
  onStatus?: StatusFn;
  onVariant?: (variant: ArtworkVariant) => void | Promise<void>;
  onVariantError?: (index: number, message: string) => void;
  onPartError?: (index: number, part: ArtworkPart, message: string) => void;
  signal?: AbortSignal;
  /** 생성할 안 번호 (기본 [1,2,3]) */
  indexes?: number[];
}

interface BuildVariantInput {
  project: AlbumProject;
  index: number;
  modes: Record<ArtworkPart, PartMode>;
  photos: Photo[];
  cwd: string;
  signal?: AbortSignal;
  onStatus?: StatusFn;
  onPartError?: (part: ArtworkPart, message: string) => void;
  fallbackName: string;
  refine?: { feedback: string; existing?: ArtworkVariant };
}

/** 한 안(variant) 전체를 만든다 — ai 영역은 CLI 1회 호출, photo/template 은 로컬 생성 */
async function buildVariant(input: BuildVariantInput): Promise<ArtworkVariant> {
  const { project, index, modes, photos, cwd, signal, onStatus, onPartError } = input;

  const aiParts = ARTWORK_PARTS.filter((p) => modes[p] === "ai");
  const localParts = ARTWORK_PARTS.filter((p) => modes[p] === "photo" || modes[p] === "template");

  if (aiParts.length === 0 && localParts.length === 0) {
    throw new DesignError("모든 영역이 '비움'으로 설정되어 있습니다");
  }

  const htmlByPart: Partial<Record<ArtworkPart, string>> = {};
  let name = input.fallbackName;

  // 1) AI 영역
  if (aiParts.length > 0) {
    const engineLabel = ENGINE_LABEL[currentEngine()];
    onStatus?.(
      input.refine
        ? `${index}안 수정 중… (${engineLabel} 호출, 수 분 걸릴 수 있습니다)`
        : `${index}안 생성 중… (${engineLabel} 호출, 수 분 걸릴 수 있습니다)`,
    );

    const refine = input.refine
      ? {
          feedback: input.refine.feedback,
          current: input.refine.existing
            ? await readVariantHtml(project.id, input.refine.existing, photos, aiParts)
            : {},
          ...(input.refine.existing?.name ? { currentName: input.refine.existing.name } : {}),
        }
      : undefined;

    const prompt = buildPrompt({
      project,
      index,
      parts: [...aiParts],
      photos,
      ...(refine ? { refine } : {}),
    });
    const raw = await runEngine(prompt, { cwd, signal });
    const parsed = parseDesignOutput(raw, [...aiParts], input.fallbackName);
    name = parsed.name;
    for (const part of aiParts) {
      const html = parsed.html[part];
      if (!html) continue;
      const withPhotos = applyPhotos(html, photos);
      // AI 출력은 저장 전에 전량 검사한다 (일부만 쓰인 상태가 남지 않도록 쓰기보다 먼저)
      assertSafeHtml(index, part, withPhotos);
      htmlByPart[part] = withPhotos;
    }
  }

  // 2) photo / template 영역 (로컬 생성)
  for (const part of localParts) {
    if (signal?.aborted) throw new DesignError("생성이 중단되었습니다");
    const mode = modes[part] as "photo" | "template";
    try {
      htmlByPart[part] = await buildLocalPartHtml(project, part, mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onPartError?.(part, message);
      onStatus?.(`${index}안 ${PART_LABELS[part]} 건너뜀: ${message}`);
    }
  }

  const producedParts = ARTWORK_PARTS.filter((p) => htmlByPart[p]);
  if (producedParts.length === 0) {
    throw new DesignError(`${index}안에서 만들어진 영역이 없습니다`);
  }

  // 3) 저장
  const files: Partial<Record<ArtworkPart, string>> = {};
  for (const part of producedParts) {
    files[part] = await writePartHtml(project.id, index, part, htmlByPart[part] as string);
  }

  // blank 로 바뀐(또는 실패한) 영역의 이전 파일은 정리한다
  for (const part of ARTWORK_PARTS) {
    if (!files[part]) await removeArtworkFile(project.id, variantFileName(index, part));
  }

  return { index, name: name || input.fallbackName, files };
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
  const modes = resolvePartModes(project);
  const needsPhotos = ARTWORK_PARTS.some((p) => modes[p] === "ai");
  const photos = needsPhotos ? await loadPhotos(project.id, opts.onStatus) : [];
  const cwd = artworkDir(project.id);
  await fs.mkdir(cwd, { recursive: true });

  const done: ArtworkVariant[] = [];

  for (const index of indexes) {
    if (opts.signal?.aborted) break;
    try {
      const variant = await buildVariant({
        project,
        index,
        modes,
        photos,
        cwd,
        fallbackName: `${index}안`,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
        onPartError: (part, message) => opts.onPartError?.(index, part, message),
      });
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

export interface RefineOptions {
  onStatus?: StatusFn;
  onPartError?: (part: ArtworkPart, message: string) => void;
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
  const modes = resolvePartModes(project);
  const needsPhotos = ARTWORK_PARTS.some((p) => modes[p] === "ai");
  const photos = needsPhotos ? await loadPhotos(project.id, opts.onStatus) : [];
  const cwd = artworkDir(project.id);
  await fs.mkdir(cwd, { recursive: true });

  if (!ARTWORK_PARTS.some((p) => modes[p] === "ai")) {
    opts.onStatus?.(
      "AI 영역이 없어 피드백을 반영할 수 없습니다 — 사진/기본형 영역만 다시 만듭니다.",
    );
  }

  const variant = await buildVariant({
    project,
    index,
    modes,
    photos,
    cwd,
    fallbackName: existing?.name ?? `${index}안`,
    refine: { feedback, ...(existing ? { existing } : {}) },
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    ...(opts.onPartError ? { onPartError: opts.onPartError } : {}),
  });
  opts.onStatus?.(`${index}안 "${variant.name}" 수정 완료`);
  return variant;
}

export interface RegeneratePartOptions {
  onStatus?: StatusFn;
  signal?: AbortSignal;
}

/**
 * 한 안의 한 영역만 다시 만든다 (그 영역의 partMode 규칙 적용).
 * @returns 갱신된 variant 전체 (files 병합)
 */
export async function regeneratePart(
  project: AlbumProject,
  index: number,
  part: ArtworkPart,
  opts: RegeneratePartOptions = {},
): Promise<ArtworkVariant> {
  const existing = project.artwork?.variants?.find((v) => v.index === index);
  const modes = resolvePartModes(project);
  const mode = modes[part];
  const cwd = artworkDir(project.id);
  await fs.mkdir(cwd, { recursive: true });

  const files: Partial<Record<ArtworkPart, string>> = { ...(existing?.files ?? {}) };
  let name = existing?.name ?? `${index}안`;

  if (mode === "blank") {
    await removeArtworkFile(project.id, files[part] ?? variantFileName(index, part));
    delete files[part];
    opts.onStatus?.(`${PART_LABELS[part]}을(를) 비웠습니다.`);
    return { index, name, files };
  }

  let html: string;
  if (mode === "ai") {
    const photos = await loadPhotos(project.id, opts.onStatus);
    opts.onStatus?.(
      `${index}안 ${PART_LABELS[part]} 생성 중… (${ENGINE_LABEL[currentEngine()]} 호출, 수 분 걸릴 수 있습니다)`,
    );

    // 같은 안의 다른 면을 톤 참고로 넣는다 (있으면)
    let reference: { variantName?: string; part: ArtworkPart; html: string } | undefined;
    if (existing) {
      const siblings = ARTWORK_PARTS.filter((p) => p !== part && existing.files?.[p]);
      const refPart = siblings.find((p) => p === "front") ?? siblings[0];
      if (refPart) {
        const read = await readVariantHtml(project.id, existing, photos, [refPart]);
        const refHtml = read[refPart];
        if (refHtml) {
          reference = {
            part: refPart,
            html: refHtml,
            ...(existing.name ? { variantName: existing.name } : {}),
          };
        }
      }
    }

    const prompt = buildPrompt({
      project,
      index,
      parts: [part],
      photos,
      withName: !existing,
      ...(reference ? { reference } : {}),
    });
    const raw = await runEngine(prompt, { cwd, ...(opts.signal ? { signal: opts.signal } : {}) });
    const parsed = parseDesignOutput(raw, [part], name);
    if (!existing) name = parsed.name;
    html = applyPhotos(parsed.html[part] as string, photos);
    assertSafeHtml(index, part, html);
  } else {
    opts.onStatus?.(
      mode === "photo"
        ? `${PART_LABELS[part]}에 업로드 사진을 채웁니다…`
        : `${PART_LABELS[part]} 기본형을 만듭니다…`,
    );
    html = await buildLocalPartHtml(project, part, mode);
  }

  files[part] = await writePartHtml(project.id, index, part, html);
  opts.onStatus?.(`${index}안 ${PART_LABELS[part]} 완료`);
  return { index, name, files };
}
