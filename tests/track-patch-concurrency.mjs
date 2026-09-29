import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("app/api/projects/[id]/route.ts");

const baseProject = {
  id: "album",
  title: "앨범",
  artist: "가수",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  tracks: [
    {
      id: "new-track",
      order: 1,
      title: "새 트랙",
      durationSec: 60,
      sourceUrl: "https://www.youtube.com/watch?v=BxW_N_VruBc",
      filename: "01 - 새 트랙.wav",
      status: "done",
    },
  ],
  artwork: { variants: [] },
};

async function loadRoute({ lockAvailable = true } = {}) {
  let project = structuredClone(baseProject);
  let updateCalls = 0;
  let releases = 0;
  const mocks = {
    "@/lib/storage": {
      deleteProject: async () => true,
      getProject: async () => project,
      updateProjectWith: async (_id, mutate) => {
        updateCalls += 1;
        project = mutate(project);
        project.updatedAt = "2026-01-03T00:00:00.000Z";
        return project;
      },
      withProjectLock: async (_id, callback) => callback(),
    },
    "@/lib/server-guards": {
      acquireJobLock: () => (lockAvailable ? "token" : null),
      rejectCrossOrigin: () => null,
      releaseJobLock: () => {
        releases += 1;
      },
    },
    "@/lib/audio": {
      isAllowedSourceUrl: () => true,
    },
    "@/lib/types": {
      ARTWORK_PARTS: ["front", "front-inner", "label", "back", "back-inner"],
      DEFAULT_PART_MODES: {},
    },
  };

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
  const originalLoad = Module._load;
  Module._load = function (id, parent, isMain) {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    loaded._compile(compiled, sourcePath);
  } finally {
    Module._load = originalLoad;
  }

  return {
    route: loaded.exports,
    project: () => project,
    updateCalls: () => updateCalls,
    releases: () => releases,
  };
}

function patchRequest(tracks, updatedAt) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (updatedAt) headers.set("X-CDstudio-Updated-At", updatedAt);
  return new Request("http://localhost/api/projects/album", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ tracks }),
  });
}

const context = { params: Promise.resolve({ id: "album" }) };

test("stale 트랙 PATCH는 409이며 새 트랙을 보존하고 재저장하지 않는다", async () => {
  const fixture = await loadRoute();
  const response = await fixture.route.PATCH(
    patchRequest([], "2026-01-01T00:00:00.000Z"),
    context,
  );

  assert.equal(response.status, 409);
  assert.equal(fixture.project().tracks.length, 1);
  assert.equal(fixture.project().tracks[0].id, "new-track");
  assert.equal(fixture.updateCalls(), 1);
  assert.equal(fixture.releases(), 1);
});

test("추출 락이 잡혀 있으면 트랙 PATCH를 409로 거절한다", async () => {
  const fixture = await loadRoute({ lockAvailable: false });
  const response = await fixture.route.PATCH(
    patchRequest([], baseProject.updatedAt),
    context,
  );

  assert.equal(response.status, 409);
  assert.equal(fixture.updateCalls(), 0);
  assert.equal(fixture.project().tracks.length, 1);
});

test("현재 버전의 트랙 PATCH만 저장하고 작업 락을 해제한다", async () => {
  const fixture = await loadRoute();
  const response = await fixture.route.PATCH(
    patchRequest(baseProject.tracks, baseProject.updatedAt),
    context,
  );

  assert.equal(response.status, 200);
  assert.equal(fixture.project().tracks.length, 1);
  assert.equal(fixture.releases(), 1);
});

test("버전 헤더가 없는 트랙 PATCH는 428로 거절한다", async () => {
  const fixture = await loadRoute();
  const response = await fixture.route.PATCH(patchRequest([], undefined), context);

  assert.equal(response.status, 428);
  assert.equal(fixture.updateCalls(), 0);
});
