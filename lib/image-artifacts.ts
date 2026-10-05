import { constants as fsConstants, promises as fs } from "fs";
import path from "path";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ArtifactRecoveryKind = "missing" | "ambiguous" | "invalid" | "access" | "cancelled";
export type ArtifactRecoveryLocation = "root" | "thread-directory" | "thread-files";

export type CodexImageResult = {
  status: "success" | "failed";
  reason: "none" | "tool_unavailable" | "tool_error" | "request_refused" | "moderation_blocked" | "copy_failed" | "unknown";
  explanation?: string;
};

export class ArtifactRecoveryError extends Error {
  constructor(public readonly kind: ArtifactRecoveryKind, public readonly safeCode?: string,
    public readonly safeLocation?: ArtifactRecoveryLocation) {
    super(kind);
  }
}

export interface CodexJsonlSummary {
  threadId?: string;
  invalidThreadId: boolean;
  conflictingThreadIds: boolean;
  turnCompleted: boolean;
  turnFailed: boolean;
  fatalErrorCount: number;
  eventCounts: {
    threadStarted: number;
    turnCompleted: number;
    turnFailed: number;
    fatalError: number;
    itemCompleted: number;
    malformed: number;
    other: number;
  };
  failedItemTypes: {
    commandExecution: number;
    fileChange: number;
    mcpToolCall: number;
    error: number;
    unknown: number;
  };
  completedItemTypes: {
    agentMessage: number; reasoning: number; commandExecution: number; fileChange: number;
    mcpToolCall: number; imageGeneration: number; unknown: number;
  };
  imageResult?: CodexImageResult;
}

function emptySummary(): CodexJsonlSummary {
  return {
    invalidThreadId: false,
    conflictingThreadIds: false,
    turnCompleted: false,
    turnFailed: false,
    fatalErrorCount: 0,
    eventCounts: {
      threadStarted: 0, turnCompleted: 0, turnFailed: 0,
      fatalError: 0, itemCompleted: 0, malformed: 0, other: 0,
    },
    failedItemTypes: { commandExecution: 0, fileChange: 0, mcpToolCall: 0, error: 0, unknown: 0 },
    completedItemTypes: { agentMessage: 0, reasoning: 0, commandExecution: 0, fileChange: 0,
      mcpToolCall: 0, imageGeneration: 0, unknown: 0 },
  };
}

/** Parse only documented top-level JSONL fields. Free-form agent text is deliberately ignored. */
export function summarizeCodexJsonl(stdout: string): CodexJsonlSummary {
  const summary = emptySummary();
  let lastAgentMessage: string | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { summary.eventCounts.malformed += 1; continue; }
    if (!event || typeof event !== "object") { summary.eventCounts.other += 1; continue; }
    const record = event as Record<string, unknown>;
    if (record.type === "thread.started") {
      summary.eventCounts.threadStarted += 1;
      if (typeof record.thread_id !== "string" || !UUID_PATTERN.test(record.thread_id)) {
        summary.invalidThreadId = true;
      } else if (summary.threadId && summary.threadId !== record.thread_id) {
        summary.conflictingThreadIds = true;
      } else {
        summary.threadId = record.thread_id;
      }
    } else if (record.type === "turn.completed") {
      summary.eventCounts.turnCompleted += 1;
      summary.turnCompleted = true;
    } else if (record.type === "turn.failed") {
      summary.eventCounts.turnFailed += 1;
      summary.turnFailed = true;
    } else if (record.type === "error") {
      summary.eventCounts.fatalError += 1;
      summary.fatalErrorCount += 1;
    } else if (record.type === "item.completed") {
      summary.eventCounts.itemCompleted += 1;
      const item = record.item && typeof record.item === "object"
        ? record.item as Record<string, unknown> : undefined;
      if (item?.type === "agent_message") {
        summary.completedItemTypes.agentMessage += 1;
        lastAgentMessage = typeof item.text === "string" && Buffer.byteLength(item.text, "utf8") <= 4096
          ? item.text : undefined;
      } else if (item?.type === "reasoning") summary.completedItemTypes.reasoning += 1;
      else if (item?.type === "command_execution") summary.completedItemTypes.commandExecution += 1;
      else if (item?.type === "file_change") summary.completedItemTypes.fileChange += 1;
      else if (item?.type === "mcp_tool_call") summary.completedItemTypes.mcpToolCall += 1;
      else if (item?.type === "image_generation") summary.completedItemTypes.imageGeneration += 1;
      else summary.completedItemTypes.unknown += 1;
      if (item && (item.status === "failed" || item.type === "error"
        || (item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0)
        || (item.type === "mcp_tool_call" && item.error != null))) {
        if (item.type === "command_execution") summary.failedItemTypes.commandExecution += 1;
        else if (item.type === "file_change") summary.failedItemTypes.fileChange += 1;
        else if (item.type === "mcp_tool_call") summary.failedItemTypes.mcpToolCall += 1;
        else if (item.type === "error") summary.failedItemTypes.error += 1;
        else summary.failedItemTypes.unknown += 1;
      }
    } else {
      summary.eventCounts.other += 1;
    }
  }
  if (lastAgentMessage !== undefined) {
    try {
      const value = JSON.parse(lastAgentMessage) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const reasons = ["none", "tool_unavailable", "tool_error", "request_refused", "moderation_blocked", "copy_failed", "unknown"];
        const exactKeys = (keys.length === 2 && keys[0] === "reason" && keys[1] === "status")
          || (keys.length === 3 && keys[0] === "explanation" && keys[1] === "reason" && keys[2] === "status"
            && typeof record.explanation === "string" && record.explanation.length <= 600
            && Buffer.byteLength(record.explanation, "utf8") <= 2400);
        if (exactKeys
          && (record.status === "success" || record.status === "failed")
          && typeof record.reason === "string" && reasons.includes(record.reason)
          && ((record.status === "success" && record.reason === "none")
            || (record.status === "failed" && record.reason !== "none"))) {
          summary.imageResult = record as CodexImageResult;
        }
      }
    } catch { /* Agent prose and malformed reports are deliberately ignored. */ }
  }
  return summary;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArtifactRecoveryError("cancelled");
}

