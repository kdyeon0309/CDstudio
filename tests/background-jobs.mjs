import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const Module = require("node:module");

const PROJECT_A = "10000000-0000-4000-8000-000000000001";
const PROJECT_B = "10000000-0000-4000-8000-000000000002";
const CLIENT_A = "20000000-0000-4000-8000-000000000001";
const ENDPOINTS = [
  "/api/design/image",
  "/api/extract",
  "/api/design",
  "/api/design/refine",
  "/api/design/part",
];

class TestNextRequest extends Request {
  constructor(input, init) {
    super(input, init);
    this.nextUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  }
}

async function compileModule(filename, mocks) {
  const sourcePath = path.resolve(filename);
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const normalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : normalRequire(id);
  loaded._compile(compiled, sourcePath);
  return loaded.exports;
}

function defaultRouteMocks(post = async () => Response.json({ error: "unused" }, { status: 500 })) {
  return {
    "next/server": { NextRequest: TestNextRequest },
    "@/app/api/design/image/route": { POST: post },
    "@/app/api/extract/route": { POST: post },
    "@/app/api/design/route": { POST: post },
    "@/app/api/design/refine/route": { POST: post },
    "@/app/api/design/part/route": { POST: post },
    "./types": {
      ARTWORK_PARTS: ["front", "front-inner", "label", "back", "back-inner"],
      STUDIO_ARTWORK_PARTS: ["front", "front-inner", "label", "back", "back-spine", "back-inner"],
    },
    "./background-job-types": {},
  };
}

async function loadRegistryModule(post) {
  return compileModule("lib/background-jobs.ts", defaultRouteMocks(post));
}

function handlers(handler) {
  return Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, handler]));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for background job");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sseResponse(chunks, gate = Promise.resolve()) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      await gate;
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("creator disconnect is irrelevant; reconnect sees chunked events and success only after route EOF", async () => {
  const registryModule = await loadRegistryModule();
  const releaseEvents = deferred();
  const releaseCleanup = deferred();
  let saved = false;
  const handler = async () => new Response(new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      await releaseEvents.promise;
      controller.enqueue(encoder.encode(": keep-alive\r\n\r\ndata: {\"type\":\"status\",\"message\":\"생성 중\"}\r"));
      controller.enqueue(encoder.encode("\n\r\ndata: {\"type\":\"done\",\"candidate\":{\"id\":\"saved\"},\"project\":{}}\r\n\r\n"));
      saved = true;
      await releaseCleanup.promise;
      controller.close();
    },
  }));
  const registry = new registryModule.BackgroundJobRegistry(handlers(handler));
  const created = registry.start({
    endpoint: "/api/design/image", projectId: PROJECT_A, part: "front",
    input: { projectId: PROJECT_A, part: "front", prompt: "private prompt" },
  });
  assert.equal(created.ok, true);
  assert.equal(created.job.status, "running");
  assert.equal("input" in created.job, false, "public snapshot omits raw input");
  assert.equal("controller" in created.job, false);
  assert.equal(registry.list(PROJECT_A)[0].status, "running", "a new observer can reconnect");
  releaseEvents.resolve();
  await eventually(() => registry.get(PROJECT_A, created.job.id), (job) => job?.events.some((entry) => entry.event.type === "done"));
  assert.equal(saved, true);
  assert.equal(registry.get(PROJECT_A, created.job.id).status, "running", "done is not terminal before stream cleanup");
  releaseCleanup.resolve();
  const finished = await eventually(() => registry.get(PROJECT_A, created.job.id), (job) => job?.status === "success");
  assert.deepEqual(finished.events.map((entry) => entry.seq), [1, 2]);
});

