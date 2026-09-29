import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("app/api/extract/route.ts");

test("unverified duration cleans staged audio and lets the next track complete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-extract-duration-"));
  let project = { id: "album", tracks: [], status: "draft" };
  let downloadCount = 0;
  let lockReleased = false;

  const mocks = {
    "@/lib/storage": {
      getProject: async () => project,
      updateProjectWith: async (_id, mutate) => {
        project = mutate(project);
        return project;
      },
      tracksDir: () => dir,
      safeFilename: (name) => name,
    },
    "@/lib/server-guards": {
      acquireJobLock: () => "lock",
      releaseJobLock: () => { lockReleased = true; },
      rejectCrossOrigin: () => null,
    },
    "@/lib/audio": {
      downloadAudio: async () => {
        downloadCount += 1;
        const file = path.join(dir, `.tmp-source-${downloadCount}.webm`);
        await writeFile(file, "source");
        return file;
      },
      convertToCdWav: async (_src, dst) => { await writeFile(dst, "converted"); },
      probeDuration: async () => downloadCount === 1 ? 0 : 42.75,
      isAllowedSourceUrl: () => true,
      assertAllowedSourceUrl: () => {},
      MAX_EXTRACT_ITEMS: 50,
      AbortError: class AbortError extends Error {},
    },
    "@/lib/extract-contract": {
      MAX_EXTRACT_ITEMS: 50,
    },
  };

  try {
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

    const request = {
      json: async () => ({
        projectId: "album",
        items: [
          { sourceUrl: "https://www.youtube.com/watch?v=BxW_N_VruBc", title: "First" },
          { sourceUrl: "https://www.youtube.com/watch?v=BxW_N_VruBc", title: "Second" },
        ],
      }),
      signal: new AbortController().signal,
    };
    const response = await loaded.exports.POST(request);
    const events = (await response.text()).trim().split("\n\n")
      .map((line) => JSON.parse(line.slice("data: ".length)));

    const errors = events.filter((event) => event.type === "track-error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /재생 시간을 확인할 수 없습니다/);
    assert.equal(events.filter((event) => event.type === "track-done").length, 1);
    assert.equal(downloadCount, 2);
    assert.equal(project.tracks.length, 1);
    assert.equal(project.tracks[0].title, "Second");
    assert.equal(project.tracks[0].durationSec, 42.75);
    assert.equal(project.status, "ready");
    assert.equal(lockReleased, true);
    assert.deepEqual(await readdir(dir), ["01 - Second.wav"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
