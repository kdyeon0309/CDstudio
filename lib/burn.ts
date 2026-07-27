import { spawn } from "child_process";
import path from "path";
import type { AlbumProject, BurnEvent, DriveStatus } from "./types";
import { MAX_AUDIO_MINUTES, totalDurationSec } from "./types";

const DRUTIL = "/usr/bin/drutil";
const FFPROBE = "/opt/homebrew/bin/ffprobe";

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
    if (result.code !== 0 || !raw || /no (optical )?drive|no device|not found/i.test(raw)) {
      return { connected: false, mediaPresent: false, blank: false, erasable: false, raw };
    }

    const type = field(raw, "Type");
    const mediaPresent =
      !!type &&
      !/no media|none|unknown/i.test(type) &&
      !/no media|please insert|tray open/i.test(raw);
    const blankValue = field(raw, "Blank");
    const writableValue = field(raw, "Writable");
    const erasableValue = field(raw, "Erasable");
    const spaceFree = field(raw, "Space Free");
    const minuteMatch = spaceFree?.match(/(\d+(?:\.\d+)?)\s*(?:min|minute)/i);
    const msfMatch = spaceFree?.match(/(\d+):(\d+)(?::(\d+))?/);
    const writableMinutes = minuteMatch
      ? Number(minuteMatch[1])
      : msfMatch
        ? Number(msfMatch[1]) + Number(msfMatch[2]) / 60 + Number(msfMatch[3] ?? 0) / 4500
        : undefined;

    return {
      connected: true,
      vendor: field(raw, "Vendor"),
      product: field(raw, "Product"),
      mediaPresent,
      blank: mediaPresent && (positiveValue(blankValue) || /\bblank\b/i.test(type ?? "")),
      erasable: mediaPresent && (positiveValue(erasableValue) || /CD-RW/i.test(type ?? "")),
      writableMinutes,
      raw,
      ...(positiveValue(writableValue) && !mediaPresent ? { mediaPresent: true } : {}),
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

export async function validateForBurn(
  project: AlbumProject,
  tracksDirectory: string,
): Promise<string[]> {
  const failures: string[] = [];

  if (project.tracks.length === 0) failures.push("굽기할 트랙이 없습니다.");

  const incomplete = project.tracks.filter((track) => track.status !== "done");
  if (incomplete.length > 0) {
    failures.push(`준비되지 않은 트랙이 ${incomplete.length}개 있습니다.`);
  }

  const total = totalDurationSec(project.tracks);
  if (total > MAX_AUDIO_MINUTES * 60) {
    failures.push(`총 재생 시간이 ${MAX_AUDIO_MINUTES}분을 초과합니다.`);
  }

  for (const track of [...project.tracks].sort((a, b) => a.order - b.order)) {
    const file = path.join(tracksDirectory, path.basename(track.filename));
    try {
      const result = await run(FFPROBE, [
        "-v",
        "error",
        "-show_entries",
        "stream=sample_rate,channels,sample_fmt",
        "-of",
        "json",
        file,
      ]);
      if (result.code !== 0) {
        failures.push(`${track.order}. ${track.title}: WAV 파일을 읽을 수 없습니다.`);
        continue;
      }
      const parsed = JSON.parse(result.stdout) as { streams?: ProbeStream[] };
      const stream = parsed.streams?.[0];
      if (
        !stream ||
        stream.sample_rate !== "44100" ||
        stream.channels !== 2 ||
        stream.sample_fmt !== "s16"
      ) {
        failures.push(`${track.order}. ${track.title}: 44.1kHz/16bit/스테레오 WAV가 아닙니다.`);
      }
    } catch {
      failures.push(`${track.order}. ${track.title}: WAV 규격을 확인할 수 없습니다.`);
    }
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

export function burn(
  tracksDirectory: string,
  onEvent: (event: BurnEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      DRUTIL,
      ["burn", "-audio", tracksDirectory, "-noverify", "-eject"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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
