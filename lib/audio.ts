/**
 * audio.ts — yt-dlp / ffmpeg / ffprobe 래퍼
 *
 * ★ 모든 외부 프로세스 실행은 인자 배열로만 spawn 한다 (셸 문자열 조합 금지).
 *   바이너리 경로는 PATH 에 의존하지 않고 상수로 고정한다.
 */
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ProbeItem, ProbeResult } from "./types";

export const YT_DLP = "/opt/homebrew/bin/yt-dlp";
export const FFMPEG = "/opt/homebrew/bin/ffmpeg";
export const FFPROBE = "/opt/homebrew/bin/ffprobe";

/** 추출 중단 시 던지는 에러 (호출부에서 정상 종료로 처리) */
export class AbortError extends Error {
  constructor() {
    super("작업이 중단되었습니다");
    this.name = "AbortError";
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── 소스 URL 허용 목록 (M6) ───────────────────────────────────
// yt-dlp 는 임의 호스트를 긁을 수 있으므로 YouTube/SoundCloud 계열만 허용한다.
export const ALLOWED_SOURCE_HOSTS: readonly string[] = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "soundcloud.com",
  "m.soundcloud.com",
  "on.soundcloud.com",
];

const ALLOWED_HOST_SET = new Set(ALLOWED_SOURCE_HOSTS);

/** URL 호스트가 허용 목록에 있는지 (http/https 여부도 함께 검사) */
export function isAllowedSourceUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // 후행 점("youtube.com.")으로 우회하지 못하도록 정규화
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOST_SET.has(host);
}

/** 허용 목록 밖이면 한국어 오류를 던진다 */
export function assertAllowedSourceUrl(url: string): void {
  if (!isHttpUrl(url)) throw new Error("http/https URL만 허용됩니다");
  if (!isAllowedSourceUrl(url)) {
    throw new Error(
      "YouTube 또는 SoundCloud 주소만 사용할 수 있습니다 (허용 호스트: " +
        ALLOWED_SOURCE_HOSTS.join(", ") +
        ")",
    );
  }
}

// ── 프로세스 실행 ─────────────────────────────────────────────

/** 오류 보고용 stderr/stdout tail 버퍼 상한 (M8) */
const TAIL_BYTES = 64 * 1024;
/** 전체 캡처(JSON 파싱용) 상한 — 초과 시 잘라내고 truncated 표시 */
const CAPTURE_LIMIT = 32 * 1024 * 1024;

/** 마지막 N바이트만 유지하는 누적 버퍼 — 무제한 문자열 누적 방지 */
class TailBuffer {
  private buf = "";
  append(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > TAIL_BYTES) {
      this.buf = this.buf.slice(this.buf.length - TAIL_BYTES);
    }
  }
  toString(): string {
    return this.buf;
  }
}

function tail(text: string, lines = 4): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join(" / ")
    .slice(0, 500);
}

interface RunOpts {
  signal?: AbortSignal;
  /** 개행 단위로 분리된 stdout 라인 */
  onStdout?: (line: string) => void;
  /** \r 또는 \n 단위로 분리된 stderr 라인 */
  onStderr?: (line: string) => void;
  /** true 면 stdout 전체를 캡처한다 (JSON 파싱용). 기본은 tail 만 유지 */
  captureStdout?: boolean;
  /** 밀리초 타임아웃 — 초과 시 SIGKILL 후 오류 */
  timeoutMs?: number;
}

interface RunResult {
  code: number;
  /** captureStdout 일 때 전체, 아니면 마지막 64KB */
  stdout: string;
  /** 항상 마지막 64KB */
  stderr: string;
  /** captureStdout 인데 상한을 넘어 잘렸는지 */
  stdoutTruncated: boolean;
}