test("explicit cancellation owns the signal and keeps duplicate gate through async preflight cleanup", async () => {
  const registryModule = await loadRegistryModule();
  const preflight = deferred();
  let signal;
  const handler = async (request) => {
    signal = request.signal;
    await preflight.promise;
    if (request.signal.aborted) return Response.json({ error: "요청이 취소되었습니다." }, { status: 499 });
    return sseResponse(["data: {\"type\":\"done\",\"artwork\":{}}\n\n"]);
  };
  const registry = new registryModule.BackgroundJobRegistry(handlers(handler));
  const first = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  assert.equal(first.ok, true);
  const cancelled = registry.cancel(PROJECT_A, first.job.id);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(signal.aborted, true);
  assert.equal(registry.get(PROJECT_A, first.job.id).status, "running");
  assert.equal(registry.start({ endpoint: "/api/design/part", projectId: PROJECT_A, part: "front", input: { projectId: PROJECT_A, part: "front" } }).ok, false);
  preflight.resolve();
  await eventually(() => registry.get(PROJECT_A, first.job.id), (job) => job?.status === "cancelled");
  assert.equal(registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } }).ok, true);
});

test("legacy stream cancelled during preflight skips execution and releases its lock", async () => {
  const released = [];
  const { designSseResponse } = await compileModule("app/api/design/stream.ts", {
    "@/lib/server-guards": { releaseJobLock: (...args) => released.push(args) },
  });
  const controller = new AbortController();
  controller.abort();
  const request = new TestNextRequest("http://localhost/api/design", { signal: controller.signal });
  let runs = 0;
  const response = designSseResponse(request, { key: "design:test", token: "owner" }, async () => { runs += 1; });
  assert.equal(await response.text(), "");
  assert.equal(runs, 0, "already-cancelled preflight must not start the CLI");
  assert.deepEqual(released, [["design:test", "owner"]]);
});

test("studio parts run in parallel while same-part and album-global design jobs conflict", async () => {
  const registryModule = await loadRegistryModule();
  const gate = deferred();
  const handler = async () => sseResponse(["data: {\"type\":\"done\",\"project\":{},\"candidate\":{}}\n\n"], gate.promise);
  const registry = new registryModule.BackgroundJobRegistry(handlers(handler));
  const front = registry.start({ endpoint: "/api/design/image", projectId: PROJECT_A, part: "front", input: { projectId: PROJECT_A, part: "front" } });
  assert.equal(front.ok, true);
  assert.equal(registry.start({ endpoint: "/api/design/image", projectId: PROJECT_A, part: "front", input: { projectId: PROJECT_A, part: "front" } }).ok, false);
  assert.equal(registry.start({ endpoint: "/api/design/image", projectId: PROJECT_A, part: "back", input: { projectId: PROJECT_A, part: "back" } }).ok, true);
  assert.equal(registry.start({ endpoint: "/api/design/refine", projectId: PROJECT_A, input: { projectId: PROJECT_A } }).ok, false);
  const extract = registry.start({ endpoint: "/api/extract", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  assert.equal(extract.ok, true, "audio has an independent album gate");
  assert.equal(registry.start({ endpoint: "/api/extract", projectId: PROJECT_A, input: { projectId: PROJECT_A } }).ok, false);
  assert.equal(registry.start({ endpoint: "/api/design", projectId: PROJECT_B, input: { projectId: PROJECT_B } }).ok, true, "other albums are isolated");
  gate.resolve();
});

test("clientJobId retries deduplicate exact requests and reject cross-job reuse", async () => {
  const registryModule = await loadRegistryModule();
  const gate = deferred();
  const registry = new registryModule.BackgroundJobRegistry(handlers(async () => sseResponse([
    "data: {\"type\":\"done\",\"artwork\":{}}\n\n",
  ], gate.promise)));
  const input = { projectId: PROJECT_A };
  const first = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input, clientJobId: CLIENT_A });
  const retry = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input, clientJobId: CLIENT_A });
  assert.equal(first.ok && retry.ok, true);
  assert.equal(retry.reused, true);
  assert.equal(retry.job.id, first.job.id);
  const misuse = registry.start({ endpoint: "/api/extract", projectId: PROJECT_A, input, clientJobId: CLIENT_A });
  assert.deepEqual(misuse, { ok: false, status: 409, error: "같은 clientJobId가 다른 작업에 사용되었습니다." });
  gate.resolve();
});

