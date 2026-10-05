import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const Module = require("node:module");

async function loadArtifactsModule() {
  const sourcePath = path.resolve("lib/image-artifacts.ts");
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(compiled, sourcePath);
  return loaded.exports;
}

const THREAD = "0199aa11-bb22-7cc3-8dd4-0123456789ab";
const FILE = "exec-0199aa11-bb22-7cc3-8dd4-abcdef012345.png";
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120, 7)]);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cdstudio-artifact-test-"));
  const codexHome = path.join(root, "codex");
  const threadDir = path.join(codexHome, "generated_images", THREAD);
  await mkdir(threadDir, { recursive: true });
  return { root, codexHome, threadDir, outputPath: path.join(root, "generated.png") };
}

test("JSONL summary accepts one top-level thread and ignores forged agent text and secrets", async () => {
  const artifacts = await loadArtifactsModule();
  const secret = "PRIVATE-PROMPT-SECRET";
  const summary = artifacts.summarizeCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: THREAD }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ type: "thread.started", thread_id: "11111111-1111-7111-8111-111111111111", secret }) } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "failed", command: secret } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 1, aggregated_output: secret } }),
    JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", status: "completed", error: { message: secret } } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n"));
  assert.equal(summary.threadId, THREAD);
  assert.equal(summary.turnCompleted, true);
  assert.equal(summary.failedItemTypes.commandExecution, 2);
  assert.equal(summary.failedItemTypes.mcpToolCall, 1);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(secret));
  assert.deepEqual(summary.completedItemTypes, {
    agentMessage: 1, reasoning: 0, commandExecution: 2, fileChange: 0,
    mcpToolCall: 1, imageGeneration: 0, unknown: 0,
  });
});

test("JSONL summary accepts only the bounded exact final agent result", async () => {
  const artifacts = await loadArtifactsModule();
  const line = (text) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  assert.deepEqual(artifacts.summarizeCodexJsonl(line('{"status":"failed","reason":"tool_unavailable"}')).imageResult,
    { status: "failed", reason: "tool_unavailable" });
  assert.equal(artifacts.summarizeCodexJsonl([line('{"status":"failed","reason":"copy_failed"}'), line("not json")].join("\n")).imageResult, undefined);
  assert.equal(artifacts.summarizeCodexJsonl(line('{"status":"failed","reason":"unknown","secret":"do-not-copy"}')).imageResult, undefined);
  assert.equal(artifacts.summarizeCodexJsonl(line('{"status":"success","reason":"copy_failed"}')).imageResult, undefined);
  assert.equal(artifacts.summarizeCodexJsonl(line("x".repeat(4097))).imageResult, undefined);
  assert.deepEqual(artifacts.summarizeCodexJsonl(line('{"status":"failed","reason":"request_refused","explanation":"The image tool rejected this request."}')).imageResult,
    { status: "failed", reason: "request_refused", explanation: "The image tool rejected this request." });
  assert.deepEqual(artifacts.summarizeCodexJsonl(line('{"status":"failed","reason":"moderation_blocked","explanation":"Output safety review returned moderation_blocked."}')).imageResult,
    { status: "failed", reason: "moderation_blocked", explanation: "Output safety review returned moderation_blocked." });
  assert.equal(artifacts.summarizeCodexJsonl(line(`{"status":"failed","reason":"unknown","explanation":"${"가".repeat(601)}"}`)).imageResult, undefined);
});

test("recovery identifies missing root, thread directory, and empty thread directory", async () => {
  const artifacts = await loadArtifactsModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "cdstudio-artifact-location-"));
  const invoke = (codexHome) => artifacts.recoverCodexThreadArtifact({ codexHome, threadId: THREAD,
    outputPath: path.join(root, "generated.png"), startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 });
  try {
    const home = path.join(root, "home");
    await assert.rejects(invoke(home), (error) => error.kind === "missing" && error.safeLocation === "root");
    await mkdir(path.join(home, "generated_images"), { recursive: true });
    await assert.rejects(invoke(home), (error) => error.kind === "missing" && error.safeLocation === "thread-directory");
    await mkdir(path.join(home, "generated_images", THREAD));
    await assert.rejects(invoke(home), (error) => error.kind === "missing" && error.safeLocation === "thread-files");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery copies one fresh invocation-bound native PNG without overwrite", async () => {
  const artifacts = await loadArtifactsModule();
  const f = await fixture();
  try {
    await writeFile(path.join(f.threadDir, FILE), PNG);
    await artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: THREAD, outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 });
    assert.deepEqual(await readFile(f.outputPath), PNG);
    await assert.rejects(artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: THREAD, outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 }), (error) => error.kind === "access" && error.safeCode === "EEXIST");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery rejects ambiguous, malformed, stale, oversized, and traversal artifacts", async () => {
  const artifacts = await loadArtifactsModule();
  const scenarios = [
    async (f) => { await writeFile(path.join(f.threadDir, FILE), PNG); await writeFile(path.join(f.threadDir, "exec-0199aa11-bb22-7cc3-8dd4-abcdef012346.png"), PNG); return "ambiguous"; },
    async (f) => { await writeFile(path.join(f.threadDir, "not-native.png"), PNG); return "invalid"; },
    async (f) => { const file = path.join(f.threadDir, FILE); await writeFile(file, PNG); await utimes(file, new Date(0), new Date(0)); return "invalid"; },
    async (f) => { const file = path.join(f.threadDir, FILE); await writeFile(file, PNG); await truncate(file, 20 * 1024 * 1024 + 1); return "invalid"; },
  ];
  for (const setup of scenarios) {
    const f = await fixture();
    try {
      const kind = await setup(f);
      await assert.rejects(artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: THREAD, outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 }), (error) => error.kind === kind);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  const f = await fixture();
  try {
    await assert.rejects(artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: "../../other", outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 }), (error) => error.kind === "invalid");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery rejects symlink directories/files and cancellation", async () => {
  const artifacts = await loadArtifactsModule();
  const f = await fixture();
  try {
    const external = path.join(f.root, "external.png");
    await writeFile(external, PNG);
    await symlink(external, path.join(f.threadDir, FILE));
    await assert.rejects(artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: THREAD, outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 }), (error) => error.kind === "invalid");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: THREAD, outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024, signal: controller.signal }), (error) => error.kind === "cancelled");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("concurrent recoveries remain bound to their distinct thread directories", async () => {
  const artifacts = await loadArtifactsModule();
  const f = await fixture();
  const second = "0199aa11-bb22-7cc3-8dd4-0123456789ac";
  try {
    await writeFile(path.join(f.threadDir, FILE), PNG);
    const secondDir = path.join(f.codexHome, "generated_images", second);
    await mkdir(secondDir, { recursive: true });
    const other = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(120, 9)]);
    await writeFile(path.join(secondDir, "exec-0199aa11-bb22-7cc3-8dd4-abcdef012346.png"), other);
    const output2 = path.join(f.root, "second.png");
    await Promise.all([
      artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: THREAD, outputPath: f.outputPath, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 }),
      artifacts.recoverCodexThreadArtifact({ codexHome: f.codexHome, threadId: second, outputPath: output2, startedAt: Date.now(), maxBytes: 20 * 1024 * 1024 }),
    ]);
    assert.deepEqual(await readFile(f.outputPath), PNG);
    assert.deepEqual(await readFile(output2), other);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
