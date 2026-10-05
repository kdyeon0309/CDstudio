import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2022,
    },
  });
  module._compile(result.outputText, filename);
};

const generation = require(path.join(root, "lib/studio-generation.ts"));
const studioSource = fs.readFileSync(path.join(root, "app/album/[id]/design/studio-client.tsx"), "utf8");

function extractedStudioFunction(name, dependencies) {
  const sourceFile = ts.createSourceFile("studio-client.tsx", studioSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(declaration, `${name} declaration exists`);
  const compiled = ts.transpileModule(`const extracted = (${declaration.getText(sourceFile)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...Object.keys(dependencies), `${compiled}\nreturn extracted;`)(...Object.values(dependencies));
}

function extractedStudioVariable(name, dependencies) {
  const sourceFile = ts.createSourceFile("studio-client.tsx", studioSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      initializer = node.initializer;
    }
    if (!initializer) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(initializer, `${name} variable exists`);
  const compiled = ts.transpileModule(`const extracted = (${initializer.getText(sourceFile)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...Object.keys(dependencies), `${compiled}\nreturn extracted;`)(...Object.values(dependencies));
}

const presentation = (scale = 1) => ({
  fit: "cover",
  transform: { offsetXMm: 0, offsetYMm: 0, scale },
  overlay: { enabled: false, color: "#ffffff", position: "bottom", fontSizeMm: 4 },
});

const candidate = (id, part) => ({
  id,
  filename: `${part}-${id}.png`,
  prompt: `${part}-${id}`,
  referenceFiles: [],
  width: 1200,
  height: 1200,
  createdAt: "2026-10-02T00:00:00.000Z",
});

function project(updatedAt, frontCandidates = [], backCandidates = []) {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    title: "앨범",
    artist: "아티스트",
    status: "ready",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    tracks: [],
    artwork: { variants: [] },
    studio: {
      version: 1,
      printSource: "studio",
      snapshots: [],
      parts: {
        front: {
          prompt: "현재 프롬프트",
          referenceFiles: ["current.png"],
          referenceLabels: { "current.png": "현재 참고" },
          candidates: frontCandidates,
          selectedCandidateId: frontCandidates[0]?.id,
          presentation: presentation(1.25),
        },
        back: {
          prompt: "현재 뒷면",
          referenceFiles: [],
          candidates: backCandidates,
          selectedCandidateId: backCandidates[0]?.id,
          presentation: presentation(),
        },
      },
    },
  };
}

function job(part, token) {
  return {
    part,
    token,
    prompt: `${part} prompt`,
    referenceFiles: [],
    referenceNames: [],
    startedAt: 1000,
    phase: "준비",
    status: "running",
  };
}

test("front and back reserve independently while the same part rejects a duplicate", () => {
  let jobs = {};
  let result = generation.beginStudioGeneration(jobs, job("front", "front-1"));
  assert.equal(result.started, true);
  jobs = result.jobs;
  result = generation.beginStudioGeneration(jobs, job("back", "back-1"));
  assert.equal(result.started, true);
  jobs = result.jobs;
  assert.equal(generation.hasRunningStudioGeneration(jobs), true);

  const duplicate = generation.beginStudioGeneration(jobs, job("front", "front-2"));
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.jobs, jobs);
  assert.equal(jobs.front.token, "front-1");
  assert.equal(jobs.back.token, "back-1");
});

test("status, cancellation, and retry tokens remain independent", () => {
  let jobs = { front: job("front", "old"), back: job("back", "back") };
  jobs = generation.updateStudioGeneration(jobs, "front", "old", {
    phase: "중단 요청",
    cancelRequested: true,
  });
  assert.equal(jobs.front.cancelRequested, true);
  assert.equal(jobs.back.phase, "준비");

  jobs = generation.updateStudioGeneration(jobs, "front", "old", {
    status: "cancelled",
    error: "중단됨",
    finishedAt: 3000,
  });
  jobs = generation.beginStudioGeneration(jobs, job("front", "retry")).jobs;
  const afterOldFinally = generation.updateStudioGeneration(jobs, "front", "old", {
    status: "error",
    error: "오래된 finally",
  });
  assert.equal(afterOldFinally, jobs, "an old job cannot clear or overwrite its retry");
  assert.equal(afterOldFinally.front.token, "retry");
  assert.equal(generation.studioGenerationElapsed({ ...jobs.back, finishedAt: 62_000 }, 99_000), "01:01");
});

test("abort-all reaches every running controller without unlocking reservations", () => {
  const front = new AbortController();
  const back = new AbortController();
  const controllers = new Map([
    ["front", { token: "front", controller: front }],
    ["back", { token: "back", controller: back }],
  ]);
  generation.abortAllStudioGenerations(controllers);
  assert.equal(front.signal.aborted, true);
  assert.equal(back.signal.aborted, true);
  assert.equal(controllers.size, 2, "abort does not release a part before its reader settles");
});

test("actual switchPart leaves a dirty variation area without PATCHing its held lock", async () => {
  const frontController = new AbortController();
  const generationControllersRef = { current: new Map([
    ["front", { token: "front-job", controller: frontController }],
  ]) };
  const calls = [];
  const activePartRef = { current: "front" };
  let activePart = "front";
  const makeSwitch = (controllers = generationControllersRef) => extractedStudioFunction("switchPart", {
    activePart,
    busyRef: { current: false },
    setPendingPreset: () => calls.push("pending"),
    setBusy: (value) => calls.push(["busy", value]),
    setError: () => {},
    generationControllersRef: controllers,
    persistDraftIfValid: async () => { throw new Error("same-part PATCH would return 409"); },
    persistPresentation: async () => { throw new Error("same-part PATCH would return 409"); },
    activePartRef,
    setActivePart: (part) => { activePart = part; calls.push(["active", part]); },
    project: {},
    studioPart: (_project, part) => ({
      candidates: part === "back" ? [candidate("back-ready", "back")] : [],
      selectedCandidateId: part === "back" ? "back-ready" : undefined,
    }),
    setPreviewId: (id) => calls.push(["preview", id]),
    variationSeed: (item) => item.prompt,
    setVariationBase: (value) => calls.push(["variation", value]),
    setCompareId: () => {},
    setVariationText: () => {},
  });

  const switchPart = makeSwitch();
  await switchPart("back");
  assert.equal(activePart, "back");
  assert.equal(activePartRef.current, "back");
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "preview" && call[1] === "back-ready"));
  assert.equal(generationControllersRef.current.has("front"), true, "front remains reserved until its stream settles");

  let jobs = generation.beginStudioGeneration({}, job("front", "front-job")).jobs;
  jobs = generation.beginStudioGeneration(jobs, job("back", "back-job")).jobs;
  assert.deepEqual(Object.keys(jobs).sort(), ["back", "front"], "back can start while the dirty variation keeps running");

  let draftSaves = 0;
  let presentationSaves = 0;
  const normalControllers = { current: new Map() };
  const normalSwitch = extractedStudioFunction("switchPart", {
    activePart: "front",
    busyRef: { current: false },
    setPendingPreset: () => {},
    setBusy: () => {},
    setError: () => {},
    generationControllersRef: normalControllers,
    persistDraftIfValid: async () => { draftSaves += 1; return true; },
    persistPresentation: async () => { presentationSaves += 1; return true; },
    activePartRef: { current: "front" },
    setActivePart: () => {},
    project: {},
    studioPart: () => ({ candidates: [] }),
    setPreviewId: () => {},
    variationSeed: () => "",
    setVariationBase: () => {},
    setCompareId: () => {},
    setVariationText: () => {},
  });
  await normalSwitch("back");
  assert.equal(draftSaves, 1);
  assert.equal(presentationSaves, 1);
});

