/** ChatGPT 로그인 상태의 Codex CLI 내장 이미지 도구를 이용한 영역별 이미지 생성. */
import { spawn } from "child_process";
import { Readable } from "stream";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import type { StudioArtworkPart } from "./types";
import { STUDIO_PART_LABELS } from "./types";
import {
  ArtifactRecoveryError, recoverCodexThreadArtifact, summarizeCodexJsonl,
  type CodexJsonlSummary,
} from "./image-artifacts";

const CODEX = process.env.CDSTUDIO_CODEX_BIN ?? "codex";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE = 4096;
const MAX_CLI_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const IMAGE_RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["status", "reason", "explanation"],
  properties: {
    status: { type: "string", enum: ["success", "failed"] },
    reason: { type: "string", enum: ["none", "tool_unavailable", "tool_error", "request_refused", "moderation_blocked", "copy_failed", "unknown"] },
    explanation: { type: "string", maxLength: 600 },
  },
} as const;

export class ImageGenerationError extends Error {}

class GeneratedPngAccessError extends ImageGenerationError {
  constructor(public readonly code: string | undefined) {
    super(code === "ENOENT"
      ? "Codex가 이미지 파일을 만들지 않았습니다."
      : "생성 이미지 파일에 접근할 수 없습니다.");
  }
}

function safeDiagnostic(options: {
  diagnosticId: string;
  stage: string;
  exitCode: number;
  startedAt: number;
  summary: CodexJsonlSummary;
  fileCode?: string;
}): void {
  console.warn("[CDstudio:image-generation]", JSON.stringify({
    diagnosticId: options.diagnosticId,
    stage: options.stage,
    exitCode: options.exitCode,
    elapsedMs: Math.max(0, Date.now() - options.startedAt),
    eventCounts: options.summary.eventCounts,
    failedItemTypes: options.summary.failedItemTypes,
    completedItemTypes: options.summary.completedItemTypes,
    thread: {
      present: Boolean(options.summary.threadId), invalid: options.summary.invalidThreadId,
      conflicting: options.summary.conflictingThreadIds,
    },
    ...(options.summary.imageResult ? { imageResult: {
      status: options.summary.imageResult.status, reason: options.summary.imageResult.reason,
    } } : {}),
    ...(options.fileCode ? { fileCode: options.fileCode } : {}),
  }));
}

function unavailableMessage(summary: CodexJsonlSummary, fallback: string): string {
  if (summary.imageResult?.status !== "failed") {
    return `${fallback} Codex가 실패 이유를 보고하지 않았습니다.`;
  }
  const labels = {
    tool_unavailable: "이미지 도구를 사용할 수 없다고",
    tool_error: "이미지 도구 실행 중 오류가 발생했다고",
    request_refused: "요청을 수행할 수 없다고",
    moderation_blocked: "이미지 서비스의 안전 검사에서 차단됐다고",
    copy_failed: "생성 이미지 복사에 실패했다고",
    unknown: "실패했지만 이유를 알 수 없다고",
  } as const;
  const explanation = cleanExplanation(summary.imageResult.explanation);
  const guidance = summary.imageResult.reason === "moderation_blocked"
    ? " 같은 요청의 반복 대신 프롬프트·참고 이미지 검토가 필요합니다." : "";
  return `${fallback} Codex가 ${labels[summary.imageResult.reason as keyof typeof labels]} 응답했습니다.${guidance}${explanation ? ` 설명: ${explanation}` : ""}`;
}

function cleanExplanation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (/[\\/]/.test(normalized)
    || /(?:www\.|\b[a-z][a-z0-9+.-]*:\/\/|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]|(?:sk|pk|sess|api)[-_][A-Za-z0-9_-]{12,})/i.test(normalized)) {
    return undefined;
  }
  const cleaned = normalized.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 600) : undefined;
}

function diagnosticMessage(message: string, diagnosticId: string): ImageGenerationError {
  return new ImageGenerationError(`${message} (진단 ID: ${diagnosticId})`);
}

/** 앱 실행 환경에 API 인증이 있어도 이미지 생성은 Codex의 ChatGPT 로그인만 이용한다. */
function codexEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY",
    "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
    "CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE",
  ]) delete env[key];
  return env;
}

interface ProcessResult { exitCode: number; stdout: string; stderr: string }

