import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("app/api/burn/route.ts");
const updatedAt = "2026-09-30T00:00:00.000Z";

async function fixture({ status = "ready", denyLock, throwGet = false, updateFailure,
  validationFailures = [], finalDriveMinutes = 74 } = {}) {
  const project = { id: "album", title: "검증", updatedAt, status,
    tracks: [{ id: "one", order: 1, title: "노래", status: "done", filename: "01.wav", durationSec: 1 }],
    burnSettings: { pregapSec: 2 } };
  const acquired = [];
  const released = [];
  let burnCalls = 0;
  let driveCalls = 0;
  let updateCalls = 0;
  const mocks = {
    "@/lib/burn": {
      BURN_LOCK_KEY: "burn:drive",
      burnStagingDir: (dir) => `${dir}/burn-staging`,
      checkDriveReady: () => null,
      cleanupBurnStaging: async () => {},
      getDriveStatus: async () => {
        driveCalls += 1;
        return { connected: true, mediaPresent: true, blank: true,
          mediaType: "CD-R", writableMinutes: driveCalls === 1 ? 74 : finalDriveMinutes };
      },
      prepareBurnStaging: async () => ({ mode: "cue", failures: [], tracks: [{ frames: 75 }], pregapSec: 2 }),
      resolveBurnTracks: async () => [{ path: "/tmp/01.wav", track: project.tracks[0] }],
      validateForBurn: async () => validationFailures,
      burn: async (_staging, emit) => { burnCalls += 1; emit({ type: "done" }); },
    },
    "@/lib/server-guards": {
      acquireJobLock: (key) => { if (key === denyLock) return null; acquired.push(key); return `token:${key}`; },
      releaseJobLock: (key) => { released.push(key); },
      rejectCrossOrigin: () => null,
    },
    "@/lib/storage": {
      getProject: async () => { if (throwGet) throw new Error("read failed"); return project; },
      projectDir: () => "/tmp/cdstudio-test-album",
      tracksDir: () => "/tmp/cdstudio-test-album/tracks",
      updateProjectWith: async (_id, mutate) => {
        updateCalls += 1;
        if (updateFailure === "throw") throw new Error("write failed");
        if (updateFailure === "null") return null;
        return mutate(project);
      },
    },
    "@/lib/types": {
      MAX_AUDIO_MINUTES: 79,
      discOccupancySec: (audio, count, pregap) => audio + (count ? 2 + (count - 1) * pregap : 0),
    },
  };
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const originalLoad = Module._load;
  Module._load = function (id, parent, isMain) {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return originalLoad.call(this, id, parent, isMain);
  };
  try { loaded._compile(compiled, sourcePath); } finally { Module._load = originalLoad; }
  return { route: loaded.exports, project, acquired, released,
    burnCalls: () => burnCalls, driveCalls: () => driveCalls, updateCalls: () => updateCalls };
}

function request(version = updatedAt) {
  const headers = { "Content-Type": "application/json" };
  if (version) headers["X-CDstudio-Updated-At"] = version;
  return new Request("http://localhost/api/burn", { method: "POST", headers,
    body: JSON.stringify({ projectId: "album", settings: { pregapSec: 2 } }) });
}

test("굽기 버전 헤더가 없으면 실물 작업 전에 428", async () => {
  const f = await fixture();
  assert.equal((await f.route.POST(request(null))).status, 428);
  assert.equal(f.burnCalls(), 0);
});

test("오래된 확인 목록과 추출 중 상태는 굽지 않고 락을 해제", async () => {
  for (const options of [{}, { status: "extracting" }]) {
    const f = await fixture(options);
    const response = await f.route.POST(request(options.status ? updatedAt : "stale"));
    assert.equal(response.status, 409);
    assert.equal(f.burnCalls(), 0);
    assert.deepEqual(f.released.sort(), ["burn:drive", "extract:album"]);
  }
});

test("같은 앨범 추출 락이나 앨범 읽기 오류가 있으면 굽지 않고 락을 반환", async () => {
  const busy = await fixture({ denyLock: "extract:album" });
  assert.equal((await busy.route.POST(request())).status, 409);
  assert.deepEqual(busy.released, ["burn:drive"]);
  const failed = await fixture({ throwGet: true });
  assert.equal((await failed.route.POST(request())).status, 500);
  assert.deepEqual(failed.released.sort(), ["burn:drive", "extract:album"]);
});

test("최신 확인 목록만 굽고 작업 종료 시 두 락을 해제", async () => {
  const f = await fixture();
  const response = await f.route.POST(request());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"type":"done"/);
  assert.equal(f.burnCalls(), 1);
  assert.equal(f.driveCalls(), 2, "media is checked before and after BIN generation");
  assert.deepEqual(f.released.sort(), ["burn:drive", "extract:album"]);
});

test("검증 실패는 굽기 설정·버전을 저장하지 않는다", async () => {
  const f = await fixture({ validationFailures: ["WAV 오류"] });
  const response = await f.route.POST(request());
  assert.match(await response.text(), /WAV 오류/);
  assert.equal(f.updateCalls(), 0);
  assert.equal(f.burnCalls(), 0);
});

test("이미지 생성 뒤 매체 용량이 줄면 실물 굽기를 중단한다", async () => {
  const f = await fixture({ finalDriveMinutes: 0.01 });
  const response = await f.route.POST(request());
  assert.match(await response.text(), /남은 용량이 부족/);
  assert.equal(f.driveCalls(), 2);
  assert.equal(f.burnCalls(), 0);
});

test("실물 굽기 성공 뒤 상태 저장 실패도 완료로 고정하고 중복 굽기를 유도하지 않는다", async () => {
  for (const updateFailure of ["null", "throw"]) {
    const f = await fixture({ updateFailure });
    const response = await f.route.POST(request());
    const body = await response.text();
    assert.match(body, /상태 저장에 실패/);
    assert.match(body, /"type":"done"/);
    assert.equal(f.burnCalls(), 1);
    assert.deepEqual(f.released.sort(), ["burn:drive", "extract:album"]);
  }
});
