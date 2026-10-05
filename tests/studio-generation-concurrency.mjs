import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "..");

async function loadTs(relativePath, mocks = {}) {
  const filename = path.join(root, relativePath);
  const source = await fs.readFile(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => Object.prototype.hasOwnProperty.call(mocks, id)
    ? mocks[id]
    : originalRequire(id);
  loaded._compile(compiled, filename);
  return loaded.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function responseJson(response, status) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}

test("studio generation locks one area while sibling areas merge independently", async () => {
  const library = await fs.mkdtemp(path.join(os.tmpdir(), "cdstudio-studio-concurrency-"));
  const previousLibrary = process.env.CDSTUDIO_LIBRARY;
  process.env.CDSTUDIO_LIBRARY = library;
  try {
    const types = await loadTs("lib/types.ts");
    const storage = await loadTs("lib/storage.ts");
    const guards = await loadTs("lib/server-guards.ts");
    const studio = await loadTs("lib/studio.ts", {
      "./storage": storage,
      "./types": types,
    });
    const shared = await loadTs("app/api/design/shared.ts", {
      "@/lib/types": types,
      "@/lib/storage": storage,
      "@/lib/server-guards": guards,
    });

    class MockImageGenerationError extends Error {}
    const plans = new Map();
    const queuePlan = (part, waitForAbortCleanup = false) => {
      const entered = deferred();
      const finish = deferred();
      const cleanup = waitForAbortCleanup ? deferred() : null;
      const plan = { entered, finish, cleanup };
      const queued = plans.get(part) ?? [];
      queued.push(plan);
      plans.set(part, queued);
      return plan;
    };
    let availability = { connected: true, message: "ready" };
    const imageGeneration = {
      codexImageAvailability: async () => availability,
      createImageWorkspace: async () => fs.mkdtemp(path.join(library, "workspace-")),
      generateCodexImage: async (options) => {
        const queued = plans.get(options.part) ?? [];
        const plan = queued.shift();
        assert.ok(plan, `unexpected mock CLI call for ${options.part}`);
        plan.entered.resolve();
        let abort;
        const aborted = new Promise((resolve) => {
          abort = () => resolve("abort");
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
        let outcome;
        try {
          outcome = await Promise.race([plan.finish.promise.then(() => "finish"), aborted]);
        } finally {
          options.signal?.removeEventListener("abort", abort);
        }
        if (outcome === "abort") {
          if (plan.cleanup) await plan.cleanup.promise;
          throw new MockImageGenerationError("이미지 생성이 취소되었습니다.");
        }
        await fs.writeFile(options.outputPath, `MOCK PNG ${options.part}`);
        return { width: 1024, height: 1024 };
      },
      ImageGenerationError: MockImageGenerationError,
    };
    const imageRoute = await loadTs("app/api/design/image/route.ts", {
      "@/lib/storage": storage,
      "@/lib/server-guards": guards,
      "@/lib/studio": studio,
      "@/lib/image-generation": imageGeneration,
      "../shared": shared,
    });
    const studioRoute = await loadTs("app/api/design/studio/route.ts", {
      "@/lib/storage": storage,
      "@/lib/server-guards": guards,
      "@/lib/studio": studio,
      "@/lib/types": types,
      "../shared": shared,
    });

    const project = await storage.createProject({ title: "Concurrency", artist: "Test" });
    const otherProject = await storage.createProject({ title: "Other album", artist: "Test" });
    const assets = storage.assetsDir(project.id);
    await fs.writeFile(path.join(assets, "reference.png"), "REFERENCE");
    await fs.writeFile(path.join(assets, "unused.png"), "UNUSED");

    const imageRequest = (part, extra = {}, signal) => imageRoute.POST(new Request(
      "http://127.0.0.1:3000/api/design/image",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          projectId: project.id,
          part,
          prompt: `${part} prompt`,
          referenceFiles: [],
          referenceLabels: {},
          ...extra,
        }),
      },
    ));
    const patchRequest = (part, prompt = `${part} draft`) => studioRoute.PATCH(new Request(
      "http://127.0.0.1:3000/api/design/studio",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          action: "draft",
          part,
          prompt,
          referenceFiles: [],
          referenceLabels: {},
        }),
      },
    ));
    const snapshotRequest = () => studioRoute.PATCH(new Request(
      "http://127.0.0.1:3000/api/design/studio",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, action: "snapshot", name: "busy snapshot" }),
      },
    ));

    // Validation failures after lock acquisition release that area immediately.
    const missingParent = await imageRequest("front", {
      parentCandidateId: "11111111-1111-1111-1111-111111111111",
    });
    await responseJson(missingParent, 404);
    const afterParentFailure = shared.acquireDesignPartLock(project.id, "front");
    assert.ok(afterParentFailure, "parent validation failure must release its area lock");
    guards.releaseJobLock(afterParentFailure.key, afterParentFailure.token);

    availability = { connected: false, message: "mock CLI unavailable" };
    const unavailable = await imageRequest("back");
    await responseJson(unavailable, 503);
    const afterAvailabilityFailure = shared.acquireDesignPartLock(project.id, "back");
    assert.ok(afterAvailabilityFailure, "availability failure must release its area lock");
    guards.releaseJobLock(afterAvailabilityFailure.key, afterAvailabilityFailure.token);
    availability = { connected: true, message: "ready" };

    // Ownership tokens cannot release a sibling lock or a newer lock that reused the same key.
    const tokenProbe = shared.acquireDesignPartLock(project.id, "front");
    assert.ok(tokenProbe);
    guards.releaseJobLock(tokenProbe.key, "wrong-token");
    assert.equal(guards.isJobLocked(tokenProbe.key), true);
    const siblingProbe = shared.acquireDesignPartLock(project.id, "back");
    assert.ok(siblingProbe, "a different area remains independent");
    guards.releaseJobLock(tokenProbe.key, tokenProbe.token);
    const replacementProbe = shared.acquireDesignPartLock(project.id, "front");
    assert.ok(replacementProbe);
    guards.releaseJobLock(tokenProbe.key, tokenProbe.token);
    assert.equal(guards.isJobLocked(replacementProbe.key), true, "an old token cannot clear a newer lock");
    guards.releaseJobLock(replacementProbe.key, replacementProbe.token);
    guards.releaseJobLock(siblingProbe.key, siblingProbe.token);

    // The reverse hierarchy also holds: a whole-album lock blocks every area route,
    // while another album remains independent. Releasing it permits both areas below.
    const globalProbe = shared.acquireDesignLock(project.id);
    assert.ok(globalProbe);
    await responseJson(await imageRequest("front"), 409);
    await responseJson(await imageRequest("back"), 409);
    await responseJson(await patchRequest("front"), 409);
    const otherAlbumPatch = await studioRoute.PATCH(new Request(
      "http://127.0.0.1:3000/api/design/studio",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: otherProject.id,
          action: "draft",
          part: "front",
          prompt: "other album remains writable",
          referenceFiles: [],
          referenceLabels: {},
        }),
      },
    ));
    await responseJson(otherAlbumPatch, 200);
    guards.releaseJobLock(globalProbe.key, "stale-global-token");
    await responseJson(await imageRequest("front"), 409);
    guards.releaseJobLock(globalProbe.key, globalProbe.token);

    const frontPlan = queuePlan("front");
    const backPlan = queuePlan("back");
    const frontBody = {
      prompt: "immutable front prompt",
      referenceFiles: ["reference.png"],
      referenceLabels: { "reference.png": "인물" },
    };
    const frontResponse = await imageRequest("front", frontBody);
    const backResponse = await imageRequest("back");
    await Promise.all([frontPlan.entered.promise, backPlan.entered.promise]);
    assert.deepEqual(frontBody, {
      prompt: "immutable front prompt",
      referenceFiles: ["reference.png"],
      referenceLabels: { "reference.png": "인물" },
    }, "route handling must not mutate caller-owned request data");
    assert.equal(frontResponse.status, 200);
    assert.equal(backResponse.status, 200);

    const duplicateFront = await imageRequest("front");
    const duplicateData = await responseJson(duplicateFront, 409);
    assert.match(duplicateData.error, /해당 영역/);
    await responseJson(await patchRequest("front"), 409);
    await responseJson(await snapshotRequest(), 409);
    const labelDraft = await responseJson(await patchRequest("label", "label stays writable"), 200);
    assert.equal(labelDraft.studio.parts.label.prompt, "label stays writable");

    // Whole-album legacy/destructive callers all use design:<id> and real guards reject them.
    const legacyRoute = await loadTs("app/api/design/route.ts", {
      "@/lib/storage": storage,
      "@/lib/design": {
        generateVariants: async () => { throw new Error("must not run"); },
        resolvePartModes: () => ({ front: "ai", "front-inner": "blank", back: "blank", "back-inner": "blank", label: "blank" }),
      },
      "@/lib/types": types,
      "@/lib/server-guards": guards,
      "./stream": { designSseResponse: () => { throw new Error("must remain locked"); } },
      "./shared": shared,
    });
    await responseJson(await legacyRoute.POST(new Request("http://127.0.0.1:3000/api/design", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    })), 409);

    const assetRoute = await loadTs("app/api/projects/[id]/assets/route.ts", {
      "@/lib/storage": storage,
      "@/lib/server-guards": guards,
      "@/lib/studio": studio,
      "@/lib/types": types,
    });
    await responseJson(await assetRoute.DELETE(new Request("http://127.0.0.1:3000/api/projects/id/assets", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "unused.png" }),
    }), { params: Promise.resolve({ id: project.id }) }), 409);
    await fs.access(path.join(assets, "unused.png"));

    const projectRoute = await loadTs("app/api/projects/[id]/route.ts", {
      "@/lib/storage": storage,
      "@/lib/server-guards": guards,
      "@/lib/audio": { isAllowedSourceUrl: () => true },
      "@/lib/types": types,
    });
    await responseJson(await projectRoute.DELETE(new Request("http://127.0.0.1:3000/api/projects/id", {
      method: "DELETE",
    }), { params: Promise.resolve({ id: project.id }) }), 409);
    assert.ok(await storage.getProject(project.id));

    // Dirty metadata written after both requests started must survive reverse completion.
    await storage.updateProjectWith(project.id, (latest) => ({
      ...latest,
      concept: "server metadata changed during generation",
    }));
    backPlan.finish.resolve();
    assert.match(await backResponse.text(), /"type":"done"/);
    assert.equal(guards.isJobLocked(`design:${project.id}:back`), false);
    assert.equal(guards.isJobLocked(`design:${project.id}:front`), true);

    // A finished area can retry while a sibling is still active.
    const backRetryPlan = queuePlan("back");
    const backRetryResponse = await imageRequest("back", { prompt: "back retry" });
    await backRetryPlan.entered.promise;
    backRetryPlan.finish.resolve();
    assert.match(await backRetryResponse.text(), /"type":"done"/);
    assert.equal(guards.isJobLocked(`design:${project.id}:front`), true);

    // Stream errors and aborts release only their own locks, never the active sibling lock.
    const labelErrorPlan = queuePlan("label");
    const labelErrorResponse = await imageRequest("label");
    await labelErrorPlan.entered.promise;
    labelErrorPlan.finish.reject(new MockImageGenerationError("mock CLI failed"));
    assert.match(await labelErrorResponse.text(), /"type":"error"/);
    await responseJson(await patchRequest("label", "retry after error"), 200);
    assert.equal(guards.isJobLocked(`design:${project.id}:front`), true);

    const abortPlan = queuePlan("back-inner", true);
    const abortController = new AbortController();
    const abortResponse = await imageRequest("back-inner", {}, abortController.signal);
    await abortPlan.entered.promise;
    const abortedText = abortResponse.text();
    abortController.abort();
    await responseJson(await patchRequest("back-inner", "must wait for CLI cleanup"), 409);
    assert.equal(guards.isJobLocked(`design:${project.id}:front`), true);
    abortPlan.cleanup.resolve();
    await abortedText;
    await responseJson(await patchRequest("back-inner", "retry after abort"), 200);
    assert.equal(guards.isJobLocked(`design:${project.id}:front`), true);

    frontPlan.finish.resolve();
    assert.match(await frontResponse.text(), /"type":"done"/);
    assert.equal(guards.isJobLocked(`design:${project.id}`), false);

    const saved = await storage.getProject(project.id);
    assert.equal(saved.concept, "server metadata changed during generation");
    assert.equal(saved.studio.parts.front.candidates.length, 1);
    assert.equal(saved.studio.parts.back.candidates.length, 2);
    assert.equal(saved.studio.parts.label.prompt, "retry after error");
    assert.equal(saved.studio.parts["back-inner"].prompt, "retry after abort");
    const frontCandidate = saved.studio.parts.front.candidates[0];
    assert.equal(frontCandidate.prompt, "immutable front prompt");
    assert.deepEqual(frontCandidate.referenceFiles, ["reference.png"]);
    assert.deepEqual(frontCandidate.referenceLabels, { "reference.png": "인물" });
  } finally {
    if (previousLibrary === undefined) delete process.env.CDSTUDIO_LIBRARY;
    else process.env.CDSTUDIO_LIBRARY = previousLibrary;
    await fs.rm(library, { recursive: true, force: true });
  }
});
