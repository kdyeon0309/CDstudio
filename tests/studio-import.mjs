/**
 * TEST_BASE_URL=http://127.0.0.1:3219 \
 * CDSTUDIO_TEST_LIBRARY=/private/tmp/cdstudio-studio-integration.xxxxx \
 * node tests/studio-import.mjs
 *
 * 서버의 CDSTUDIO_LIBRARY는 같은 격리된 경로여야 한다.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const base = process.env.TEST_BASE_URL;
const library = process.env.CDSTUDIO_TEST_LIBRARY;
if (!base || !/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)) {
  throw new Error("TEST_BASE_URL must be an explicit localhost server URL");
}
if (!library || !path.isAbsolute(library)
  || !/^\/(?:private\/)?tmp\/cdstudio-studio-integration\.[^/]+$/.test(library)) {
  throw new Error("CDSTUDIO_TEST_LIBRARY must be a dedicated /tmp/cdstudio-studio-integration.* path");
}

async function call(method, endpoint, body, status = 200) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

function hash(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

async function upload(projectId, name, bytes, type) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  const response = await fetch(`${base}/api/projects/${projectId}/assets`, { method: "POST", body: form });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return data.filename;
}

function jpegWithExifOrientation(jpeg, orientation) {
  // EXIF APP1: big-endian TIFF with a single Orientation SHORT tag.
  const exif = Buffer.alloc(32);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("MM", 6, "ascii");
  exif.writeUInt16BE(42, 8);
  exif.writeUInt32BE(8, 10);
  exif.writeUInt16BE(1, 14);
  exif.writeUInt16BE(0x0112, 16);
  exif.writeUInt16BE(3, 18);
  exif.writeUInt32BE(1, 20);
  exif.writeUInt16BE(orientation, 24);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
}

const created = await call("POST", "/api/projects", { title: "Uploaded studio import test", artist: "Test" }, 201);
const projectId = created.id;
const assets = path.join(library, projectId, "assets");
const projectFile = path.join(library, projectId, "project.json");
assert.equal(JSON.parse(await fs.readFile(projectFile, "utf8")).id, projectId,
  "server library must match isolated fixture path");

// The existing upload endpoint owns the original; import must copy/normalize it.
const sourceFixture = path.join(assets, "fixture-front.png");
execFileSync("/opt/homebrew/bin/ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=4000x2000:d=1", "-frames:v", "1", sourceFixture,
]);
const frontBytes = await fs.readFile(sourceFixture);
const frontFilename = await upload(projectId, "blue-front.png", frontBytes, "image/png");
const frontOriginal = path.join(assets, frontFilename);
const frontHash = hash(await fs.readFile(frontOriginal));
const studio = (action, status = 200) => call("PATCH", "/api/design/studio", { projectId, ...action }, status);

let project = await studio({ action: "import", part: "front", filename: frontFilename });
let front = project.studio.parts.front;
assert.equal(project.status, "designed");
assert.equal(project.studio.printSource, "studio");
assert.equal(front.candidates.length, 1);
assert.equal(front.selectedCandidateId, front.candidates[0].id);
assert.equal(front.candidates[0].source, "upload");
assert.equal(front.candidates[0].prompt, "");
assert.deepEqual(front.candidates[0].referenceFiles, []);
assert.deepEqual([front.candidates[0].width, front.candidates[0].height], [4000, 2000]);
assert.equal(front.presentation.transform.scale, 1);
assert.equal(hash(await fs.readFile(frontOriginal)), frontHash, "original upload must remain untouched");
assert.notEqual(front.candidates[0].filename, frontFilename);
const firstCandidateFile = path.join(assets, front.candidates[0].filename);
assert.equal((await fs.readFile(firstCandidateFile)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

await studio({ action: "presentation", part: "front", presentation: {
  fit: "contain", transform: { offsetXMm: 5, offsetYMm: -3, scale: 1.5 },
  overlay: { enabled: true, color: "#ffffff", position: "top", fontSizeMm: 8 },
} });
project = await studio({ action: "import", part: "front", filename: frontFilename });
front = project.studio.parts.front;
assert.equal(front.candidates.length, 2, "each import creates immutable candidate history");
assert.equal(front.selectedCandidateId, front.candidates[1].id);
assert.equal(front.presentation.fit, "cover", "new import resets crop placement");
assert.equal(front.presentation.transform.offsetXMm, 0);
assert.equal((await fs.stat(firstCandidateFile)).isFile(), true, "prior candidate stays available");
assert.equal(hash(await fs.readFile(frontOriginal)), frontHash);

// A JPEG with EXIF orientation=6 should become an upright PNG with swapped dimensions.
const jpegFixture = path.join(assets, "fixture-landscape.jpg");
execFileSync("/opt/homebrew/bin/ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1000x500:d=1", "-frames:v", "1", jpegFixture,
]);
const oriented = jpegWithExifOrientation(await fs.readFile(jpegFixture), 6);
const backFilename = await upload(projectId, "rotated-back.jpg", oriented, "image/jpeg");
project = await studio({ action: "import", part: "back", filename: backFilename });
const back = project.studio.parts.back;
assert.equal(back.selectedCandidateId, back.candidates[0].id);
assert.deepEqual([back.candidates[0].width, back.candidates[0].height], [500, 1000]);
assert.equal(project.studio.parts.front.selectedCandidateId, front.selectedCandidateId,
  "importing another area preserves previous selections");
project = await studio({ action: "import", part: "back-spine", filename: frontFilename });
const spine = project.studio.parts["back-spine"];
assert.equal(spine.candidates.length, 1);
assert.equal(spine.selectedCandidateId, spine.candidates[0].id);
assert.equal(spine.candidates[0].source, "upload");
assert.equal(project.studio.parts.back.selectedCandidateId, back.selectedCandidateId,
  "importing a spine preserves the central back selection");
assert.equal(project.studio.parts.front.selectedCandidateId, front.selectedCandidateId,
  "importing a spine preserves the front selection");

// A 4000x2000 original should retain its native pixels when the PNG fits 20MB.
project = await studio({ action: "import", part: "back", filename: frontFilename });
let printImage = project.studio.parts.back.candidates.at(-1);
assert.deepEqual([printImage.width, printImage.height], [4000, 2000]);
assert.ok(Math.floor(Math.min(printImage.width / 150, printImage.height / 118) * 25.4) >= 300,
  "full-size 150x118mm back cover must exceed 300 PPI");
assert.equal(hash(await fs.readFile(frontOriginal)), frontHash, "high-res original remains immutable");

// Noisy JPEG is under the upload limit, but its 4000px PNG exceeds 20MB.
// The fallback must re-read the original and retain the largest safe PNG.
const noisyFixture = path.join(assets, "fixture-noisy.jpg");
execFileSync("/opt/homebrew/bin/ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=4000x2000:d=1",
  "-vf", "format=rgb24,noise=alls=100:allf=t", "-frames:v", "1", "-q:v", "25", noisyFixture,
]);
const noisyBytes = await fs.readFile(noisyFixture);
assert.ok(noisyBytes.length < 5 * 1024 * 1024, "noisy source must fit the upload endpoint's 5MB limit");
const noisyFilename = await upload(projectId, "noisy-back.jpg", noisyBytes, "image/jpeg");
const noisyOriginal = path.join(assets, noisyFilename);
const noisyHash = hash(await fs.readFile(noisyOriginal));
project = await studio({ action: "import", part: "back", filename: noisyFilename });
printImage = project.studio.parts.back.candidates.at(-1);
assert.deepEqual([printImage.width, printImage.height], [3072, 1536],
  "oversized 4096px PNG should fall back to the largest safe edge");
assert.ok((await fs.stat(path.join(assets, printImage.filename))).size <= 20 * 1024 * 1024);
assert.ok(Math.floor(Math.min(printImage.width / 150, printImage.height / 118) * 25.4) >= 300);
assert.equal(hash(await fs.readFile(noisyOriginal)), noisyHash, "fallback never changes the original upload");

// A detailed source above the former 5MiB limit must pass the upload endpoint
// and still produce a full-size print candidate within the 20MiB PNG cap.
const largeFixture = path.join(assets, "fixture-large-upload.jpg");
execFileSync("/opt/homebrew/bin/ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=4000x2000:d=1",
  "-vf", "noise=alls=100:allf=t", "-frames:v", "1", "-q:v", "2", largeFixture,
]);
const largeBytes = await fs.readFile(largeFixture);
assert.ok(largeBytes.length > 5 * 1024 * 1024 && largeBytes.length < 20 * 1024 * 1024,
  "fixture must exercise the newly allowed 5–20MiB upload range");
const largeFilename = await upload(projectId, "large-back.jpg", largeBytes, "image/jpeg");
const largeOriginal = path.join(assets, largeFilename);
const largeHash = hash(await fs.readFile(largeOriginal));
project = await studio({ action: "import", part: "back", filename: largeFilename });
printImage = project.studio.parts.back.candidates.at(-1);
assert.deepEqual([printImage.width, printImage.height], [4000, 2000]);
assert.ok((await fs.stat(path.join(assets, printImage.filename))).size <= 20 * 1024 * 1024);
assert.equal(hash(await fs.readFile(largeOriginal)), largeHash, "larger uploaded original stays intact");

const oversizeForm = new FormData();
const oversizeBytes = Buffer.alloc(20 * 1024 * 1024 + 1);
Buffer.from("89504e470d0a1a0a", "hex").copy(oversizeBytes);
oversizeForm.append("file", new File([oversizeBytes], "too-large.png", { type: "image/png" }));
const oversizeResponse = await fetch(`${base}/api/projects/${projectId}/assets`, { method: "POST", body: oversizeForm });
assert.equal(oversizeResponse.status, 413, "request over 20MiB remains rejected");

const tooManyForm = new FormData();
for (let index = 0; index < 6; index++) {
  tooManyForm.append("file", new File([frontBytes], `extra-${index}.png`, { type: "image/png" }));
}
const tooManyResponse = await fetch(`${base}/api/projects/${projectId}/assets`, { method: "POST", body: tooManyForm });
assert.equal(tooManyResponse.status, 413, "the five-file request limit remains in force");

const beforeInvalid = JSON.stringify(project.studio);
await studio({ action: "import", part: "front", filename: "../escape.png" }, 400);
await studio({ action: "import", part: "front", filename: "missing.png" }, 404);
const fake = path.join(assets, "corrupt.png");
await fs.writeFile(fake, Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("not actually an image"),
]));
await studio({ action: "import", part: "front", filename: "corrupt.png" }, 422);
const symlink = path.join(assets, "linked.png");
await fs.symlink(frontOriginal, symlink);
await studio({ action: "import", part: "front", filename: "linked.png" }, 422);
project = await call("GET", `/api/design/studio?projectId=${projectId}`, undefined);
assert.equal(JSON.stringify(project.studio), beforeInvalid, "invalid imports must not mutate studio state");
assert.equal((await fs.readdir(assets)).filter((name) => name.startsWith("uploaded-")).length, 7,
  "failed imports must not leave candidate files");

const fullProject = JSON.parse(await fs.readFile(projectFile, "utf8"));
const template = fullProject.studio.parts.front.candidates[0];
for (let index = fullProject.studio.parts.front.candidates.length; index < 100; index++) {
  fullProject.studio.parts.front.candidates.push({
    ...template, id: `limit-${index}`, filename: `limit-${index}.png`,
  });
}
await fs.writeFile(projectFile, JSON.stringify(fullProject, null, 2));
await studio({ action: "import", part: "front", filename: frontFilename }, 409);
project = await call("GET", `/api/design/studio?projectId=${projectId}`, undefined);
assert.equal(project.studio.parts.front.candidates.length, 100, "candidate cap must reject atomically");
assert.equal((await fs.readdir(assets)).filter((name) => name.startsWith("uploaded-")).length, 7,
  "candidate cap must not create an orphan image");

console.log(`PASS studio uploaded import project=${projectId} library=${library}`);