/** @internal Shared bounded child-process runner; exported for cancellation tests. */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeoutMs: number; outputLimit?: number; captureStderr?: boolean; stdin?: string },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ImageGenerationError("이미지 생성이 취소되었습니다."));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: codexEnvironment(),
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let bytes = 0;
    let stopped: "timeout" | "abort" | "limit" | null = null;
    let spawnError: Error | null = null;
    let stdinError: Error | null = null;
    let stdinFinished = options.stdin === undefined;
    const stdinBytes = options.stdin === undefined ? null : Buffer.from(options.stdin, "utf8");
    const stdinSource = stdinBytes === null ? null : Readable.from((function* () {
      for (let offset = 0; offset < stdinBytes.length; offset += 32 * 1024) {
        yield stdinBytes.subarray(offset, offset + 32 * 1024);
      }
    })());
    if (stdinSource && child.stdin) {
      child.stdin.on("error", (error) => { stdinError = error; });
      child.stdin.once("finish", () => { stdinFinished = true; });
      stdinSource.pipe(child.stdin);
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
      } else {
        child.kill(signal);
      }
    };
    const kill = (reason: "timeout" | "abort" | "limit") => {
      if (stopped) return;
      stopped = reason;
      stdinSource?.destroy();
      child.stdin?.destroy();
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 2000);
    };
    const onAbort = () => kill("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > (options.outputLimit ?? MAX_CLI_OUTPUT)) {
        kill("limit");
      } else {
        chunks.push(chunk);
      }
    });
    // Only the short `login status` response needs stderr. Other stderr may contain account details.
    child.stderr!.on("data", (chunk: Buffer) => {
      if (options.captureStderr && stderrBytes < 4096) {
        const kept = chunk.subarray(0, 4096 - stderrBytes);
        stderrChunks.push(kept);
        stderrBytes += kept.byteLength;
      }
    });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The parent may close its pipes before a spawned image helper exits.
      // Kill the entire group on cancellation before releasing the caller's job lock.
      if (stopped) signalGroup("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      stdinSource?.destroy();
      if (spawnError) {
        reject(new ImageGenerationError(`${path.basename(command)} 실행에 실패했습니다.`));
      } else if (stopped === "abort") {
        reject(new ImageGenerationError("이미지 생성이 취소되었습니다."));
      } else if (stopped === "timeout") {
        reject(new ImageGenerationError("Codex 이미지 생성 시간이 초과되었습니다."));
      } else if (stopped === "limit") {
        reject(new ImageGenerationError("Codex 출력이 허용 크기를 초과했습니다."));
      } else if (!stdinFinished || stdinError) {
        reject(new ImageGenerationError("Codex에 이미지 생성 요청을 끝까지 전달하지 못했습니다."));
      } else {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(chunks).toString("utf8"),
          stderr: options.captureStderr ? Buffer.concat(stderrChunks).toString("utf8").slice(0, 4096) : "",
        });
      }
    });
  });
}

export async function codexImageAvailability(signal?: AbortSignal): Promise<{ connected: boolean; available: boolean; message: string }> {
  try {
    const status = await runProcess(CODEX, ["login", "status"], {
      timeoutMs: 10_000, outputLimit: 4096, captureStderr: true, signal,
    });
    const connected = status.exitCode === 0 && /Logged in using ChatGPT/i.test(status.stdout + status.stderr);
    return {
      connected,
      available: connected,
      message: connected
        ? "ChatGPT로 로그인된 Codex CLI를 사용할 수 있습니다. 이미지 생성은 실행 시 확인됩니다."
        : "Codex CLI에 ChatGPT 계정으로 로그인해 주세요.",
    };
  } catch {
    return { connected: false, available: false, message: "Codex CLI를 찾거나 실행할 수 없습니다." };
  }
}

function formatRequirements(part: StudioArtworkPart): string {
  if (part === "back-spine") {
    return "Create one narrow vertical spine artwork for a 6.5 x 118 mm CD tray fold. The same single image will be reused on both left and right spines. Do not include a CD label, the central back cover, a jewel case mockup, or fold/crop lines.";
  }
  if (part === "label") {
    return "Square CD label artwork. Keep the central 23 mm diameter hole and outer 116 mm circular cut clear of essential details. The image will be placed within a 116 mm circle on A4 paper.";
  }
  if (part === "back") {
    return "Create flat landscape back-cover artwork for only the central 137 x 118 mm panel. The image canvas must not include either side-spine area. Do not draw side-spine artwork, a jewel case mockup, or fold/crop lines. Keep every requested essential element—including any requested barcode, logo, album title, artist name, and track text—inside a safe margin within this central panel so it cannot be cropped at the panel edges. Do not invent a barcode or logo when the user did not request one. The two 6.5 mm side folds are composed separately by the app.";
  }
  if (part === "back-inner") {
    return "Landscape CD tray inner artwork for 150 x 118 mm printing. Reserve both 6.5 mm side folds and a safe margin.";
  }
  return "Square CD booklet artwork for 120 x 120 mm printing. Keep essential details away from edges.";
}