function errno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

/** Recover exactly one native PNG from the current invocation's observed Codex thread directory. */
export async function recoverCodexThreadArtifact(options: {
  codexHome: string;
  threadId: string;
  outputPath: string;
  startedAt: number;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(options.signal);
  if (!UUID_PATTERN.test(options.threadId)) throw new ArtifactRecoveryError("invalid");

  const artifactRoot = path.resolve(options.codexHome, "generated_images");
  const threadDirectory = path.join(artifactRoot, options.threadId);
  if (path.dirname(threadDirectory) !== artifactRoot) throw new ArtifactRecoveryError("invalid");

  let rootReal: string;
  try {
    const rootStat = await fs.lstat(artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ArtifactRecoveryError("invalid");
  } catch (error) {
    if (error instanceof ArtifactRecoveryError) throw error;
    const code = errno(error);
    throw new ArtifactRecoveryError(code === "ENOENT" ? "missing" : "access", code, "root");
  }
  try { rootReal = await fs.realpath(artifactRoot); } catch (error) {
    const code = errno(error);
    throw new ArtifactRecoveryError(code === "ENOENT" ? "missing" : "access", code, "root");
  }
  let directoryStat;
  try { directoryStat = await fs.lstat(threadDirectory); } catch (error) {
    const code = errno(error);
    throw new ArtifactRecoveryError(code === "ENOENT" ? "missing" : "access", code, "thread-directory");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new ArtifactRecoveryError("invalid");
  let directoryReal: string;
  try { directoryReal = await fs.realpath(threadDirectory); } catch (error) {
    throw new ArtifactRecoveryError("access", errno(error));
  }
  if (directoryReal !== path.join(rootReal, options.threadId)) throw new ArtifactRecoveryError("invalid");

  let entries;
  try { entries = await fs.readdir(directoryReal, { withFileTypes: true }); } catch (error) {
    throw new ArtifactRecoveryError("access", errno(error));
  }
  const pngEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".png"));
  if (pngEntries.length === 0) throw new ArtifactRecoveryError("missing", undefined, "thread-files");
  if (pngEntries.length !== 1) throw new ArtifactRecoveryError("ambiguous");
  const entry = pngEntries[0];
  if (!entry.isFile() || entry.isSymbolicLink()
    || !/^exec-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i.test(entry.name)) {
    throw new ArtifactRecoveryError("invalid");
  }

  const sourcePath = path.join(directoryReal, entry.name);
  let before;
  try { before = await fs.lstat(sourcePath); } catch (error) {
    throw new ArtifactRecoveryError("access", errno(error));
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 100 || before.size > options.maxBytes) {
    throw new ArtifactRecoveryError("invalid");
  }
  const freshnessFloor = options.startedAt - 2_000;
  if (before.mtimeMs < freshnessFloor || (before.birthtimeMs > 0 && before.birthtimeMs < freshnessFloor)) {
    throw new ArtifactRecoveryError("invalid");
  }

  let handle;
  try {
    handle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new ArtifactRecoveryError("access", errno(error));
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size < 100 || opened.size > options.maxBytes) {
      throw new ArtifactRecoveryError("invalid");
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, opened.size);
    if (offset !== opened.size || extraBytes !== 0 || !contents.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new ArtifactRecoveryError("invalid");
    }
    throwIfAborted(options.signal);
    try { await fs.writeFile(options.outputPath, contents, { flag: "wx", mode: 0o600 }); } catch (error) {
      throw new ArtifactRecoveryError("access", errno(error));
    }
    if (options.signal?.aborted) {
      await fs.unlink(options.outputPath).catch(() => undefined);
      throw new ArtifactRecoveryError("cancelled");
    }
  } finally {
    await handle.close();
  }
}
