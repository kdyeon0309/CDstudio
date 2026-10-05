import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

globalThis.window = globalThis;

const client = await readFile(new URL("../lib/background-job-client.ts", import.meta.url), "utf8");
const studio = await readFile(new URL("../app/album/[id]/design/studio-client.tsx", import.meta.url), "utf8");
const legacy = await readFile(new URL("../app/album/[id]/design/design-client.tsx", import.meta.url), "utf8");
const tracks = await readFile(new URL("../app/album/[id]/tracks/TracksClient.tsx", import.meta.url), "utf8");

const compiled = ts.transpileModule(client, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const job = (overrides = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  endpoint: "/api/extract",
  projectId: "22222222-2222-4222-8222-222222222222",
  status: "running",
  startedAt: 1,
  cancelRequested: false,
  events: [],
  ...overrides,
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("idempotent start retries a lost response with the exact same clientJobId", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) throw new TypeError("connection lost after accept");
    return jsonResponse({ job: job() }, 202);
  };
  try {
    await api.startBackgroundJob("/api/extract", { projectId: job().projectId }, "33333333-3333-4333-8333-333333333333");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].clientJobId, bodies[1].clientJobId);
  } finally { globalThis.fetch = originalFetch; }
});

test("observer deduplicates seq, stops on 404, and stop never sends DELETE", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  let mode = "terminal";
  globalThis.fetch = async (_url, init = {}) => {
    methods.push(init.method ?? "GET");
    if (mode === "404") return jsonResponse({ error: "missing" }, 404);
    return jsonResponse({ job: job({
      status: "success",
      finishedAt: 4,
      events: [{ seq: 1, event: { type: "status", message: "one" } }, { seq: 2, event: { type: "status", message: "two" } }],
    }) });
  };
  try {
    const seen = [];
    const observer = api.watchBackgroundJob(job({ events: [{ seq: 1, event: { type: "status", message: "one" } }] }), {
      onEvent: (_event, seq) => seen.push(seq),
    }, 1);
    const terminal = await observer.finished;
    assert.equal(terminal.status, "success");
    assert.deepEqual(seen, [1, 2]);

    mode = "404";
    const missing = api.watchBackgroundJob(job(), { onEvent() {} }, 1);
    assert.equal((await missing.finished).status, "error");

    mode = "terminal";
    const detached = api.watchBackgroundJob(job(), { onEvent() {} }, 50);
    detached.stop();
    assert.equal(await detached.finished, null);
    assert.equal(methods.includes("DELETE"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("completed polling delays remove their abort listeners", async () => {
  const NativeAbortController = globalThis.AbortController;
  const originalFetch = globalThis.fetch;
  let added = 0;
  let removed = 0;
  globalThis.AbortController = class {
    constructor() {
      this.inner = new NativeAbortController();
      this.signal = this.inner.signal;
      const add = this.signal.addEventListener.bind(this.signal);
      const remove = this.signal.removeEventListener.bind(this.signal);
      this.signal.addEventListener = (...args) => { added += 1; return add(...args); };
      this.signal.removeEventListener = (...args) => { removed += 1; return remove(...args); };
    }
    abort() { this.inner.abort(); }
  };
  globalThis.fetch = async () => jsonResponse({ job: job({ status: "success", finishedAt: 2 }) });
  try {
    const observer = api.watchBackgroundJob(job(), { onEvent() {} }, 1);
    await observer.finished;
    assert.equal(added, removed);
    assert.ok(added > 0);
  } finally {
    globalThis.AbortController = NativeAbortController;
    globalThis.fetch = originalFetch;
  }
});

test("explicit cancel sends the exact project and job IDs", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => { request = init; return jsonResponse({ job: job({ cancelRequested: true }) }, 202); };
  try {
    await api.cancelBackgroundJob(job().projectId, job().id);
    assert.equal(request.method, "DELETE");
    assert.deepEqual(JSON.parse(request.body), { projectId: job().projectId, id: job().id });
  } finally { globalThis.fetch = originalFetch; }
});

test("a deferred POST resolved after unmount returns null and cannot attach an observer", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  let active = true;
  try {
    const pending = api.startBackgroundJobIfActive("/api/extract", { projectId: job().projectId }, () => active);
    active = false;
    resolveFetch(jsonResponse({ job: job() }, 202));
    assert.equal(await pending, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("storage refresh never rolls a newer current project back", () => {
  const newer = { updatedAt: "2026-10-05T10:00:00.000Z", title: "newer" };
  const older = { updatedAt: "2026-10-05T09:00:00.000Z", title: "older" };
  assert.equal(api.newestUpdatedProject(newer, older), newer);
  assert.equal(api.newestUpdatedProject(older, newer), newer);
});

test("observer stop and explicit server cancellation are separate operations", () => {
  assert.match(client, /stop: \(\) => controller\.abort\(\)/);
  assert.match(client, /Stopping this observer never cancels the server-owned job/);
  for (const source of [studio, legacy, tracks]) {
    assert.match(source, /observerRef|generationControllersRef/);
    assert.match(source, /cancelBackgroundJob/);
  }
});

test("background recovery gates starts and reports reconnecting state", () => {
  for (const source of [studio, legacy, tracks]) {
    assert.match(source, /listBackgroundJobs\(projectId/);
    assert.match(source, /jobsReady/);
    assert.match(source, /다시 연결하는 중/);
    assert.match(source, /다른 화면으로 이동해도 서버에서 계속 진행됩니다/);
    assert.match(source, /작업 다시 확인/);
    assert.match(source, /recoveryStartedRef\.current = false/);
  }
});

test("client retries idempotent start and deduplicates increasing event sequences", () => {
  assert.match(client, /clientJobId = crypto\.randomUUID\(\)/);
  assert.match(client, /body: JSON\.stringify\(\{ endpoint, input, clientJobId \}\)/);
  assert.match(client, /if \(item\.seq <= lastSeq\) continue/);
  assert.match(client, /removeEventListener\("abort", finish\)/, "settled polls release abort listeners");
  assert.match(client, /status === 404[\s\S]*서버가 다시 시작되어/);
});

test("unmount only detaches observers and late POST responses cannot attach", () => {
  for (const source of [studio, legacy, tracks]) {
    assert.match(source, /mountedRef\.current = false/);
    assert.match(source, /startBackgroundJobIfActive\([\s\S]*mountedRef\.current/);
  }
  assert.match(studio, /reservation\.observer\?\.stop\(\)/);
  assert.doesNotMatch(tracks, /return \(\) => abortRef\.current\?\.abort/);
});

test("studio terminal recovery refreshes storage without resetting active preview drafts", () => {
  const refresh = studio.slice(studio.indexOf("const refreshStoredStudioProject"), studio.indexOf("useEffect(() => {", studio.indexOf("const refreshStoredStudioProject")));
  assert.match(refresh, /setProject\(\(current\) => current \? newestUpdatedProject\(current, value\) : value\)/);
  assert.doesNotMatch(refresh, /setDrafts|setPresentations|setPreviewId|setVariationBase|setActivePart/);
  assert.match(studio, /job\.status !== "running"[\s\S]*refreshStoredStudioProject\(\)/);
});

test("recovered extraction done reloads current storage instead of replacing project snapshot", () => {
  const recoveredWatch = tracks.slice(tracks.lastIndexOf("watchBackgroundJob(job"));
  assert.match(recoveredWatch, /event\.type === "done"\) void loadProject\(\)/);
  assert.doesNotMatch(recoveredWatch.slice(0, recoveredWatch.indexOf("observerRef.current.finished")), /setProject\(event\.project\)/);
});