test("actual link interceptor saves dirty state but leaves server jobs running", async () => {
  class MockElement {
    closest() { return this.anchor ?? null; }
  }
  class MockAnchor extends MockElement {
    constructor(href) { super(); this.href = href; }
    hasAttribute() { return false; }
    getAttribute() { return null; }
  }
  const anchor = new MockAnchor("http://localhost/next");
  const target = new MockElement();
  target.anchor = anchor;
  const event = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    prevented: 0,
    preventDefault() { this.prevented += 1; this.defaultPrevented = true; },
  };
  const controller = new AbortController();
  const generationControllersRef = { current: new Map([
    ["front", { token: "front", controller }],
  ]) };
  const busyRef = { current: true };
  const notices = [];
  let confirms = 0;
  let persisted = 0;
  const fakeWindow = {
    location: { href: "http://localhost/current", origin: "http://localhost" },
    confirm() { confirms += 1; return true; },
  };
  const interceptLink = extractedStudioVariable("interceptLink", {
    Element: MockElement,
    HTMLAnchorElement: MockAnchor,
    URL,
    window: fakeWindow,
    busyRef,
    setNotice: (message) => notices.push(message),
    generationControllersRef,
    setBusy: () => {},
    persistDirtyStateForNavigation: async () => { persisted += 1; return true; },
    abortAllStudioGenerations: generation.abortAllStudioGenerations,
    suppressBeforeUnloadRef: { current: false },
  });

  interceptLink(event);
  assert.equal(event.prevented, 1);
  assert.equal(confirms, 0, "a blocked click does not ask a misleading abort question");
  assert.equal(persisted, 0);
  assert.equal(controller.signal.aborted, false);
  assert.equal(fakeWindow.location.href, "http://localhost/current");
  assert.deepEqual(notices, ["현재 저장 작업을 마치는 중입니다. 완료 후 다시 이동해 주세요."]);

  busyRef.current = false;
  event.defaultPrevented = false;
  interceptLink(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirms, 0);
  assert.equal(persisted, 1);
  assert.equal(controller.signal.aborted, false);
  assert.equal(fakeWindow.location.href, "http://localhost/next");
});