function printResolutionTarget(part: StudioArtworkPart): string {
  if (part === "back-spine") {
    return "Physical print size: 6.5 x 118 mm. Aim for at least 256 x 1394 native pixels; prioritize at least 1394 pixels along the long edge for 300 PPI at print size. The PNG must be at least 256 pixels on both axes to pass image validation.";
  }
  if (part === "label") {
    return "Physical print diameter: 116 mm. Aim for a square native raster of at least 1371 x 1371 pixels (300 PPI across the full diameter).";
  }
  if (part === "back") {
    return "Physical print size: 137 x 118 mm. Aim for at least 1619 x 1394 native pixels (300 PPI across the spine-free central back panel).";
  }
  if (part === "back-inner") {
    return "Physical print size: 150 x 118 mm. Aim for at least 1772 x 1394 native pixels (300 PPI across the full tray card), even if a separate spine is selected.";
  }
  return "Physical print size: 120 x 120 mm. Aim for a square native raster of at least 1418 x 1418 pixels (300 PPI).";
}

/** 첨부 순서를 고정해 사용자가 프롬프트에서 쓴 임시 이름을 이미지와 연결한다. */
export function buildCodexPrompt(
  part: StudioArtworkPart, userPrompt: string, outputPath: string, referenceNames: string[],
): string {
  return [
    "Use the built-in image generation tool available to this Codex session to create a real raster image.",
    "This artwork is for the user's private, offline CD collection. It is not an official commercial release or a request to distribute or sell packaging.",
    "Do not use an API key, openai images CLI, SDK, external endpoint, SVG, canvas, HTML, or code-drawn substitute.",
    `Create artwork for ${STUDIO_PART_LABELS[part]}. ${formatRequirements(part)}`,
    printResolutionTarget(part),
    "Use the highest native output resolution available to the image tool. Preserve fine detail where the user intends it. Keep a print-ready native pixel count even when intentionally depicting soft focus, low-fi JPEG texture, vintage grain, haze, or blur; honor those artistic effects rather than sharpening them away. If the pixel target is unavailable, keep the real native image rather than resizing or fabricating detail.",
    referenceNames.length > 0
      ? `The ${referenceNames.length} attached image(s) are visual references in exactly the numbered order below. Match each name in the user's request to that image. Preserve only the elements requested; create a new image.`
      : "Create the image from the text description below.",
    ...referenceNames.map((name, index) => `Attached image ${index + 1} (이미지 ${index + 1}): ${JSON.stringify(name)}`),
    "User's image request begins:",
    userPrompt,
    "User's image request ends.",
    "Text supplied or requested by the user, including album titles, artist names, track lists, logos, and other lettering, may appear in the generated image. Render text the user intends to be visible, preserving its spelling and order as closely as possible. Do not invent unrelated text.",
    part === "back" || part === "back-inner"
      ? "Treat a track list supplied in the user's request, including a bare numbered list, as text to render visibly in this image by default. Preserve the supplied track names, spelling, and order as closely as possible. If the user explicitly asks for no text in the image or asks to omit the track list, follow that instruction even when a list is supplied. Also omit the list if the user says it is context or reference only. Do not defer a visible track list to the app's optional print overlay."
      : "",
    `After generation, copy the actual generated PNG raster to this exact path: ${outputPath}`,
    "The built-in image tool may save first under CODEX_HOME/generated_images; copy that output file. Do not fabricate a file or report success without a real image.",
    "Generate exactly one final raster for this request. If copying the already generated PNG fails, do not generate another image solely to retry the copy; keep the native output intact.",
    "Your final response must be only the required JSON result. Report success only after a real PNG exists. On failure report the actual known reason; use moderation_blocked only when the image tool actually reports that code or an output safety-review block, and never guess it from brands or prompt content; use unknown when the reason is not known. Give a concise, specific failure cause in explanation without including the raw user prompt, account data, secrets, URLs, or local paths. Preserve all user requirements and exact requested visible text; you may organize the image-tool instruction into a faithful spec without silently dropping requirements.",
  ].join("\n");
}

