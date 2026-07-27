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
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** child_process.spawn 래퍼 — 인자 배열 전용, AbortSignal 로 kill */
function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    const flush = (buf: string, sep: RegExp, cb?: (line: string) => void) => {
      if (!cb) return buf;
      const parts = buf.split(sep);
      const rest = parts.pop() ?? "";
      for (const line of parts) cb(line);
      return rest;
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      outBuf = flush(outBuf + s, /\n/, opts.onStdout);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      errBuf = flush(errBuf + s, /[\r\n]/, opts.onStderr);
    });

    child.on("error", (err) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (opts.onStdout && outBuf) opts.onStdout(outBuf);
      if (opts.onStderr && errBuf) opts.onStderr(errBuf);
      if (aborted) {
        reject(new AbortError());
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
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

/**
 * URL(곡/플레이리스트)의 메타를 조회한다. 다운로드는 하지 않는다.
 * yt-dlp --dump-single-json --flat-playlist
 */
export async function probeUrl(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  if (!isHttpUrl(url)) throw new Error("http/https URL만 허용됩니다");
  const { code, stdout, stderr } = await run(
    YT_DLP,
    ["--dump-single-json", "--flat-playlist", "--no-warnings", url],
    { signal },
  );
  if (code !== 0) throw new Error(`메타 조회 실패: ${tail(stderr) || `종료코드 ${code}`}`);

  let data: RawEntry;
  try {
    data = JSON.parse(stdout) as RawEntry;
  } catch {
    throw new Error("yt-dlp 응답을 해석할 수 없습니다");
  }

  if (Array.isArray(data.entries)) {
    const items = data.entries
      .filter((e) => e && (e.id || e.url || e.webpage_url))
      .map((e) => toProbeItem(e, e.webpage_url ?? e.url ?? url));
    const result: ProbeResult = { kind: "playlist", items };
    const pt = data.playlist_title ?? data.title;
    if (pt) result.playlistTitle = pt;
    return result;
  }

  return { kind: "single", items: [toProbeItem(data, data.webpage_url ?? url)] };
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
  if (!isHttpUrl(sourceUrl)) throw new Error("http/https URL만 허용됩니다");
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

/** ffprobe 로 재생 시간(초)을 구한다. */
export async function probeDuration(file: string, signal?: AbortSignal): Promise<number> {
  const { code, stdout } = await run(
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
    { signal },
  );
  if (code !== 0) return 0;
  const d = parseFloat(stdout.trim());
  return isFinite(d) ? d : 0;
}