test("latest list prefers a new running job when timestamps tie", async () => {
  const registryModule = await loadRegistryModule();
  const gates = [deferred(), deferred()];
  let call = 0;
  const registry = new registryModule.BackgroundJobRegistry(handlers(async () => sseResponse([
    "data: {\"type\":\"done\",\"artwork\":{}}\n\n",
  ], gates[call++].promise)), () => 10_000);
  const older = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  gates[0].resolve();
  await eventually(() => registry.get(PROJECT_A, older.job.id), (job) => job?.status === "success");
  const newer = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  assert.equal(registry.list(PROJECT_A)[0].id, newer.job.id);
  assert.equal(registry.list(PROJECT_A)[0].status, "running");
  gates[1].resolve();
});

test("latest terminal replaces an older terminal even when statuses differ", async () => {
  const registryModule = await loadRegistryModule();
  let call = 0;
  const responses = [
    "data: {\"type\":\"done\",\"artwork\":{}}\n\n",
    "data: {\"type\":\"error\",\"message\":\"later failure\"}\n\n",
  ];
  const registry = new registryModule.BackgroundJobRegistry(handlers(async () => sseResponse([responses[call++]])), () => 10_000);
  const first = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  await eventually(() => registry.get(PROJECT_A, first.job.id), (job) => job?.status === "success");
  const second = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  await eventually(() => registry.get(PROJECT_A, second.job.id), (job) => job?.status === "error");
  assert.equal(registry.list(PROJECT_A)[0].id, second.job.id);
  assert.equal(registry.list(PROJECT_A)[0].status, "error");
});

test("done wins a late cancel and progress/status logs stay bounded without dropping essentials", async () => {
  const registryModule = await loadRegistryModule();
  const afterDone = deferred();
  const encoder = new TextEncoder();
  const handler = async () => new Response(new ReadableStream({
    async start(controller) {
      for (let index = 0; index < 130; index += 1) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", message: `s${index}` })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", trackId: "t", phase: "download", percent: index })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: {\"type\":\"track-start\",\"trackId\":\"t\",\"title\":\"x\"}\n\n"));
      controller.enqueue(encoder.encode("data: {\"type\":\"done\",\"project\":{}}\n\n"));
      await afterDone.promise;
      controller.close();
    },
  }));
  const registry = new registryModule.BackgroundJobRegistry(handlers(handler));
  const result = registry.start({ endpoint: "/api/extract", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  await eventually(() => registry.get(PROJECT_A, result.job.id), (job) => job?.events.some((entry) => entry.event.type === "done"));
  registry.cancel(PROJECT_A, result.job.id);
  afterDone.resolve();
  const job = await eventually(() => registry.get(PROJECT_A, result.job.id), (value) => value?.status === "success");
  assert.equal(job.status, "success");
  assert.equal(job.events.filter((entry) => entry.event.type === "progress").length, 1);
  assert.ok(job.events.filter((entry) => entry.event.type === "status").length <= 99);
  assert.ok(job.events.some((entry) => entry.event.type === "track-start"));
  assert.ok(job.events.some((entry) => entry.event.type === "done"));
});

