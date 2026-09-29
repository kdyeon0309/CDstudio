import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const resolved = request.startsWith("@/") ? path.join(root, request.slice(2)) : request;
  return originalResolve.call(this, resolved, parent, ...rest);
};
Module._extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(result.outputText, filename);
};

const { discOccupancySec, discOccupancySecFromTracks, formatDuration, MAX_BURN_TRACKS } = require(path.join(root, "lib/types.ts"));
const { validateForBurn, checkDriveReady } = require(path.join(root, "lib/burn.ts"));

assert.equal(discOccupancySec(78 * 60 + 59, 1, 2), 79 * 60 + 1,
  "a 78:59 single track exceeds the 79-minute cap after the lead-in");
assert.equal(discOccupancySec(78 * 60, 3, 2), 78 * 60 + 6,
  "the first lead-in and each later pregap occupy the disc");
assert.equal(discOccupancySec(78 * 60, 3, 0), 78 * 60 + 2,
  "zero pregap still has the fixed first lead-in");
assert.equal(MAX_BURN_TRACKS, 99);
assert.equal(formatDuration(59.6), "1:00", "round before splitting minutes and seconds");
assert.ok(discOccupancySecFromTracks(Array(99).fill(0.01), 2) > discOccupancySec(0.99, 99, 2),
  "each of 99 short tracks consumes one whole CD frame even when the raw audio is shorter");
assert.ok(checkDriveReady({ connected: true, mediaPresent: true, blank: true, erasable: false,
  mediaType: "DVD-R", raw: "Type: DVD-R" })?.includes("CD-R"),
"blank DVD media must not be accepted for an audio CD");
assert.equal(checkDriveReady({ connected: true, mediaPresent: true, blank: true, erasable: false,
  mediaType: "CD-R", raw: "Type: CD-R" }), null);
assert.ok(checkDriveReady({ connected: true, mediaPresent: true, blank: false, erasable: true,
  mediaType: "CD-RW", raw: "Type: CD-RW" })?.includes("미리 지워 둔"),
"a rewritable disc with existing content is rejected because burn does not pass -erase");
assert.equal(checkDriveReady({ connected: true, mediaPresent: true, blank: true, erasable: true,
  mediaType: "CD-RW", raw: "Type: CD-RW" }), null);

const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cdstudio-burn-capacity."));
try {
  const wavPath = path.join(fixtureDir, "01 - short.wav");
  execFileSync("/opt/homebrew/bin/ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "1", "-c:a", "pcm_s16le", wavPath,
  ]);
  const track = {
    id: "track-1", order: 1, title: "short", durationSec: 1,
    filename: path.basename(wavPath), status: "done", sourceUrl: "https://youtu.be/jNQXAC9IVRw",
  };
  const project = { tracks: [track] };
  const staged = [{ track, path: wavPath }];
  const noRoom = await validateForBurn(project, staged, { pregapSec: 2 }, 0.04);
  assert.ok(noRoom.some((message) => message.includes("삽입된 디스크의 남은 용량")),
    "the inserted disc capacity is checked against the probed WAV plus lead-in");
  const enoughRoom = await validateForBurn(project, staged, { pregapSec: 2 }, 0.1);
  assert.deepEqual(enoughRoom, [], "a valid short WAV and sufficient media capacity can pass");
  const standard74 = await validateForBurn(project, staged, { pregapSec: 2 }, 74);
  assert.deepEqual(standard74, [], "a short WAV fits standard 74-minute media");
  const tooMany = await validateForBurn({ tracks: Array.from({ length: 100 }, () => track) }, [], undefined);
  assert.ok(tooMany.some((message) => message.includes("최대 99트랙")),
    "100 tracks fail before an expensive image is built");
} finally {
  await fsp.rm(fixtureDir, { recursive: true, force: true });
}

console.log("burn-capacity: lead-in, pregap, media capacity, 99 tracks and duration formatting passed");
