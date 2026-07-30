import { spawn } from "child_process";
import { once } from "events";
import { createWriteStream, promises as fs } from "fs";
import path from "path";
import type { AlbumProject, BurnEvent, BurnSettings, DriveStatus, Track } from "./types";
import { MAX_AUDIO_MINUTES, formatDuration } from "./types";
import { safeFilename } from "./storage";

const DRUTIL = "/usr/bin/drutil";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";

/** 전역 굽기 락 키 (드라이브는 1대뿐이므로 프로젝트 무관 전역) */
export const BURN_LOCK_KEY = "burn:drive";

/** CD 섹터(프레임) 크기 — 오디오 CD는 1프레임 = 2352바이트 */
export const CD_FRAME_BYTES = 2352;
/** 1초 = 75프레임 (Red Book) */
export const CD_FRAMES_PER_SEC = 75;
/** Red Book 최대 트랙 수 */
const CD_MAX_TRACKS = 99;
/** 기본 트랙 간 프리갭 (초) — BurnSettings.pregapSec 미지정 시 */
export const DEFAULT_PREGAP_SEC = 2;

const BIN_NAME = "audio.bin";
const CUE_NAME = "audio.cue";

export type BurnMode = "cue" | "folder";

/**
 * 굽기 방식.
 *
 * ⚠️ `drutil burn -audio <폴더>`는 man 문서의 "alphabetical order"와 달리
 *    실제로는 파일시스템(APFS) readdir 순서 = 파일명 해시 순서로 굽는다.
 *    (실측: 10트랙이 [1,7,6,5,8,4,3,9,2,10] 순으로 구워졌고 `ls -f` 순서와 일치)
 *    파일명 prefix로는 통제할 수 없어 CUE/BIN 이미지로 순서를 명시한다.
 *    폴더 방식은 CDSTUDIO_BURN_MODE=folder 로만 사용한다 (순서 보장 없음).
 */
export function burnMode(): BurnMode {
  return process.env.CDSTUDIO_BURN_MODE === "folder" ? "folder" : "cue";
}

/** BurnSettings.pregapSec → 실제 적용 초 (미지정 시 기본 2초) */
export function effectivePregapSec(settings?: BurnSettings): number {
  const value = settings?.pregapSec;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return DEFAULT_PREGAP_SEC;
  }
  return value;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

function field(raw: string, label: string): string | undefined {
  const match = raw.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im"));
  return match?.[1];
}

function positiveValue(value: string | undefined): boolean {
  return !!value && /^(yes|true|supported|writable|blank)$/i.test(value.trim());
}

