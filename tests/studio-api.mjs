/**
 * TEST_BASE_URL=http://127.0.0.1:3219 \
 * CDSTUDIO_TEST_LIBRARY=/private/tmp/cdstudio-studio-integration.xxxxx \
 * node tests/studio-api.mjs
 *
 * 서버의 CDSTUDIO_LIBRARY가 위의 격리된 경로를 가리켜야 한다.
 */
import assert from "node:assert/strict";
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

async function call(method, endpoint, body, expected = 200) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
const presentation = {
  fit: "cover",
  transform: { offsetXMm: 0, offsetYMm: 0, scale: 1 },
  overlay: { enabled: false, color: "#ffffff", position: "bottom", fontSizeMm: 6 },
};
const candidate = (id, filename, extras = {}) => ({
  id, filename, prompt: `Test ${id}`, referenceFiles: [], width: 1024, height: 1024,
  createdAt: new Date().toISOString(), ...extras,
});

const created = await call("POST", "/api/projects", { title: "Studio API test", artist: "Test" }, 201);
const projectId = created.id;
assert.match(projectId, /^[a-z0-9-]+$/i);
const dir = path.join(library, projectId);
const actual = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8"));
assert.equal(actual.id, projectId, "server library must match the isolated fixture path");

for (const name of ["front-a.png", "front-b.png", "inner.png", "spine.png", "draft-ref.png", "candidate-ref.png", "orphan.png"]) {
  await fs.writeFile(path.join(dir, "assets", name), image);
}
actual.studio = {
  version: 1,
  printSource: "studio",
  parts: {
    front: {
      prompt: "",
      referenceFiles: [],
      candidates: [
        candidate("front-a", "front-a.png"),
        candidate("front-b", "front-b.png", { referenceFiles: ["candidate-ref.png"] }),
      ],
      presentation,
    },
    "front-inner": {
      prompt: "",
      referenceFiles: [],
      candidates: [candidate("inner-a", "inner.png")],
      presentation,
    },
    "back-spine": {
      prompt: "",
      referenceFiles: [],
      candidates: [candidate("spine-a", "spine.png")],
      presentation,
    },
  },
  snapshots: [],
};
await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(actual, null, 2));

const studio = (action) => call("PATCH", "/api/design/studio", { projectId, ...action });
const studioError = (action, status) => call("PATCH", "/api/design/studio", { projectId, ...action }, status);

assert.equal((await call("GET", `/api/design/studio?projectId=${projectId}`)).studio.parts.front.candidates.length, 2);
await studio({ action: "draft", part: "front", prompt: "Night skyline", referenceFiles: ["draft-ref.png"] });
await studio({ action: "draft", part: "back-spine", prompt: "Narrow vertical amber strip", referenceFiles: ["draft-ref.png"] });
assert.equal((await call("DELETE", `/api/projects/${projectId}/assets`, { filename: "draft-ref.png" }, 409)).error.length > 0, true);
assert.equal((await call("DELETE", `/api/projects/${projectId}/assets`, { filename: "candidate-ref.png" }, 409)).error.length > 0, true);
assert.equal((await call("DELETE", `/api/projects/${projectId}/assets`, { filename: "front-a.png" }, 409)).error.length > 0, true);