test("track results are retained for reconnect and response/preflight failures become job errors", async () => {
  const registryModule = await loadRegistryModule();
  let call = 0;
  const registry = new registryModule.BackgroundJobRegistry(handlers(async () => {
    call += 1;
    if (call === 1) return sseResponse([
      "data: {\"type\":\"track-done\",\"trackId\":\"track-1\",\"track\":{\"id\":\"track-1\",\"title\":\"saved\"}}\n\n",
      "data: {\"type\":\"done\",\"project\":{}}\n\n",
    ]);
    return Response.json({ error: "preflight rejected" }, { status: 400 });
  }));
  const extraction = registry.start({ endpoint: "/api/extract", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  const completed = await eventually(() => registry.get(PROJECT_A, extraction.job.id), (job) => job?.status === "success");
  assert.equal(completed.events.find((entry) => entry.event.type === "track-done").event.track.title, "saved");
  const failed = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  const errorJob = await eventually(() => registry.get(PROJECT_A, failed.job.id), (job) => job?.status === "error");
  assert.equal(errorJob.error, "preflight rejected");
  assert.equal(errorJob.events.at(-1).event.type, "error");
});

test("actual image and extract handlers persist results after the creator has returned", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cdstudio-background-real-routes-"));
  const assets = path.join(temp, "assets");
  const tracks = path.join(temp, "tracks");
  await Promise.all([mkdir(assets), mkdir(tracks)]);
  const imageGate = deferred();
  const extractGate = deferred();
  const candidates = [];
  let project = { id: PROJECT_A, title: "Background", tracks: [], status: "draft" };
  class StudioError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  class ImageGenerationError extends Error {}
  const guards = {
    rejectCrossOrigin: () => null,
    releaseJobLock: () => {},
    acquireJobLock: () => "route-lock",
  };
  try {
    const imageRoute = await compileModule("app/api/design/image/route.ts", {
      "@/lib/storage": { assetsDir: () => assets, getProject: async () => project },
      "@/lib/server-guards": guards,
      "@/lib/studio": {
        appendStudioCandidate: async (_id, _part, candidate) => {
          candidates.push(candidate);
          return { ...project, artworkStudio: { parts: { front: { candidates: [...candidates] } } } };
        },
        getStudioPart: () => ({ candidates }),
        isArtworkPart: (value) => value === "front",
        MAX_STUDIO_BODY_BYTES: 1024 * 1024,
        MAX_STUDIO_CANDIDATES: 50,
        StudioError,
        validateStudioReferenceFiles: async (_id, files) => files,
        validateStudioReferenceLabels: () => ({}),
      },
      "@/lib/image-generation": {
        codexImageAvailability: async () => ({ connected: true, message: "ready" }),
        createImageWorkspace: async () => mkdtemp(path.join(temp, "workspace-")),
        generateCodexImage: async ({ outputPath }) => {
          await imageGate.promise;
          await writeFile(outputPath, "PNG");
          return { width: 1200, height: 1200 };
        },
        ImageGenerationError,
      },
      "../shared": {
        acquireDesignPartLock: (projectId, part) => ({ key: `design:${projectId}:${part}`, token: "route-lock" }),
        designPartBusyResponse: () => Response.json({ error: "busy" }, { status: 409 }),
      },
    });
    const extractRoute = await compileModule("app/api/extract/route.ts", {
      "@/lib/storage": {
        getProject: async () => project,
        updateProjectWith: async (_id, mutate) => { project = mutate(project); return project; },
        tracksDir: () => tracks,
        safeFilename: (value) => value,
      },
      "@/lib/server-guards": guards,
      "@/lib/audio": {
        downloadAudio: async () => {
          await extractGate.promise;
          const file = path.join(tracks, ".source.webm");
          await writeFile(file, "source");
          return file;
        },
        convertToCdWav: async (_source, destination) => writeFile(destination, "wav"),
        probeDuration: async () => 42,
        isAllowedSourceUrl: () => true,
        assertAllowedSourceUrl: () => {},
        AbortError: class AbortError extends Error {},
      },
      "@/lib/extract-contract": { MAX_EXTRACT_ITEMS: 50 },
    });
    const registryModule = await loadRegistryModule();
    const routeHandlers = handlers(async () => { throw new Error("unexpected endpoint"); });
    routeHandlers["/api/design/image"] = imageRoute.POST;
    routeHandlers["/api/extract"] = extractRoute.POST;
    const registry = new registryModule.BackgroundJobRegistry(routeHandlers);

    const image = registry.start({
      endpoint: "/api/design/image", projectId: PROJECT_A, part: "front",
      input: { projectId: PROJECT_A, part: "front", prompt: "persist", referenceFiles: [], referenceLabels: {} },
    });
    assert.equal(image.job.status, "running", "POST facade has already returned to its creator");
    imageGate.resolve();
    await eventually(() => registry.get(PROJECT_A, image.job.id), (job) => job?.status === "success");
    assert.equal(candidates.length, 1);
    await readFile(path.join(assets, candidates[0].filename));

    const extraction = registry.start({
      endpoint: "/api/extract", projectId: PROJECT_A,
      input: { projectId: PROJECT_A, items: [{ sourceUrl: "https://example.test/audio", title: "Saved Track" }] },
    });
    assert.equal(extraction.job.status, "running");
    extractGate.resolve();
    await eventually(() => registry.get(PROJECT_A, extraction.job.id), (job) => job?.status === "success");
    assert.equal(project.tracks.length, 1);
    assert.equal(project.tracks[0].title, "Saved Track");
    await readFile(path.join(tracks, project.tracks[0].filename));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("active-stream cancellation remains running and conflicting until cleanup reaches EOF", async () => {
  const registryModule = await loadRegistryModule();
  const entered = deferred();
  const cleanup = deferred();
  const handler = async (request) => new Response(new ReadableStream({
    start(controller) {
      entered.resolve();
      request.signal.addEventListener("abort", async () => {
        await cleanup.promise;
        controller.close();
      }, { once: true });
    },
  }));
  const registry = new registryModule.BackgroundJobRegistry(handlers(handler));
  const started = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  await entered.promise;
  registry.cancel(PROJECT_A, started.job.id);
  assert.equal(registry.get(PROJECT_A, started.job.id).status, "running");
  assert.equal(registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } }).ok, false);
  cleanup.resolve();
  await eventually(() => registry.get(PROJECT_A, started.job.id), (job) => job?.status === "cancelled");
});

test("malformed or premature SSE EOF is an error", async () => {
  const registryModule = await loadRegistryModule();
  let call = 0;
  const registry = new registryModule.BackgroundJobRegistry(handlers(async () => sseResponse([
    call++ === 0 ? "data: not-json\n\n" : "data: {\"type\":\"status\",\"message\":\"only progress\"}\n\n",
  ])));
  for (let index = 0; index < 2; index += 1) {
    const result = registry.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A, index } });
    const failed = await eventually(() => registry.get(PROJECT_A, result.job.id), (job) => job?.status === "error");
    assert.match(failed.error, /완료 이벤트 없이 종료/);
  }
});