test("draft cache, selection, and upload preserve references beyond four", async () => {
  const references = Array.from({ length: 6 }, (_, index) => `reference-${index + 1}.png`);
  const labels = Object.fromEntries(references.map((filename, index) => [filename, `참고 ${index + 1}`]));
  const cachedDraft = { prompt: "여섯 장", referenceFiles: references, referenceLabels: labels };
  const readDraftCache = extractedStudioFunction("readDraftCache", {
    sessionStorage: { getItem: () => JSON.stringify({ drafts: { front: cachedDraft } }) },
    cacheKey: () => "cache",
    STUDIO_ARTWORK_PARTS: ["front"],
    MAX_REFERENCE_LABEL: 40,
    validPresentation: () => false,
  });
  const restored = readDraftCache("project");
  assert.deepEqual(restored.drafts.front.referenceFiles, references);
  assert.deepEqual(restored.drafts.front.referenceLabels, labels);

  let edited;
  const fifth = "reference-5.png";
  const initialDraft = {
    prompt: "",
    referenceFiles: references.slice(0, 4),
    referenceLabels: Object.fromEntries(references.slice(0, 4).map((filename, index) => [filename, `참고 ${index + 1}`])),
  };
  const makeToggle = (draft) => extractedStudioFunction("toggleReference", {
    generationControllersRef: { current: new Map() },
    activePart: "front",
    draft,
    setError: () => {},
    editDraft: (next) => { edited = next; },
  });
  makeToggle(initialDraft)(fifth);
  assert.deepEqual(edited.referenceFiles, [...initialDraft.referenceFiles, fifth], "a fifth selection is accepted");
  const selectedWithLabel = { ...edited, referenceLabels: { ...edited.referenceLabels, [fifth]: "다섯 번째" } };
  makeToggle(selectedWithLabel)(fifth);
  assert.deepEqual(edited.referenceFiles, initialDraft.referenceFiles, "a selected reference can still be removed");
  assert.equal(edited.referenceLabels[fifth], undefined, "removing a reference cleans its label");

  let uploadedDraft;
  const uploadReference = extractedStudioFunction("uploadReference", {
    busyRef: { current: false },
    generationControllersRef: { current: new Map() },
    activePart: "front",
    MAX_UPLOAD_BYTES: 20 * 1024 * 1024,
    setError: () => {},
    setBusy: () => {},
    FormData,
    fetch: async () => Response.json({ filename: fifth }),
    projectUrl: () => "/api/projects/project",
    projectId: "project",
    responseError: async () => "error",
    setAssets: (apply) => apply(initialDraft.referenceFiles),
    editDraft: (next) => { uploadedDraft = next; },
    draft: initialDraft,
    setNotice: () => {},
  });
  await uploadReference({ size: 1 });
  assert.deepEqual(uploadedDraft.referenceFiles, [...initialDraft.referenceFiles, fifth], "upload can add a fifth reference");

  assert.doesNotMatch(studioSource, /MAX_REFERENCE_FILES|최대 4장|\/4\)/);
  assert.match(studioSource, /referenceFiles\.length\}장 선택/);
  assert.match(studioSource, /참고 이미지 장수 제한은 없습니다/);
  assert.match(studioSource, /이미지가 많으면 업로드와 생성 준비에 더 오래 걸릴 수 있습니다/);
});