export async function getDriveStatus(): Promise<DriveStatus> {
  try {
    const result = await run(DRUTIL, ["status"]);
    const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const type = field(raw, "Type");
    // 드라이브가 있어도 drutil이 0이 아닌 코드로 끝나는 경우가 있어,
    // Type 필드가 파싱되면 출력을 신뢰한다.
    if (!raw || /no (optical )?drive|no device found/i.test(raw) || (result.code !== 0 && !type)) {
      return { connected: false, mediaPresent: false, blank: false, erasable: false, raw };
    }

    const mediaPresent =
      !!type &&
      !/no media|none|unknown/i.test(type) &&
      !/no media|please insert|tray open/i.test(raw);
    // 실제 출력 형식: "Writability: appendable, blank, overwritable"
    const writability = field(raw, "Writability") ?? "";
    const blankValue = field(raw, "Blank");
    const erasableValue = field(raw, "Erasable");
    const spaceFree = field(raw, "Space Free");
    const minuteMatch = spaceFree?.match(/(\d+(?:\.\d+)?)\s*(?:min|minute)/i);
    const msfMatch = spaceFree?.match(/(\d+):(\d+)(?::(\d+))?/);
    const writableMinutes = minuteMatch
      ? Number(minuteMatch[1])
      : msfMatch
        ? Number(msfMatch[1]) + Number(msfMatch[2]) / 60 + Number(msfMatch[3] ?? 0) / 4500
        : undefined;

    // "Vendor   Product   Rev" 헤더 다음 줄에서 벤더/제품명 추출 (없으면 undefined)
    let vendor = field(raw, "Vendor");
    let product = field(raw, "Product");
    if (!vendor) {
      const lines = raw.split("\n");
      const header = lines.findIndex((l) => /^\s*Vendor\s+Product\s+Rev\s*$/i.test(l));
      const value = header >= 0 ? lines[header + 1]?.trim() : undefined;
      if (value) {
        const parts = value.split(/\s+/);
        if (parts.length >= 2) {
          vendor = parts[0];
          product = parts.slice(1, -1).join(" ") || parts[1];
        }
      }
    }

    return {
      connected: true,
      vendor,
      product,
      mediaPresent,
      blank:
        mediaPresent &&
        (/\bblank\b/i.test(writability) ||
          positiveValue(blankValue) ||
          /\bblank\b/i.test(type ?? "")),
      erasable:
        mediaPresent &&
        (/\berasable\b/i.test(writability) ||
          positiveValue(erasableValue) ||
          /CD-RW/i.test(type ?? "")),
      writableMinutes,
      raw,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { connected: false, mediaPresent: false, blank: false, erasable: false, raw };
  }
}

interface ProbeStream {
  sample_rate?: string;
  channels?: number;
  sample_fmt?: string;
}

// ── 굽기 스테이징 ─────────────────────────────────────────────
// tracks/ 를 그대로 굽지 않는다. project.json에서 삭제·재정렬된 내용이 반영되지
// 않아 삭제한 곡이 실물 CD에 들어가기 때문. 또한 폴더 굽기는 순서 자체가
// 비결정적이므로(burnMode 주석 참조) project.tracks(order 순)를 하나의
// CUE/BIN 이미지로 만들어 굽는다.

/** 굽기용 임시 스테이징 디렉토리 경로 */
export function burnStagingDir(projectDirectory: string): string {
  return path.join(projectDirectory, "burn-staging");
}

export interface StagedTrack {
  track: Track;
  /** 검증 대상 원본 WAV 절대 경로 */
  path: string;
  /** 해결 실패 사유 (있으면 검증에서 실패로 보고) */
  error?: string;
}

/** CUE 상의 트랙 배치 (검산·테스트용으로 노출) */
export interface ImageTrack {
  track: Track;
  /** 패딩 전 raw PCM 바이트 */
  pcmBytes: number;
  /** 2352 경계로 올림한 바이트 */
  paddedBytes: number;
  /** paddedBytes / 2352 */
  frames: number;
  /** BIN 내 시작 프레임 = INDEX 01 위치 (프리갭 미포함) */
  startFrame: number;
}

export interface BurnStaging {
  mode: BurnMode;
  /** drutil에 넘길 경로 (cue 파일 또는 스테이징 폴더) */
  targetPath: string;
  stagingDirectory: string;
  /** 이 굽기에 적용된 프리갭 (초) */
  pregapSec: number;
  tracks: ImageTrack[];
  /** BIN 총 바이트 (folder 모드에선 0) */
  binBytes: number;
  /** 생성된 CUE 텍스트 (folder 모드에선 undefined) */
  cueText?: string;
  /** 준비 실패 사유 — 비어 있지 않으면 굽기 중단 */
  failures: string[];
}

/**
 * project.tracks를 order 순으로 해석해 원본 WAV 경로를 확인한다.
 * 이미지 생성 전 검증(validateForBurn)의 입력이 된다.
 */
export async function resolveBurnTracks(
  project: AlbumProject,
  tracksDirectory: string,
): Promise<StagedTrack[]> {
  const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
  const staged: StagedTrack[] = [];

  for (const track of ordered) {
    const source = path.join(tracksDirectory, path.basename(track.filename));
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile()) throw new Error("파일이 아닙니다.");
      staged.push({ track, path: source });
    } catch (error) {
      staged.push({
        track,
        path: source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return staged;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 프레임 수 → CUE의 MM:SS:FF 표기 (1초=75프레임). 79분 상한이라 MM은 항상 2자리 */
export function framesToMsf(frames: number): string {
  const frame = frames % CD_FRAMES_PER_SEC;
  const totalSec = Math.floor(frames / CD_FRAMES_PER_SEC);
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}:${pad2(frame)}`;
}

/**
 * CUE 텍스트를 만든다.
 * PREGAP은 BIN에 데이터를 넣지 않고 버너가 무음을 삽입하므로
 * INDEX(=BIN 내 오프셋) 계산에는 포함하지 않는다.
 */
export function buildCueText(tracks: ImageTrack[], pregapSec: number): string {
  const pregapFrames = Math.max(0, Math.round(pregapSec * CD_FRAMES_PER_SEC));
  const lines = [`FILE "${BIN_NAME}" BINARY`];

  for (const [index, entry] of tracks.entries()) {
    lines.push(`  TRACK ${pad2(index + 1)} AUDIO`);
    if (index > 0 && pregapFrames > 0) {
      lines.push(`    PREGAP ${framesToMsf(pregapFrames)}`);
    }
    lines.push(`    INDEX 01 ${framesToMsf(entry.startFrame)}`);
  }

  return `${lines.join("\r\n")}\r\n`;
}

/**
 * WAV 한 곡을 raw PCM(s16le/44.1k/2ch)으로 변환해 BIN 스트림에 이어 붙인다.
 * 전곡이 수 GB이므로 메모리에 올리지 않고 스트리밍하며, 역압(drain)을 지킨다.
 * @returns 기록한 raw PCM 바이트 수 (패딩 전)
 */
async function appendTrackPcm(
  wavPath: string,
  sink: NodeJS.WritableStream,
): Promise<number> {
  const child = spawn(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-i", wavPath, "-f", "s16le", "-ar", "44100", "-ac", "2", "-"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const exited = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
  // for-await가 먼저 던지면 exited가 미처리 거부로 남는다 → 핸들러를 미리 붙인다.
  exited.catch(() => {});

  let bytes = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (!sink.write(chunk)) await once(sink, "drain");
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const { code, stderr } = await exited;
  if (code !== 0) {
    const detail = stderr.trim().split(/\r?\n/).pop();
    throw new Error(`ffmpeg 변환 실패 (종료 코드 ${code})${detail ? `: ${detail}` : ""}`);
  }
  if (bytes === 0) throw new Error("변환 결과가 비어 있습니다.");
  return bytes;
}

async function writeAll(sink: NodeJS.WritableStream, buffer: Buffer): Promise<void> {
  if (!sink.write(buffer)) await once(sink, "drain");
}

export interface PrepareStagingOptions {
  settings?: BurnSettings;
  /** 트랙별 이미지 생성 진행 알림 (완료 수, 전체 수, 트랙 제목) */
  onTrack?: (done: number, total: number, title: string) => void;
}

/**
 * 굽기 이미지를 만든다.
 *
 * cue 모드(기본): 스테이징 디렉토리에 `audio.bin`(전곡 raw PCM 연결) +
 * `audio.cue`(트랙 경계·프리갭)를 만든다. 각 트랙 끝은 2352바이트(1프레임)
 * 경계까지 0으로 패딩한다 — CD 섹터 정렬 필수.
 * 프리갭은 `settings.pregapSec`(미지정 시 2초)을 2번 트랙부터 적용한다.
 *
 * folder 모드(CDSTUDIO_BURN_MODE=folder): 기존 방식대로 `NN - 제목.wav`를
 * 하드링크(실패 시 복사)로 배치한다. 굽기 순서는 보장되지 않는다.
 */
export async function prepareBurnStaging(
  staged: StagedTrack[],
  stagingDirectory: string,
  options: PrepareStagingOptions = {},
): Promise<BurnStaging> {
  const mode = burnMode();
  const pregapSec = effectivePregapSec(options.settings);

  await cleanupBurnStaging(stagingDirectory);
  await fs.mkdir(stagingDirectory, { recursive: true });

  const base: BurnStaging = {
    mode,
    targetPath: stagingDirectory,
    stagingDirectory,
    pregapSec,
    tracks: [],
    binBytes: 0,
    failures: [],
  };

  if (staged.length === 0) {
    return { ...base, failures: ["굽기할 트랙이 없습니다."] };
  }
  if (staged.length > CD_MAX_TRACKS) {
    return {
      ...base,
      failures: [`오디오 CD는 최대 ${CD_MAX_TRACKS}트랙까지만 구울 수 있습니다. (현재 ${staged.length}개)`],
    };
  }
  const unresolved = staged.filter((entry) => entry.error);
  if (unresolved.length > 0) {
    return {
      ...base,
      failures: unresolved.map(
        (entry) => `${entry.track.order}. ${entry.track.title}: 원본 파일을 찾을 수 없습니다. (${entry.error})`,
      ),
    };
  }

  if (mode === "folder") return prepareFolderStaging(staged, stagingDirectory, base);

  const binPath = path.join(stagingDirectory, BIN_NAME);
  const cuePath = path.join(stagingDirectory, CUE_NAME);
  const sink = createWriteStream(binPath);
  const failures: string[] = [];
  const tracks: ImageTrack[] = [];
  let expectedBytes = 0;

  // 디스크 가득참 등으로 스트림이 비동기 에러를 내면 리스너가 없을 때
  // 프로세스가 죽는다. 반드시 붙여 두고 루프 종료 후 확인한다.
  const sinkState: { error: Error | null } = { error: null };
  sink.on("error", (error: Error) => {
    sinkState.error ??= error;
  });

  try {
    for (const [index, entry] of staged.entries()) {
      const label = `${index + 1}. ${entry.track.title}`;
      try {
        const pcmBytes = await appendTrackPcm(entry.path, sink);
        const remainder = pcmBytes % CD_FRAME_BYTES;
        let paddedBytes = pcmBytes;
        if (remainder !== 0) {
          const padding = Buffer.alloc(CD_FRAME_BYTES - remainder);
          await writeAll(sink, padding);
          paddedBytes += padding.length;
        }
        tracks.push({
          track: entry.track,
          pcmBytes,
          paddedBytes,
          frames: paddedBytes / CD_FRAME_BYTES,
          startFrame: expectedBytes / CD_FRAME_BYTES,
        });
        expectedBytes += paddedBytes;
      } catch (error) {
        failures.push(
          `${label}: 굽기 이미지를 만들지 못했습니다. (${error instanceof Error ? error.message : String(error)})`,
        );
        break;
      }
      options.onTrack?.(index + 1, staged.length, entry.track.title);
    }
  } finally {
    await new Promise<void>((resolve) => {
      if (sink.closed || sink.destroyed) resolve();
      else {
        sink.once("close", () => resolve());
        sink.end();
      }
    });
  }

  if (failures.length > 0) return { ...base, failures };
  if (sinkState.error) {
    return { ...base, failures: [`굽기 이미지를 저장하지 못했습니다. (${sinkState.error.message})`] };
  }

  // 이어붙이기 중 유실이 없었는지 확인 (섹터 정렬 = 굽기 순서·경계의 전제)
  const stat = await fs.stat(binPath).catch(() => null);
  if (!stat || stat.size !== expectedBytes) {
    return {
      ...base,
      failures: [
        `굽기 이미지 크기가 예상과 다릅니다. (예상 ${expectedBytes}바이트 / 실제 ${stat?.size ?? 0}바이트)`,
      ],
    };
  }

  const cueText = buildCueText(tracks, pregapSec);
  await fs.writeFile(cuePath, cueText, "ascii");

  return { ...base, targetPath: cuePath, tracks, binBytes: stat.size, cueText, failures: [] };
}

/** 폴더 방식 폴백 — 하드링크 우선, 실패 시 복사 (굽기 순서 보장 없음) */
async function prepareFolderStaging(
  staged: StagedTrack[],
  stagingDirectory: string,
  base: BurnStaging,
): Promise<BurnStaging> {
  const failures: string[] = [];

  for (const [index, entry] of staged.entries()) {
    const prefix = pad2(index + 1);
    const title = safeFilename(entry.track.title) || `track-${prefix}`;
    const destination = path.join(stagingDirectory, `${prefix} - ${title}.wav`);
    try {
      await fs.link(entry.path, destination);
      continue;
    } catch {
      // 하드링크 불가(다른 볼륨 등) → 복사 폴백
    }
    try {
      await fs.copyFile(entry.path, destination);
    } catch (error) {
      failures.push(
        `${index + 1}. ${entry.track.title}: 굽기 파일을 준비하지 못했습니다. (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  return { ...base, failures };
}

/** 스테이징 디렉토리 정리 (완료·실패 무관하게 호출) */
export async function cleanupBurnStaging(stagingDirectory: string): Promise<void> {
  await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
}

/**
 * 굽기 사전 검증 — 이미지로 들어갈 원본 WAV를 기준으로 검사한다.
 * 총 재생 시간은 project.json의 durationSec(참고용)이 아니라
 * ffprobe로 조회한 실제 WAV duration을 합산한다.
 * (수 GB 이미지 생성 전에 호출해야 헛수고를 막을 수 있다)
 *
 * 79분 상한에는 **트랙 간격(프리갭)도 가산**한다. 실제 디스크 점유는
 * 오디오 합계 + (트랙수−1)×pregapSec + 2초(1번 트랙 리드인, Red Book 고정)다.
 */
export async function validateForBurn(
  project: AlbumProject,
  staged: StagedTrack[],
  settings?: BurnSettings,
): Promise<string[]> {
  const failures: string[] = [];

  if (project.tracks.length === 0) failures.push("굽기할 트랙이 없습니다.");

  const incomplete = project.tracks.filter((track) => track.status !== "done");
  if (incomplete.length > 0) {
    failures.push(`준비되지 않은 트랙이 ${incomplete.length}개 있습니다.`);
  }

  if (staged.length !== project.tracks.length) {
    failures.push("굽기 파일 준비 중 일부 트랙이 누락됐습니다.");
  }

  let totalSec = 0;
  let durationKnown = true;

  for (const [index, entry] of staged.entries()) {
    const label = `${index + 1}. ${entry.track.title}`;
    if (entry.error) {
      failures.push(`${label}: 굽기 파일을 준비하지 못했습니다. (${entry.error})`);
      durationKnown = false;
      continue;
    }
    try {
      const result = await run(FFPROBE, [
        "-v",
        "error",
        "-show_entries",
        "stream=sample_rate,channels,sample_fmt:format=duration",
        "-of",
        "json",
        entry.path,
      ]);
      if (result.code !== 0) {
        failures.push(`${label}: WAV 파일을 읽을 수 없습니다.`);
        durationKnown = false;
        continue;
      }
      const parsed = JSON.parse(result.stdout) as {
        streams?: ProbeStream[];
        format?: { duration?: string };
      };
      const stream = parsed.streams?.[0];
      if (
        !stream ||
        stream.sample_rate !== "44100" ||
        stream.channels !== 2 ||
        stream.sample_fmt !== "s16"
      ) {
        failures.push(`${label}: 44.1kHz/16bit/스테레오 WAV가 아닙니다.`);
      }
      const duration = Number(parsed.format?.duration);
      if (Number.isFinite(duration) && duration > 0) {
        totalSec += duration;
      } else {
        failures.push(`${label}: 재생 시간을 확인할 수 없습니다.`);
        durationKnown = false;
      }
    } catch {
      failures.push(`${label}: WAV 규격을 확인할 수 없습니다.`);
      durationKnown = false;
    }
  }

  // 트랙 간격은 실제로 디스크를 점유한다. 1번 트랙 앞 2초 리드인은 규격상 고정이고,
  // 설정한 간격은 2번 트랙부터 (트랙수−1)회 삽입된다.
  const pregapSec = effectivePregapSec(settings);
  const gapSec =
    staged.length > 0 ? DEFAULT_PREGAP_SEC + Math.max(0, staged.length - 1) * pregapSec : 0;
  const discSec = totalSec + gapSec;

  if (durationKnown && discSec > MAX_AUDIO_MINUTES * 60) {
    failures.push(
      `총 재생 시간이 ${MAX_AUDIO_MINUTES}분을 초과합니다. ` +
        `(트랙 간격 포함 ${formatDuration(discSec)} — 오디오 ${formatDuration(totalSec)} + 간격 ${formatDuration(gapSec)})`,
    );
  }

  return failures;
}

function emitLines(
  chunk: string,
  remainder: string,
  onEvent: (event: BurnEvent) => void,
): string {
  const parts = (remainder + chunk).split(/\r?\n|\r/);
  const nextRemainder = parts.pop() ?? "";
  for (const line of parts) {
    const message = line.trim();
    if (!message) continue;
    onEvent({ type: "log", message });
    const match = message.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) onEvent({ type: "progress", percent: Math.min(100, Number(match[1])) });
  }
  return nextRemainder;
}

/**
 * 서버 측 드라이브 재검증 — 클라이언트 모달/폴링 결과를 신뢰하지 않는다.
 * 굽기 직전에 호출해 실패 사유(한국어)를 돌려준다. 통과 시 null.
 */
export function checkDriveReady(status: DriveStatus): string | null {
  if (!status.connected) return "광학 드라이브가 연결되어 있지 않습니다.";
  if (!status.mediaPresent) return "드라이브에 디스크가 없습니다.";
  if (!status.blank && !status.erasable) {
    return "기록 가능한 공 CD가 아닙니다. 새 CD-R 또는 지울 수 있는 CD-RW를 넣어 주세요.";
  }
  return null;
}

/** 굽기 배속 허용 범위 (drutil -speed) */
const SPEED_MIN = 1;
const SPEED_MAX = 48;
/** 트랙 간격 허용 범위 (초, drutil -pregap) */
const PREGAP_MIN = 0;
const PREGAP_MAX = 10;

function intInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

/**
 * BurnSettings → drutil 인자 배열.
 *
 * 값은 반드시 정수·범위 검증 후 String(n)으로 인자 배열에 넣는다 (셸 조합 금지).
 *
 * drutil 인자 형식 실측(2026-07-31, macOS 26.5 / drutil 내장):
 *  - `-speed <N>`  : 값 인자를 받는다. man drutil 예시 `burn -noverify -eject -speed 24 ~/Documents`.
 *  - `-pregap <S>` : **폴더(-audio) 굽기 전용**. 값 인자를 받으며 단위는 초.
 *    `drutil size -audio -pregap N <dir>`의 블록 수(75블록=1초)로 확인:
 *    미지정 1800 / 0→1650 / 1→1725 / 2→1800 / 3→1875 / 4→1950 / 5→2025.
 *    즉 기본값은 2초이고, 1번 트랙 앞 2초 리드인은 규격상 고정이라 값은 2번 트랙부터 적용된다.
 *    6초 이상을 주면 오류 없이 조용히 기본값(2초)으로 되돌아간다 (man: "Invalid commands are ignored").
 *
 * cue 모드에서는 `-audio`·`-pregap`을 쓰지 않는다 — 트랙 경계와 갭이 모두 CUE 안에
 * 명시돼 있고(PREGAP 줄), drutil은 `.cue/bin`을 이미지로 인식해 그대로 굽는다.
 */
export function burnArgs(staging: BurnStaging, settings?: BurnSettings): string[] {
  const options: string[] = [];

  const speed = intInRange(settings?.speed, SPEED_MIN, SPEED_MAX);
  if (speed !== undefined) options.push("-speed", String(speed));

  // 폴더 굽기에서만 drutil이 갭을 삽입한다. cue 모드는 CUE의 PREGAP이 담당.
  const folderOptions: string[] = [];
  if (staging.mode === "folder") {
    folderOptions.push("-audio");
    const pregapSec = intInRange(settings?.pregapSec, PREGAP_MIN, PREGAP_MAX);
    if (pregapSec !== undefined) options.push("-pregap", String(pregapSec));
  }

  // drutil 문법: burn (burn-options) <path> — 경로는 반드시 마지막.
  // 경로 뒤에 옵션을 두면 usage 도움말과 함께 종료 코드 1로 실패한다 (실드라이브에서 확인).
  return ["burn", ...folderOptions, "-noverify", "-eject", ...options, staging.targetPath];
}

/**
 * 준비된 굽기 이미지를 오디오 CD로 굽는다.
 *
 * ⚠️ 물리 굽기 중 drutil 자식 프로세스를 죽이면 디스크가 그대로 버려지므로,
 *    클라이언트가 연결을 끊어도(=SSE cancel) 이 프로세스는 절대 kill하지 않는다.
 */
export function burn(
  staging: BurnStaging,
  onEvent: (event: BurnEvent) => void,
  settings?: BurnSettings,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(DRUTIL, burnArgs(staging, settings), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutRemainder = "";
    let stderrRemainder = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutRemainder = emitLines(chunk, stdoutRemainder, onEvent);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrRemainder = emitLines(chunk, stderrRemainder, onEvent);
    });
    child.on("error", (error) => {
      onEvent({ type: "error", message: `drutil 실행 실패: ${error.message}` });
      resolve();
    });
    child.on("close", (code) => {
      for (const message of [stdoutRemainder, stderrRemainder]) {
        if (message.trim()) onEvent({ type: "log", message: message.trim() });
      }
      if (code === 0) onEvent({ type: "done" });
      else onEvent({ type: "error", message: `CD 굽기에 실패했습니다. (종료 코드 ${code ?? "없음"})` });
      resolve();
    });
  });
}