test("terminal retention is capped and expires without ever evicting a running job", async () => {
  const registryModule = await loadRegistryModule();
  const runningGate = deferred();
  let now = 1_000;
  const registry = new registryModule.BackgroundJobRegistry(handlers(async (request) => {
    const input = await request.clone().json();
    return sseResponse(["data: {\"type\":\"done\",\"artwork\":{}}\n\n"],
      input.projectId === "still-running" ? runningGate.promise : Promise.resolve());
  }), () => now);
  const running = registry.start({ endpoint: "/api/design", projectId: "still-running", input: { projectId: "still-running" } });
  const terminalIds = [];
  for (let index = 0; index < 101; index += 1) {
    now += 1;
    const projectId = `terminal-${index}`;
    const result = registry.start({ endpoint: "/api/design", projectId, input: { projectId } });
    terminalIds.push([projectId, result.job.id]);
    await eventually(() => registry.get(projectId, result.job.id), (job) => job?.status === "success");
  }
  assert.equal(registry.get(terminalIds[0][0], terminalIds[0][1]), null, "oldest terminal exceeds max 100");
  assert.equal(registry.get("still-running", running.job.id).status, "running");
  now += 30 * 60 * 1000 + 1;
  assert.equal(registry.get(terminalIds.at(-1)[0], terminalIds.at(-1)[1]), null, "terminal expires after 30 minutes");
  assert.equal(registry.get("still-running", running.job.id).status, "running", "running is never age-evicted");
  runningGate.resolve();
});

test("global registry survives module reevaluation and refreshes only future route handlers", async () => {
  delete globalThis.__cdstudioBackgroundJobRegistry;
  const firstGate = deferred();
  const calls = [];
  const first = await loadRegistryModule(async () => {
    calls.push("v1");
    return sseResponse(["data: {\"type\":\"done\",\"artwork\":{}}\n\n"], firstGate.promise);
  });
  const active = first.backgroundJobs.start({ endpoint: "/api/design", projectId: PROJECT_A, input: { projectId: PROJECT_A } });
  const second = await loadRegistryModule(async () => {
    calls.push("v2");
    return sseResponse(["data: {\"type\":\"done\",\"artwork\":{}}\n\n"]);
  });
  assert.equal(first.backgroundJobs, second.backgroundJobs);
  const future = second.backgroundJobs.start({ endpoint: "/api/design", projectId: PROJECT_B, input: { projectId: PROJECT_B } });
  await eventually(() => second.backgroundJobs.get(PROJECT_B, future.job.id), (job) => job?.status === "success");
  assert.deepEqual(calls, ["v1", "v2"]);
  firstGate.resolve();
  await eventually(() => first.backgroundJobs.get(PROJECT_A, active.job.id), (job) => job?.status === "success");
  delete globalThis.__cdstudioBackgroundJobRegistry;
});

