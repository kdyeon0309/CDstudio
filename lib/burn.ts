import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import type { AlbumProject, BurnEvent, BurnSettings, DriveStatus, Track } from "./types";
import { MAX_AUDIO_MINUTES, formatDuration } from "./types";
import { safeFilename } from "./storage";

const DRUTIL = "/usr/bin/drutil";
const FFPROBE = "/opt/homebrew/bin/ffprobe";

/** 전역 굽기 락 키 (드라이브는 1대뿐이므로 프로젝트 무관 전역) */
export const BURN_LOCK_KEY = "burn:drive";

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
// drutil burn -audio 는 지정 디렉토리의 파일을 통째로 굽는다.
// tracks/ 를 직접 넘기면 project.json에서 삭제·재정렬된 내용이 반영되지 않아
// 삭제한 곡이 실물 CD에 들어가거나 순서가 뒤바뀐다.
// 그래서 굽기 직전 project.tracks(order 순)만 담은 임시 디렉토리를 만들어 굽는다.

/** 굽기용 임시 스테이징 디렉토리 경로 */
export function burnStagingDir(projectDirectory: string): string {
  return path.join(projectDirectory, "burn-staging");
}

export interface StagedTrack {
  track: Track;
  /** 스테이징 디렉토리 내 절대 경로 */
  path: string;
  /** 링크/복사 실패 사유 (있으면 검증에서 실패로 보고) */
  error?: string;
}

/**
 * project.tracks를 order 순으로 스테이징 디렉토리에 `NN - 제목.wav`로 배치한다.
 * 하드링크를 우선 시도하고(0.8GB×N 복사 회피), 실패하면 복사로 폴백한다.
 * 기존 스테이징 디렉토리는 항상 삭제 후 재생성한다.
 */
export async function prepareBurnStaging(
  project: AlbumProject,
  tracksDirectory: string,
  stagingDirectory: string,
): Promise<StagedTrack[]> {
  await cleanupBurnStaging(stagingDirectory);
  await fs.mkdir(stagingDirectory, { recursive: true });

  const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
  const staged: StagedTrack[] = [];

  for (const [index, track] of ordered.entries()) {
    const source = path.join(tracksDirectory, path.basename(track.filename));
    const prefix = String(index + 1).padStart(2, "0");
    const title = safeFilename(track.title) || `track-${prefix}`;
    const destination = path.join(stagingDirectory, `${prefix} - ${title}.wav`);

    try {
      await fs.link(source, destination);
      staged.push({ track, path: destination });
      continue;
    } catch {
      // 하드링크 불가(다른 볼륨 등) → 복사 폴백
    }
    try {
      await fs.copyFile(source, destination);
      staged.push({ track, path: destination });
    } catch (error) {
      staged.push({
        track,
        path: destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return staged;
}

/** 스테이징 디렉토리 정리 (완료·실패 무관하게 호출) */
export async function cleanupBurnStaging(stagingDirectory: string): Promise<void> {
  await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
}

/**
 * 굽기 사전 검증 — 실제로 구워질 스테이징 파일을 기준으로 검사한다.
 * 총 재생 시간은 project.json의 durationSec(참고용)이 아니라
 * ffprobe로 조회한 실제 WAV duration을 합산한다.
 */
export async function validateForBurn(
  project: AlbumProject,
  staged: StagedTrack[],
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

  if (durationKnown && totalSec > MAX_AUDIO_MINUTES * 60) {
    failures.push(
      `총 재생 시간이 ${MAX_AUDIO_MINUTES}분을 초과합니다. (실제 ${formatDuration(totalSec)})`,
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
 * drutil 인자 형식 실측(2026-07-31, macOS 15 / drutil 내장):
 *  - `-speed <N>`  : 값 인자를 받는다. man drutil 예시 `burn -noverify -eject -speed 24 ~/Documents`.
 *  - `-pregap <S>` : **값 인자를 받으며 단위는 초**. 드라이브 없이도 동작하는
 *    `drutil size -audio -pregap N <dir>`의 블록 수(75블록=1초)로 확인:
 *    미지정 1800 / 0→1650 / 1→1725 / 2→1800 / 3→1875 / 4→1950 / 5→2025.
 *    즉 기본값은 2초이고, 1번 트랙 앞 2초 리드인은 규격상 고정이라 값은 2번 트랙부터 적용된다.
 *    6초 이상을 주면 오류 없이 조용히 기본값(2초)으로 되돌아간다 (man: "Invalid commands are ignored").
 */
export function burnArgs(stagingDirectory: string, settings?: BurnSettings): string[] {
  const options: string[] = [];

  const speed = intInRange(settings?.speed, SPEED_MIN, SPEED_MAX);
  if (speed !== undefined) options.push("-speed", String(speed));

  const pregapSec = intInRange(settings?.pregapSec, PREGAP_MIN, PREGAP_MAX);
  if (pregapSec !== undefined) options.push("-pregap", String(pregapSec));

  // drutil 문법: burn (burn-options) <path> — 경로는 반드시 마지막.
  // 경로 뒤에 옵션을 두면 usage 도움말과 함께 종료 코드 1로 실패한다 (실드라이브에서 확인).
  return ["burn", "-audio", "-noverify", "-eject", ...options, stagingDirectory];
}

/**
 * 스테이징 디렉토리를 오디오 CD로 굽는다.
 *
 * ⚠️ 물리 굽기 중 drutil 자식 프로세스를 죽이면 디스크가 그대로 버려지므로,
 *    클라이언트가 연결을 끊어도(=SSE cancel) 이 프로세스는 절대 kill하지 않는다.
 */
export function burn(
  stagingDirectory: string,
  onEvent: (event: BurnEvent) => void,
  settings?: BurnSettings,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(DRUTIL, burnArgs(stagingDirectory, settings), {
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