export async function generateCodexImage(options: {
  cwd: string;
  part: StudioArtworkPart;
  prompt: string;
  referencePaths: string[];
  referenceNames?: string[];
  outputPath: string;
  signal?: AbortSignal;
}): Promise<{ width: number; height: number }> {
  const referenceNames = options.referenceNames
    ?? options.referencePaths.map((_, index) => `이미지 ${index + 1}`);
  if (referenceNames.length !== options.referencePaths.length) {
    throw new ImageGenerationError("참고 이미지 이름과 첨부 순서가 일치하지 않습니다.");
  }
  const status = await codexImageAvailability(options.signal);
  if (!status.connected) throw new ImageGenerationError(status.message);
  const requestedModel = process.env.CDSTUDIO_IMAGE_CODEX_MODEL?.trim();
  const timeout = Number(process.env.CDSTUDIO_IMAGE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeout) && timeout >= 30_000 && timeout <= 15 * 60_000
    ? timeout : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const diagnosticId = randomUUID();
  const schemaPath = path.join(options.cwd, `.cdstudio-image-result-${randomUUID()}.schema.json`);
  let ownsSchema = false;
  if (options.signal?.aborted) throw new ImageGenerationError("이미지 생성이 취소되었습니다.");
  try {
    await fs.writeFile(schemaPath, JSON.stringify(IMAGE_RESULT_SCHEMA), { flag: "wx", mode: 0o600 });
    ownsSchema = true;
    if (options.signal?.aborted) throw new ImageGenerationError("이미지 생성이 취소되었습니다.");
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const args = [
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "-C", options.cwd, "-s", "workspace-write",
    ];
    if (requestedModel) args.push("-m", requestedModel);
    args.push("--output-schema", schemaPath, "-");
    if (options.referencePaths.length > 0) args.push("-i", ...options.referencePaths);
    const run = await runProcess(CODEX, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs,
      stdin: buildCodexPrompt(options.part, options.prompt, options.outputPath, referenceNames),
    });
    const summary = summarizeCodexJsonl(run.stdout);
    if (run.exitCode !== 0 || !summary.turnCompleted || summary.turnFailed || summary.fatalErrorCount > 0) {
      safeDiagnostic({ diagnosticId, stage: "tool", exitCode: run.exitCode, startedAt, summary });
      throw diagnosticMessage(unavailableMessage(summary,
        "Codex 이미지 생성이 완료되지 않았습니다."), diagnosticId);
    }
    try {
      return await validateGeneratedPng(options.cwd, options.outputPath, options.signal);
    } catch (error) {
      if (!(error instanceof GeneratedPngAccessError) || error.code !== "ENOENT") {
        safeDiagnostic({
          diagnosticId, stage: error instanceof GeneratedPngAccessError ? "file-access" : "validation",
          exitCode: run.exitCode, startedAt, summary,
          fileCode: error instanceof GeneratedPngAccessError ? error.code : undefined,
        });
        if (error instanceof ImageGenerationError && /취소되었습니다/.test(error.message)) throw error;
        throw diagnosticMessage(error instanceof ImageGenerationError ? error.message : "생성 이미지 검증에 실패했습니다.", diagnosticId);
      }
    }
    if (!summary.threadId || summary.eventCounts.threadStarted !== 1
        || summary.invalidThreadId || summary.conflictingThreadIds || summary.eventCounts.malformed > 0) {
      safeDiagnostic({ diagnosticId, stage: "thread-id-unusable", exitCode: run.exitCode, startedAt, summary });
      throw diagnosticMessage(unavailableMessage(summary, "Codex가 이미지 파일을 만들지 않았습니다."), diagnosticId);
    }
    try {
      await recoverCodexThreadArtifact({
        codexHome,
        threadId: summary.threadId,
        outputPath: options.outputPath,
        startedAt,
        maxBytes: MAX_IMAGE_BYTES,
        signal: options.signal,
      });
      return await validateGeneratedPng(options.cwd, options.outputPath, options.signal);
    } catch (error) {
      if (error instanceof ArtifactRecoveryError) {
        if (error.kind === "cancelled") throw new ImageGenerationError("이미지 생성이 취소되었습니다.");
        safeDiagnostic({
          diagnosticId,
          stage: error.kind === "missing"
            ? error.safeLocation === "root" ? "artifact-root-missing"
              : error.safeLocation === "thread-directory" ? "artifact-thread-directory-missing"
                : "artifact-empty-directory"
            : error.kind === "access" ? "artifact-access" : `artifact-${error.kind}`,
          exitCode: run.exitCode,
          startedAt,
          summary,
          fileCode: error.safeCode,
        });
        if (error.kind === "access") {
          throw diagnosticMessage("Codex 이미지 결과 파일에 접근할 수 없습니다.", diagnosticId);
        }
        if (error.kind === "ambiguous") {
          throw diagnosticMessage("Codex 이미지 결과가 여러 개여서 안전하게 선택할 수 없습니다.", diagnosticId);
        }
        if (error.kind === "invalid") {
          throw diagnosticMessage("Codex 이미지 결과 파일이 안전한 PNG 조건을 충족하지 않습니다.", diagnosticId);
        }
        throw diagnosticMessage(unavailableMessage(summary, "Codex가 이미지 파일을 만들지 않았습니다."), diagnosticId);
      }
      safeDiagnostic({ diagnosticId, stage: "recovered-validation", exitCode: run.exitCode, startedAt, summary });
      if (error instanceof ImageGenerationError && /취소되었습니다/.test(error.message)) throw error;
      throw diagnosticMessage(error instanceof ImageGenerationError ? error.message : "복구한 이미지 검증에 실패했습니다.", diagnosticId);
    }
  } finally {
    if (ownsSchema) await fs.unlink(schemaPath).catch(() => undefined);
  }
}