test("reverse generation and part PATCH delivery preserves both areas and monotonic time", () => {
  const frontOld = candidate("front-old", "front");
  const frontNew = candidate("front-new", "front");
  const backOld = candidate("back-old", "back");
  const backNew = candidate("back-new", "back");
  const initial = project("2026-10-02T00:00:03.000Z", [frontOld], [backOld]);

  const staleFrontResponse = project("2026-10-02T00:00:01.000Z", [frontOld, frontNew], []);
  staleFrontResponse.studio.parts.front.prompt = "서버의 오래된 프롬프트";
  staleFrontResponse.studio.parts.front.referenceFiles = [];
  staleFrontResponse.studio.parts.front.referenceLabels = {};
  staleFrontResponse.studio.parts.front.presentation = presentation(0.5);
  delete staleFrontResponse.studio.parts.front.selectedCandidateId;

  const backPatchResponse = project("2026-10-02T00:00:02.000Z", [], [backOld, backNew]);
  backPatchResponse.studio.parts.back.prompt = "저장된 뒷면";

  const generatedFirst = generation.mergeStudioGenerationProject(initial, staleFrontResponse, "front", frontNew);
  const patchLast = generation.mergeStudioPartProject(generatedFirst, backPatchResponse, "back");
  assert.deepEqual(patchLast.studio.parts.front.candidates.map((item) => item.id), ["front-old", "front-new"]);
  assert.deepEqual(patchLast.studio.parts.back.candidates.map((item) => item.id), ["back-old", "back-new"]);
  assert.equal(patchLast.updatedAt, initial.updatedAt, "a stale response cannot move updatedAt backwards");

  const patchFirst = generation.mergeStudioPartProject(initial, backPatchResponse, "back");
  const generatedLast = generation.mergeStudioGenerationProject(patchFirst, staleFrontResponse, "front", frontNew);
  assert.deepEqual(generatedLast.studio.parts.back.candidates.map((item) => item.id), ["back-old", "back-new"]);
  assert.equal(generatedLast.studio.parts.front.prompt, "현재 프롬프트");
  assert.deepEqual(generatedLast.studio.parts.front.referenceFiles, ["current.png"]);
  assert.deepEqual(generatedLast.studio.parts.front.referenceLabels, { "current.png": "현재 참고" });
  assert.equal(generatedLast.studio.parts.front.presentation.transform.scale, 1.25);
  assert.equal(generatedLast.studio.parts.front.selectedCandidateId, "front-old");
});

test("source wiring keeps background completion isolated and only global actions blocked", () => {
  assert.match(studioSource, /generationControllersRef\.current\.has\(part\)/, "same-area synchronous ref guard exists");
  assert.match(studioSource, /activePartRef\.current === part[\s\S]*setPreviewId\(event\.candidate\.id\)/, "inactive completion cannot change visible preview state");
  assert.match(studioSource, /mergeStudioGenerationProject\(current, event\.project, part, event\.candidate\)/, "background completion uses scoped functional merge");
  assert.doesNotMatch(studioSource, /setProject\(event\.project\)/, "SSE never blindly replaces the project");
  assert.match(studioSource, /<button key=\{part\} type="button" disabled=\{Boolean\(busy\)\}/, "area tabs remain enabled during background generation");
  assert.match(studioSource, /<DesignPresetPicker[\s\S]*?disabled=\{areaBusy\}/, "only the generating area blocks its preset editor");
  assert.match(studioSource, /disabled=\{Boolean\(busy\)\}[\s\S]*?openPrint/, "print navigation remains available while server jobs run");
  assert.match(studioSource, /departingPartIsGenerating[\s\S]*?!departingPartIsGenerating && !\(await persistDraftIfValid\(activePart\)\)/, "a dirty variation draft stays cached while switching away from its running part");
  assert.match(studioSource, /draftDirty\[part\] && !generationControllersRef\.current\.has\(part\)/, "confirmed navigation skips server saves for locked running parts");
  assert.match(studioSource, /const effectiveReferences = parent \?\? draft/, "a valid parent variation does not validate an unrelated unsaved draft");
  assert.doesNotMatch(studioSource, /abortAllStudioGenerations\(generationControllersRef\.current\)/, "navigation never aborts server jobs");
  assert.match(studioSource, /cancelBackgroundJob\(projectId, reservation\.jobId\)/, "only explicit cancellation calls DELETE");
  assert.match(studioSource, /observer\.finished\.then[\s\S]*generationControllersRef\.current\.delete\(part\)/, "reservation is released after terminal server state");
});