test("jobs route enforces origin, bounded JSON, UUID scope, and exact response shapes", async () => {
  const calls = [];
  const sample = { id: CLIENT_A, endpoint: "/api/design", projectId: PROJECT_A, status: "running", startedAt: 1, cancelRequested: false, events: [] };
  const registry = {
    start(value) { calls.push(["start", value]); return { ok: true, job: sample }; },
    list(id) { calls.push(["list", id]); return [sample]; },
    get(projectId, id) { calls.push(["get", projectId, id]); return projectId === PROJECT_A && id === CLIENT_A ? sample : null; },
    cancel(projectId, id) { calls.push(["cancel", projectId, id]); return projectId === PROJECT_A && id === CLIENT_A ? { ...sample, cancelRequested: true } : null; },
  };
  const route = await compileModule("app/api/jobs/route.ts", {
    "@/lib/background-jobs": {
      backgroundJobs: registry,
      isStudioPart: (value) => ["front", "back"].includes(value),
      isLegacyPart: (value) => ["front", "back"].includes(value),
    },
    "@/lib/background-job-types": { BACKGROUND_JOB_ENDPOINTS: ENDPOINTS },
    "@/lib/server-guards": {
      rejectCrossOrigin: (request) => request.headers.get("origin") === "https://evil.example"
        ? Response.json({ error: "동일 출처 요청만 허용됩니다." }, { status: 403 }) : null,
    },
  });
  const request = (url, init = {}) => new TestNextRequest(url, {
    ...init,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...init.headers },
  });

  const blocked = await route.POST(request("http://localhost/api/jobs", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
  assert.equal((await route.GET(request(`http://localhost/api/jobs?projectId=${PROJECT_A}`, { headers: { origin: "https://evil.example" } }))).status, 403);
  assert.equal((await route.DELETE(request("http://localhost/api/jobs", { method: "DELETE", headers: { origin: "https://evil.example" }, body: "{}" }))).status, 403);
  const malformed = await route.POST(request("http://localhost/api/jobs", { method: "POST", body: "{" }));
  assert.equal(malformed.status, 400);
  const tooLarge = await route.POST(request("http://localhost/api/jobs", { method: "POST", headers: { "content-length": String(1024 * 1024 + 1) }, body: "{}" }));
  assert.equal(tooLarge.status, 413);
  const accepted = await route.POST(request("http://localhost/api/jobs", {
    method: "POST",
    body: JSON.stringify({ endpoint: "/api/design", input: { projectId: PROJECT_A }, clientJobId: CLIENT_A }),
  }));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { job: sample });
  const missingPart = await route.POST(request("http://localhost/api/jobs", {
    method: "POST", body: JSON.stringify({ endpoint: "/api/design/image", input: { projectId: PROJECT_A } }),
  }));
  assert.equal(missingPart.status, 400);
  const listed = await route.GET(request(`http://localhost/api/jobs?projectId=${PROJECT_A}`));
  assert.deepEqual(await listed.json(), { jobs: [sample] });
  const wrongScope = await route.GET(request(`http://localhost/api/jobs?projectId=${PROJECT_B}&id=${CLIENT_A}`));
  assert.equal(wrongScope.status, 404);
  const cancelled = await route.DELETE(request("http://localhost/api/jobs", {
    method: "DELETE", body: JSON.stringify({ projectId: PROJECT_A, id: CLIENT_A }),
  }));
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).job.cancelRequested, true);
  assert.ok(calls.some(([kind]) => kind === "start"));
});