/** child_process.spawn 래퍼 — 인자 배열 전용, AbortSignal 로 kill */
function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    // stdout: 필요할 때만 전체 캡처, 그 외에는 tail 만 (M8)
    let captured = opts.captureStdout ? "" : null;
    let stdoutTruncated = false;
    const outTail = new TailBuffer();
    const errTail = new TailBuffer();
    let outBuf = "";
    let errBuf = "";
    let aborted = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    function onAbort() {
      aborted = true;
      child.kill("SIGKILL");
    }
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    const flush = (buf: string, sep: RegExp, cb?: (line: string) => void) => {
      if (!cb) return "";
      const parts = buf.split(sep);
      const rest = parts.pop() ?? "";
      for (const line of parts) cb(line);
      // 개행 없는 초장 라인도 무한히 쌓이지 않게 tail 만 유지 (M8)
      return rest.length > TAIL_BYTES ? rest.slice(-TAIL_BYTES) : rest;
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (captured !== null) {
        if (captured.length + s.length > CAPTURE_LIMIT) {
          stdoutTruncated = true;
          captured = (captured + s).slice(0, CAPTURE_LIMIT);
        } else {
          captured += s;
        }
      }
      outTail.append(s);
      outBuf = flush(outBuf + s, /\n/, opts.onStdout);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      errTail.append(s);
      errBuf = flush(errBuf + s, /[\r\n]/, opts.onStderr);
    });

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.onStdout && outBuf) opts.onStdout(outBuf);
      if (opts.onStderr && errBuf) opts.onStderr(errBuf);
      if (aborted) {
        reject(new AbortError());
        return;
      }
      if (timedOut) {
        reject(
          new Error(
            `시간이 초과되어 중단했습니다 (${Math.round((opts.timeoutMs ?? 0) / 1000)}초)`,
          ),
        );
        return;
      }
      resolve({
        code: code ?? -1,
        stdout: captured !== null ? captured : outTail.toString(),
        stderr: errTail.toString(),
        stdoutTruncated,
      });
    });
  });
}

// ── probe ─────────────────────────────────────────────────────

interface RawEntry {
  _type?: string;
  ie_key?: string;
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  artist?: string;
  duration?: number;
  entries?: RawEntry[];
  playlist_title?: string;
}

function entrySourceUrl(entry: RawEntry, fallback: string): string {
  if (entry.webpage_url && isHttpUrl(entry.webpage_url)) return entry.webpage_url;
  if (entry.url && isHttpUrl(entry.url)) return entry.url;
  if (entry.id && (entry.ie_key === "Youtube" || entry._type === "url")) {
    // flat-playlist 의 YouTube 항목은 id 만 담기는 경우가 있다
    if (/^[A-Za-z0-9_-]{11}$/.test(entry.id)) {
      return `https://www.youtube.com/watch?v=${entry.id}`;
    }
  }
  return fallback;
}

function toProbeItem(entry: RawEntry, fallbackUrl: string): ProbeItem {
  const item: ProbeItem = {
    sourceUrl: entrySourceUrl(entry, fallbackUrl),
    title: (entry.title ?? "제목 없음").trim() || "제목 없음",
  };
  const artist = entry.artist ?? entry.uploader ?? entry.channel;
  if (artist) item.artist = artist;
  if (typeof entry.duration === "number" && isFinite(entry.duration)) {
    item.durationSec = Math.round(entry.duration);
  }
  return item;
}

/** probe 타임아웃 (M2) */
export const PROBE_TIMEOUT_MS = 60_000;
/** 플레이리스트 항목 상한 (M2) — 초과분은 잘라내고 응답에 표시 */
export const MAX_PROBE_ITEMS = 100;
/** 한 번의 추출 요청에서 처리할 수 있는 최대 곡 수 (M2) */
export const MAX_EXTRACT_ITEMS = 50;

/** ProbeResult + 잘라내기 정보 (lib/types.ts 계약은 그대로 두고 확장 필드만 추가) */
export interface ProbeResultEx extends ProbeResult {
  /** 항목 상한 초과로 잘라냈는지 */
  truncated?: boolean;
  /** 잘라내기 전 전체 항목 수 */
  totalItems?: number;
}

/**
 * URL(곡/플레이리스트)의 메타를 조회한다. 다운로드는 하지 않는다.
 * yt-dlp --dump-single-json --flat-playlist
 */