let project = await studio({ action: "select", part: "front", candidateId: "front-a" });
project = await studio({ action: "select", part: "back-spine", candidateId: "spine-a" });
assert.equal(project.studio.parts["back-spine"].selectedCandidateId, "spine-a");
assert.equal(project.studio.parts.front.selectedCandidateId, "front-a");
assert.equal(project.status, "designed", "selecting an image marks a draft album designed");
await studio({ action: "favorite", part: "front", candidateId: "front-b", favorite: true });
project = await studio({ action: "presentation", part: "front", presentation: {
  ...presentation,
  fit: "contain",
  transform: { offsetXMm: 3, offsetYMm: -2, scale: 1.25 },
  overlay: { enabled: true, color: "#aabbcc", position: "top", fontSizeMm: 8 },
} });
assert.equal(project.studio.parts.front.presentation.transform.offsetXMm, 3);
project = await studio({ action: "snapshot", name: "Chosen front" });
const snapshotId = project.studio.snapshots[0].id;
assert.equal(project.studio.snapshots[0].parts.front.candidateId, "front-a");
assert.equal(project.studio.snapshots[0].parts["back-spine"].candidateId, "spine-a");
await studio({ action: "select", part: "front", candidateId: "front-b" });
await studio({ action: "clear", part: "back-spine" });
await studio({ action: "select", part: "front-inner", candidateId: "inner-a" });
project = await studio({ action: "restore", snapshotId });
assert.equal(project.studio.parts.front.selectedCandidateId, "front-a");
assert.equal(project.studio.parts.front.presentation.fit, "contain");
assert.equal(project.studio.parts["back-spine"].selectedCandidateId, "spine-a", "restore includes spine selection");
assert.equal(project.studio.parts["front-inner"].selectedCandidateId, undefined, "restore clears absent selections");
await studioError({ action: "delete", part: "front", candidateId: "front-a" }, 409);
await studioError({ action: "delete", part: "back-spine", candidateId: "spine-a" }, 409);
await studio({ action: "delete-snapshot", snapshotId });
await studio({ action: "clear", part: "back-spine" });
project = await studio({ action: "snapshot", name: "Five-part snapshot" });
const oldSnapshotId = project.studio.snapshots[0].id;
assert.equal(project.studio.snapshots[0].parts["back-spine"], undefined);
await studio({ action: "select", part: "back-spine", candidateId: "spine-a" });
project = await studio({ action: "restore", snapshotId: oldSnapshotId });
assert.equal(project.studio.parts["back-spine"].selectedCandidateId, undefined, "older five-part snapshots clear spine selection");
await studio({ action: "delete-snapshot", snapshotId: oldSnapshotId });
await studioError({ action: "delete", part: "front", candidateId: "front-a" }, 409);
project = await studio({ action: "clear", part: "front" });
assert.equal(project.studio.printSource, "studio");
assert.equal(project.studio.parts.front.selectedCandidateId, undefined);
project = await studio({ action: "delete", part: "front", candidateId: "front-a" });
assert.equal(project.studio.parts.front.candidates.length, 1);
assert.equal((await fs.stat(path.join(dir, "assets", "front-a.png"))).isFile(), true, "candidate removal keeps physical file");

await studioError({ action: "select", part: "__proto__", candidateId: "front-b" }, 400);
await studioError({ action: "draft", part: "front", prompt: "x", referenceFiles: ["../escape.png"] }, 400);
await studioError({ action: "presentation", part: "front", presentation: { ...presentation, overlay: { ...presentation.overlay, color: "red" } } }, 400);
await studioError({ action: "unknown", part: "front" }, 400);
await studioError({ action: "select", part: "front", candidateId: "missing" }, 404);

project = await call("PATCH", `/api/projects/${projectId}`, { title: "Studio API test renamed" });
assert.equal(project.studio.parts.front.candidates[0].id, "front-b", "legacy PATCH keeps studio state");
await studio({ action: "print-source", printSource: "legacy" });
project = await studio({ action: "draft", part: "front", prompt: "", referenceFiles: [] });
assert.equal(project.studio.printSource, "legacy");
await call("DELETE", `/api/projects/${projectId}/assets`, { filename: "draft-ref.png" }, 409);
await studio({ action: "draft", part: "back-spine", prompt: "", referenceFiles: [] });
await call("DELETE", `/api/projects/${projectId}/assets`, { filename: "draft-ref.png" });
await call("DELETE", `/api/projects/${projectId}/assets`, { filename: "front-a.png" });

console.log(`PASS studio API project=${projectId} library=${library}`);