/** CLI의 성공 문구를 신뢰하지 않는다. 새 출력 파일의 경로·크기·디코딩을 검증한다. */
export async function validateGeneratedPng(
  cwd: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const cwdReal = await fs.realpath(cwd);
  const expected = path.join(cwdReal, "generated.png");
  const outputDirectory = await fs.realpath(path.dirname(outputPath));
  if (path.basename(outputPath) !== "generated.png" || outputDirectory !== cwdReal) {
    throw new ImageGenerationError("출력 경로가 올바르지 않습니다.");
  }
  let stat;
  try { stat = await fs.lstat(expected); } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : undefined;
    throw new GeneratedPngAccessError(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > MAX_IMAGE_BYTES) {
    throw new ImageGenerationError("생성 이미지의 파일 형식 또는 크기가 올바르지 않습니다.");
  }
  if (await fs.realpath(expected) !== expected) throw new ImageGenerationError("이미지 경로가 올바르지 않습니다.");
  const handle = await fs.open(expected, "r");
  const signature = Buffer.alloc(8);
  try { await handle.read(signature, 0, 8, 0); } finally { await handle.close(); }
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new ImageGenerationError("생성 결과가 PNG 이미지가 아닙니다.");
  }
  const probe = await runProcess(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
    "-of", "json", expected,
  ], { signal, timeoutMs: 15_000, outputLimit: 4096 });
  if (probe.exitCode !== 0) throw new ImageGenerationError("생성 이미지를 읽을 수 없습니다.");
  let codec: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const parsed = JSON.parse(probe.stdout) as { streams?: { codec_name?: string; width?: number; height?: number }[] };
    ({ codec_name: codec, width, height } = parsed.streams?.[0] ?? {});
  } catch { throw new ImageGenerationError("생성 이미지의 크기를 확인할 수 없습니다."); }
  if (codec !== "png" || !width || !height || width < 256 || height < 256
    || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new ImageGenerationError("생성 이미지의 형식 또는 해상도가 올바르지 않습니다.");
  }
  const decode = await runProcess(FFMPEG, ["-v", "error", "-i", expected, "-frames:v", "1", "-f", "null", "-"], {
    signal, timeoutMs: 20_000, outputLimit: 1024,
  });
  if (decode.exitCode !== 0) throw new ImageGenerationError("생성 이미지 디코딩에 실패했습니다.");
  return { width, height };
}

/** 경로가 겹치지 않는 격리 임시 공간을 만든다. 호출자가 finally에서 제거한다. */
export async function createImageWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `cdstudio-image-${randomUUID()}-`));
}