export async function probeUrl(url: string, signal?: AbortSignal): Promise<ProbeResultEx> {
  assertAllowedSourceUrl(url);
  const { code, stdout, stderr, stdoutTruncated } = await run(
    YT_DLP,
    ["--dump-single-json", "--flat-playlist", "--no-warnings", url],
    { signal, captureStdout: true, timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (code !== 0) throw new Error(`메타 조회 실패: ${tail(stderr) || `종료코드 ${code}`}`);
  if (stdoutTruncated) throw new Error("yt-dlp 응답이 너무 큽니다");

  let data: RawEntry;
  try {
    data = JSON.parse(stdout) as RawEntry;
  } catch {
    throw new Error("yt-dlp 응답을 해석할 수 없습니다");
  }

  if (Array.isArray(data.entries)) {
    const usable = data.entries.filter((e) => e && (e.id || e.url || e.webpage_url));
    const totalItems = usable.length;
    const truncated = totalItems > MAX_PROBE_ITEMS;
    const items = usable
      .slice(0, MAX_PROBE_ITEMS)
      .map((e) => toProbeItem(e, e.webpage_url ?? e.url ?? url));
    const result: ProbeResultEx = { kind: "playlist", items, totalItems };
    if (truncated) result.truncated = true;
    const pt = data.playlist_title ?? data.title;
    if (pt) result.playlistTitle = pt;
    return result;
  }

  return {
    kind: "single",
    items: [toProbeItem(data, data.webpage_url ?? url)],
    totalItems: 1,
  };
}

// ── download / convert / duration ─────────────────────────────

/**
 * 최고 음질 오디오를 tracksDir 아래 임시 파일로 내려받는다.
 * @returns 내려받은 임시 파일의 절대 경로
 */
export async function downloadAudio(
  sourceUrl: string,
  tracksDir: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  assertAllowedSourceUrl(sourceUrl);
  const tmpId = randomUUID();
  const outTemplate = path.join(tracksDir, `.tmp-${tmpId}.%(ext)s`);

  const onLine = (line: string) => {
    const m = line.match(/\[download\]\s+([\d.]+)%/);
    if (m) onProgress(Math.min(100, parseFloat(m[1])));
  };

  const { code, stderr } = await run(
    YT_DLP,
    [
      "-f",
      "bestaudio",
      "-o",
      outTemplate,
      "--no-playlist",
      "--newline",
      "--progress",
      "--no-warnings",
      sourceUrl,
    ],
    { signal, onStdout: onLine, onStderr: onLine },
  );
  if (code !== 0) throw new Error(`다운로드 실패: ${tail(stderr) || `종료코드 ${code}`}`);

  const files = await fs.readdir(tracksDir);
  const match = files.find((f) => f.startsWith(`.tmp-${tmpId}.`));
  if (!match) throw new Error("다운로드된 파일을 찾을 수 없습니다");
  onProgress(100);
  return path.join(tracksDir, match);
}

/**
 * 오디오 CD 규격 WAV(44.1kHz/16bit/스테레오)로 변환한다.
 */
export async function convertToCdWav(
  srcPath: string,
  outPath: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = await probeDuration(srcPath, signal);
  const { code, stderr } = await run(
    FFMPEG,
    [
      "-i",
      srcPath,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-sample_fmt",
      "s16",
      "-progress",
      "pipe:1",
      "-nostats",
      "-y",
      outPath,
    ],
    {
      signal,
      onStdout: (line) => {
        const m = line.match(/out_time=(\d+):(\d+):([\d.]+)/);
        if (m && total > 0) {
          const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(100, (t / total) * 100));
        }
      },
    },
  );
  if (code !== 0) throw new Error(`변환 실패: ${tail(stderr) || `종료코드 ${code}`}`);
  onProgress(100);
}

/** ffprobe 로 재생 시간(초)을 구한다. 실패 시 0 (중단은 그대로 전파). */
export async function probeDuration(file: string, signal?: AbortSignal): Promise<number> {
  let result: RunResult;
  try {
    result = await runFfprobeDuration(file, signal);
  } catch (err) {
    if (err instanceof AbortError) throw err;
    return 0; // 타임아웃·실행 실패는 시간 미상(0)으로 처리
  }
  const { code, stdout } = result;
  if (code !== 0) return 0;
  const d = parseFloat(stdout.trim());
  return isFinite(d) ? d : 0;
}

function runFfprobeDuration(file: string, signal?: AbortSignal): Promise<RunResult> {
  return run(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { signal, captureStdout: true, timeoutMs: PROBE_TIMEOUT_MS },
  );
}
