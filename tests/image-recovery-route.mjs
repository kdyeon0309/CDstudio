import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const Module = require("node:module");
const PROJECT = "10000000-0000-4000-8000-000000000001";

async function compileModule(filename, mocks) {
  const sourcePath = path.resolve(filename);
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const normalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : normalRequire(id);
  loaded._compile(compiled, sourcePath);
  return loaded.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(read, predicate, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeChild(stdout, gate = Promise.resolve(), waitForStdin = false) {
  const child = new EventEmitter();
  // No OS pid: cancellation must call this fake child's kill(), not signal a real process group.
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
  const finish = async () => {
    await gate;
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit("close", 0);
  };
  if (waitForStdin) child.stdin.on("finish", finish);
  else queueMicrotask(finish);
  return child;
}

async function harness(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cdstudio-image-recovery-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const codexHome = path.join(temp, "codex-home");
  const assets = path.join(temp, "assets");
  await mkdir(assets, { recursive: true });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });

  const threadIds = [
    "30000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002",
    "30000000-0000-4000-8000-000000000003",
  ];
  const execIds = [
    "40000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000003",
  ];
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(248, 7)]);
  const sources = [];
  for (let index = 0; index < threadIds.length; index += 1) {
    const dir = path.join(codexHome, "generated_images", threadIds[index]);
    await mkdir(dir, { recursive: true });
    const source = path.join(dir, `exec-${execIds[index]}.png`);
    await writeFile(source, png);
    sources.push(source);
  }

  const execGates = [deferred(), deferred(), deferred()];
  t.after(() => execGates.forEach((gate) => gate.resolve()));
  let execCall = 0;
  const spawn = (_command, args) => {
    if (args[0] === "login") return fakeChild("Logged in using ChatGPT\n");
    if (args[0] === "exec") {
      const index = execCall++;
      return fakeChild(`${JSON.stringify({ type: "thread.started", thread_id: threadIds[index] })}\n${JSON.stringify({ type: "turn.completed" })}\n`, execGates[index].promise, true);
    }
    if (args.includes("stream=codec_name,width,height")) {
      return fakeChild(JSON.stringify({ streams: [{ codec_name: "png", width: 512, height: 512 }] }));
    }
    return fakeChild("");
  };
  const artifacts = await compileModule("lib/image-artifacts.ts", {});
  const imageGeneration = await compileModule("lib/image-generation.ts", {
    child_process: { spawn },
    "./types": { STUDIO_PART_LABELS: { front: "앞표지", back: "뒷표지", label: "라벨" } },
    "./image-artifacts": artifacts,
  });
  const candidates = { front: [], back: [], label: [] };
  let project = { id: PROJECT, title: "Recovery", tracks: [], status: "draft" };
  class StudioError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const released = [];
  const route = await compileModule("app/api/design/image/route.ts", {
    "@/lib/storage": { assetsDir: () => assets, getProject: async () => project },
    "@/lib/server-guards": { rejectCrossOrigin: () => null, releaseJobLock: (...args) => released.push(args) },
    "@/lib/studio": {
      appendStudioCandidate: async (_id, part, candidate) => {
        candidates[part].push(candidate);
        project = { ...project, studio: { parts: candidates } };
        return project;
      },
      getStudioPart: (_project, part) => ({ candidates: candidates[part] }),
      isArtworkPart: (value) => ["front", "back", "label"].includes(value),
      MAX_STUDIO_BODY_BYTES: 1024 * 1024, MAX_STUDIO_CANDIDATES: 50, StudioError,
      validateStudioReferenceFiles: async (_id, files) => files,
      validateStudioReferenceLabels: () => ({}),
    },
    "@/lib/image-generation": imageGeneration,
    "../shared": {
      acquireDesignPartLock: (_id, part) => ({ key: `design:${part}`, token: `lock-${part}` }),
      designPartBusyResponse: () => Response.json({ error: "busy" }, { status: 409 }),
    },
  });
  const registryModule = await compileModule("lib/background-jobs.ts", {
    "next/server": { NextRequest: Request },
    "@/app/api/design/image/route": { POST: route.POST },
    "@/app/api/extract/route": { POST: route.POST },
    "@/app/api/design/route": { POST: route.POST },
    "@/app/api/design/refine/route": { POST: route.POST },
    "@/app/api/design/part/route": { POST: route.POST },
    "./types": { ARTWORK_PARTS: ["front","back","label"], STUDIO_ARTWORK_PARTS: ["front","back","label"] },
    "./background-job-types": {},
  });
  const registry = new registryModule.BackgroundJobRegistry(Object.fromEntries([
    "/api/design/image", "/api/extract", "/api/design", "/api/design/refine", "/api/design/part",
  ].map((endpoint) => [endpoint, route.POST])));
  return {
    assets, candidates, execGates, registry, released, sources,
    getExecCount: () => execCall,
  };
}

function start(registry, part) {
  return registry.start({ endpoint: "/api/design/image", projectId: PROJECT, part,
    input: { projectId: PROJECT, part, prompt: `make ${part}`, referenceFiles: [], referenceLabels: {} } });
}

test("actual route recovers native PNG after successful CLI omits workspace copy and persists it", async (t) => {
  const h = await harness(t);
  const result = start(h.registry, "front");
  assert.equal(result.ok, true);
  h.execGates[0].resolve();
  await eventually(() => h.registry.get(PROJECT, result.job.id), (job) => job?.status === "success");
  assert.equal(h.candidates.front.length, 1);
  const saved = await readFile(path.join(h.assets, h.candidates.front[0].filename));
  assert.equal(saved.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await stat(h.sources[0])).isFile(), true, "native artifact remains intact");
});

test("parallel parts complete in reverse order while cancellation never registers a candidate", async (t) => {
  const h = await harness(t);
  const front = start(h.registry, "front");
  await eventually(h.getExecCount, (count) => count >= 1);
  const back = start(h.registry, "back");
  await eventually(h.getExecCount, (count) => count >= 2);
  const label = start(h.registry, "label");
  h.registry.cancel(PROJECT, label.job.id);
  assert.equal(h.registry.get(PROJECT, label.job.id).status, "running", "lock remains until cleanup");
  h.execGates[2].resolve();
  h.execGates[1].resolve();
  await eventually(() => h.registry.get(PROJECT, back.job.id), (job) => job?.status === "success");
  h.execGates[0].resolve();
  await eventually(() => h.registry.get(PROJECT, front.job.id), (job) => job?.status === "success");
  await eventually(() => h.registry.get(PROJECT, label.job.id), (job) => job?.status === "cancelled");
  assert.deepEqual([h.candidates.front.length, h.candidates.back.length, h.candidates.label.length], [1, 1, 0]);
  assert.equal((await stat(h.sources[0])).isFile(), true);
  assert.equal((await stat(h.sources[1])).isFile(), true);
  assert.equal((await stat(h.sources[2])).isFile(), true);
});
