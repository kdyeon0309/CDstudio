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
  const imageArtifacts = relativePath === "lib/image-generation.ts" ? await loadTs("lib/image-artifacts.ts") : undefined;
  const filename = path.join(root, relativePath);
  const source = await fs.readFile(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => Object.hasOwn(mocks, id) ? mocks[id]
    : id === "./image-artifacts" && imageArtifacts ? imageArtifacts : originalRequire(id);
  loaded._compile(compiled, filename);
  return loaded.exports;
}

const studio = await loadTs("lib/studio.ts", {
  "./storage": {},
  "./types": {
    ARTWORK_PARTS: ["front", "front-inner", "back", "back-inner", "label"],
    STUDIO_ARTWORK_PARTS: ["front", "front-inner", "back", "back-spine", "back-inner", "label"],
  },
});

test("studio draft prompts accept text beyond the former 4000-character limit", () => {
  const prompt = "길고 상세한 설명입니다. ".repeat(5000);
  assert.equal(studio.validateStudioPrompt(prompt), prompt);
  assert.equal(studio.validateStudioPrompt(""), "");
  assert.throws(() => studio.validateStudioPrompt(123), studio.StudioError);
});

test("temporary labels resolve in attachment order and reject ambiguous names", () => {
  const refs = ["face.png", "sky.png"];
  assert.deepEqual({ ...studio.validateStudioReferenceLabels(refs, undefined) }, {
    "face.png": "이미지 1", "sky.png": "이미지 2",
  });
  assert.deepEqual({ ...studio.validateStudioReferenceLabels(refs, { "face.png": " 주인공 " }) }, {
    "face.png": "주인공", "sky.png": "이미지 2",
  });
  for (const labels of [
    { "unknown.png": "기타" },
    { "face.png": "FOO", "sky.png": "foo" },
    { "face.png": "이미지 2", "sky.png": "배경" },
    { "face.png": "변형 원본" },
    { "face.png": "개\n고양이" },
    { "face.png": " " },
    { "face.png": "x".repeat(41) },
    { "face.png": 123 },
  ]) {
    assert.throws(() => studio.validateStudioReferenceLabels(refs, labels), studio.StudioError);
  }
});

test("reference file validation accepts ordered arrays beyond four and keeps safety checks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cdstudio-reference-files-test-"));
  try {
    const filenames = Array.from({ length: 8 }, (_, index) => `reference-${index + 1}.png`);
    for (const [index, filename] of filenames.entries()) {
      await fs.writeFile(path.join(directory, filename), `REF-${index + 1}`);
    }
    const validatingStudio = await loadTs("lib/studio.ts", {
      "./storage": { assetsDir: () => directory },
      "./types": {
        ARTWORK_PARTS: ["front", "front-inner", "back", "back-inner", "label"],
        STUDIO_ARTWORK_PARTS: ["front", "front-inner", "back", "back-spine", "back-inner", "label"],
      },
    });
    assert.deepEqual(
      await validatingStudio.validateStudioReferenceFiles("project", filenames),
      filenames,
      "all safe references retain their exact order",
    );
    await assert.rejects(validatingStudio.validateStudioReferenceFiles("project", "reference-1.png"), /목록/);
    await assert.rejects(validatingStudio.validateStudioReferenceFiles("project", [filenames[0], filenames[0]]), /파일명/);
    await assert.rejects(validatingStudio.validateStudioReferenceFiles("project", ["../reference.png"]), /파일명/);
    await assert.rejects(validatingStudio.validateStudioReferenceFiles("project", ["reference.gif"]), /파일명/);
    await assert.rejects(validatingStudio.validateStudioReferenceFiles("project", ["missing.png"]), /찾을 수 없습니다/);
    await fs.symlink(path.join(directory, filenames[0]), path.join(directory, "linked.png"));
    await assert.rejects(validatingStudio.validateStudioReferenceFiles("project", ["linked.png"]), /일반 파일/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const base = process.env.TEST_BASE_URL;
const library = process.env.CDSTUDIO_TEST_LIBRARY;
if (base || library) {
  if (!base || !/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)) {
    throw new Error("TEST_BASE_URL must be an explicit localhost server URL");
  }
  if (!library || !path.isAbsolute(library)
    || !/^\/(?:private\/)?tmp\/cdstudio-ref-labels-integration\.[^/]+$/.test(library)) {
    throw new Error("CDSTUDIO_TEST_LIBRARY must be a dedicated ref-labels integration path");
  }
}

async function call(method, endpoint, body, status = 200) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

test("studio draft stores only explicit names and rejects malformed maps atomically", { skip: !base }, async () => {
  const project = await call("POST", "/api/projects", { title: "Reference label test", artist: "Test" }, 201);
  const directory = path.join(library, project.id);
  const stored = JSON.parse(await fs.readFile(path.join(directory, "project.json"), "utf8"));
  assert.equal(stored.id, project.id, "server library must match isolated fixture path");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
  for (const filename of ["face.png", "sky.png"]) {
    await fs.writeFile(path.join(directory, "assets", filename), png);
  }
  const draft = (referenceLabels, status = 200) => call("PATCH", "/api/design/studio", {
    projectId: project.id, action: "draft", part: "front", prompt: "주인공과 배경", referenceFiles: ["face.png", "sky.png"],
    ...(referenceLabels === undefined ? {} : { referenceLabels }),
  }, status);
  let updated = await draft({ "face.png": " 주인공 " });
  assert.deepEqual(updated.studio.parts.front.referenceLabels, { "face.png": "주인공" });
  for (const labels of [
    { "other.png": "기타" },
    { "face.png": "FOO", "sky.png": "foo" },
    { "face.png": "이미지 2", "sky.png": "배경" },
    { "face.png": "변형 원본" },
    { "face.png": "a\nb" },
    { "face.png": " " },
  ]) {
    await draft(labels, 400);
  }
  updated = await call("GET", `/api/design/studio?projectId=${project.id}`);
  assert.deepEqual(updated.studio.parts.front.referenceLabels, { "face.png": "주인공" }, "failed drafts must not mutate state");
  updated = await draft(undefined);
  assert.deepEqual(updated.studio.parts.front.referenceLabels, {}, "old clients can omit the name map");
  const longPrompt = "길고 상세한 설명입니다. ".repeat(5000);
  updated = await call("PATCH", "/api/design/studio", {
    projectId: project.id, action: "draft", part: "front", prompt: longPrompt,
    referenceFiles: ["face.png", "sky.png"], referenceLabels: { "face.png": "주인공" },
  });
  assert.equal(updated.studio.parts.front.prompt, longPrompt);
  const savedProject = JSON.parse(await fs.readFile(path.join(directory, "project.json"), "utf8"));
  assert.equal(savedProject.studio.parts.front.prompt, longPrompt);
});

test("long studio prompts save and generate while preserving ordered name provenance", async () => {
  const image = await loadTs("lib/image-generation.ts", {
    "./types": { STUDIO_PART_LABELS: { front: "앞표지" } },
  });
  const prompt = image.buildCodexPrompt("front", "주인공을 배경 앞에", "/tmp/generated.png", ["주인공", "배경", "변형 원본"]);
  assert.ok(prompt.indexOf('Attached image 1 (이미지 1): "주인공"') < prompt.indexOf('Attached image 2 (이미지 2): "배경"'));
  assert.ok(prompt.indexOf('Attached image 2 (이미지 2): "배경"') < prompt.indexOf('Attached image 3 (이미지 3): "변형 원본"'));
  assert.ok(prompt.indexOf('Attached image 3 (이미지 3): "변형 원본"') < prompt.indexOf("User's image request begins:"));

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cdstudio-label-route-test-"));
  try {
    const assets = path.join(directory, "assets");
    await fs.mkdir(assets);
    const manyReferences = Array.from({ length: 6 }, (_, index) => `reference-${index + 1}.png`);
    const manyLabels = Object.fromEntries(manyReferences.map((filename, index) => [filename, `참고 ${index + 1}`]));
    for (const [filename, value] of [
      ["face.png", "FACE"], ["sky.png", "SKY"], ["parent.png", "PARENT"],
      ...manyReferences.map((filename, index) => [filename, `REF-${index + 1}`]),
    ]) {
      await fs.writeFile(path.join(assets, filename), value);
    }
    const routeStudio = await loadTs("lib/studio.ts", {
      "./storage": { assetsDir: () => assets },
      "./types": {
        ARTWORK_PARTS: ["front", "front-inner", "back", "back-inner", "label"],
        STUDIO_ARTWORK_PARTS: ["front", "front-inner", "back", "back-spine", "back-inner", "label"],
      },
    });
    const projectId = "12345678-1234-1234-1234-123456789abc";
    const parentId = "87654321-4321-4321-4321-cba987654321";
    const candidate = { id: parentId, filename: "parent.png", referenceFiles: [], prompt: "", width: 512, height: 512, createdAt: "2026-01-01" };
    const project = { id: projectId, studio: { parts: { front: { prompt: "", referenceFiles: [], candidates: [candidate] } } } };
    const longPrompt = "길고 상세한 설명입니다. ".repeat(5000).trim();
    const studioRoute = await loadTs("app/api/design/studio/route.ts", {
      "@/lib/storage": { assetsDir: () => assets, getProject: async () => project },
      "@/lib/server-guards": { rejectCrossOrigin: () => null, releaseJobLock: () => {} },
      "@/lib/studio": {
        applyStudioAction: async (_projectId, action) => {
          project.studio.parts.front.prompt = action.prompt;
          project.studio.parts.front.referenceFiles = [...action.referenceFiles];
          project.studio.parts.front.referenceLabels = { ...action.referenceLabels };
          return project;
        },
        isArtworkPart: (part) => part === "front",
        MAX_STUDIO_BODY_BYTES: studio.MAX_STUDIO_BODY_BYTES,
        StudioError: routeStudio.StudioError,
        validateStudioPrompt: studio.validateStudioPrompt,
        validateStudioReferenceFiles: routeStudio.validateStudioReferenceFiles,
        validateStudioReferenceLabels: routeStudio.validateStudioReferenceLabels,
      },
      "../shared": {
        acquireDesignLock: () => ({ key: "test", token: "test" }),
        acquireDesignPartLock: () => ({ key: "test", token: "test" }),
        designBusyResponse: () => new Response(null, { status: 409 }),
        designPartBusyResponse: () => new Response(null, { status: 409 }),
      },
    });
    const draftResponse = await studioRoute.PATCH(new Request("http://127.0.0.1:3219/api/design/studio", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId, action: "draft", part: "front", prompt: longPrompt,
        referenceFiles: manyReferences, referenceLabels: manyLabels,
      }),
    }));
    assert.equal(draftResponse.status, 200);
    const drafted = await draftResponse.json();
    assert.equal(drafted.studio.parts.front.prompt, longPrompt);
    assert.deepEqual(drafted.studio.parts.front.referenceFiles, manyReferences);
    assert.deepEqual(drafted.studio.parts.front.referenceLabels, manyLabels);
    let generated;
    let saved;
    const route = await loadTs("app/api/design/image/route.ts", {
      "@/lib/storage": { assetsDir: () => assets, getProject: async () => project },
      "@/lib/server-guards": { rejectCrossOrigin: () => null, releaseJobLock: () => {} },
      "@/lib/studio": {
        appendStudioCandidate: async (_projectId, _part, value) => { saved = value; return project; },
        getStudioPart: () => project.studio.parts.front,
        isArtworkPart: (part) => part === "front",
        MAX_STUDIO_CANDIDATES: 100,
        MAX_STUDIO_BODY_BYTES: studio.MAX_STUDIO_BODY_BYTES,
        StudioError: routeStudio.StudioError,
        validateStudioReferenceFiles: routeStudio.validateStudioReferenceFiles,
        validateStudioReferenceLabels: routeStudio.validateStudioReferenceLabels,
      },
      "@/lib/image-generation": {
        codexImageAvailability: async () => ({ connected: true, message: "ready" }),
        createImageWorkspace: async () => fs.mkdtemp(path.join(directory, "workspace-")),
        generateCodexImage: async (options) => {
          generated = {
            prompt: options.prompt,
            names: options.referenceNames,
            contents: await Promise.all(options.referencePaths.map((file) => fs.readFile(file, "utf8"))),
          };
          await fs.writeFile(options.outputPath, "FAKE GENERATED PNG");
          return { width: 512, height: 512 };
        },
        ImageGenerationError: class ImageGenerationError extends Error {},
      },
      "../shared": {
        acquireDesignPartLock: () => ({ key: "test", token: "test" }),
        designPartBusyResponse: () => new Response(null, { status: 409 }),
      },
    });
    async function generate(referenceFiles, referenceLabels, prompt = longPrompt) {
      const response = await route.POST(new Request("http://127.0.0.1:3219/api/design/image", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, part: "front", prompt, referenceFiles, referenceLabels, parentCandidateId: parentId }),
      }));
      assert.equal(response.status, 200);
      const events = await response.text();
      assert.match(events, /"type":"done"/);
    }
    await generate(manyReferences, manyLabels);
    assert.deepEqual(generated.contents, ["REF-1", "REF-2", "REF-3", "REF-4", "REF-5", "REF-6", "PARENT"], "parent must follow all six explicit references");
    assert.equal(generated.prompt, longPrompt);
    assert.deepEqual(generated.names, [...Object.values(manyLabels), "변형 원본"]);
    assert.equal(saved.prompt, longPrompt);
    assert.deepEqual(saved.referenceFiles, manyReferences);
    assert.deepEqual({ ...saved.referenceLabels }, manyLabels);
    assert.equal(saved.parentCandidateId, parentId);

    const variationPrompt = `${longPrompt}\n수정 요청: ${"조명을 밝게 ".repeat(1000).trim()}`;
    await generate(["face.png", "parent.png"], { "face.png": "주인공", "parent.png": "이전 표지" }, variationPrompt);
    assert.equal(generated.prompt, variationPrompt);
    assert.equal(saved.prompt, variationPrompt);
    assert.deepEqual(generated.contents, ["FACE", "PARENT"], "explicit parent must not be attached twice");
    assert.deepEqual(generated.names, ["주인공", "이전 표지 (변형 원본)"]);
    assert.deepEqual({ ...saved.referenceLabels }, { "face.png": "주인공", "parent.png": "이전 표지" });

    const oversizedReference = "oversized.png";
    await fs.writeFile(path.join(assets, oversizedReference), "x");
    await fs.truncate(path.join(assets, oversizedReference), 20 * 1024 * 1024 + 1);
    const oversizedReferenceResponse = await route.POST(new Request("http://127.0.0.1:3219/api/design/image", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId, part: "front", prompt: "크기 검사",
        referenceFiles: [oversizedReference], referenceLabels: { [oversizedReference]: "대용량" },
      }),
    }));
    assert.equal(oversizedReferenceResponse.status, 200);
    assert.match(await oversizedReferenceResponse.text(), /참고 이미지는 20MB 이하의 일반 파일이어야 합니다/);

    const oversizedPrompt = "a".repeat(studio.MAX_STUDIO_BODY_BYTES);
    const oversizedDraft = await studioRoute.PATCH(new Request("http://127.0.0.1:3219/api/design/studio", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, action: "draft", part: "front", prompt: oversizedPrompt, referenceFiles: [] }),
    }));
    assert.equal(oversizedDraft.status, 413, "draft requests still enforce the shared body cap");
    const oversizedGeneration = await route.POST(new Request("http://127.0.0.1:3219/api/design/image", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, part: "front", prompt: oversizedPrompt, referenceFiles: [] }),
    }));
    assert.equal(oversizedGeneration.status, 413, "generation requests still enforce the shared body cap");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Codex receives the mapped prompt before images in the same order", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cdstudio-label-cli-test-"));
  const previousBin = process.env.CDSTUDIO_CODEX_BIN;
  const previousCapture = process.env.CDSTUDIO_TEST_ARGV_FILE;
  try {
    const bin = path.join(directory, "fake-codex");
    const argvFile = path.join(directory, "argv.json");
    await fs.writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'login') {
  process.stderr.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.CDSTUDIO_TEST_ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
});
`, { mode: 0o755 });
    process.env.CDSTUDIO_CODEX_BIN = bin;
    process.env.CDSTUDIO_TEST_ARGV_FILE = argvFile;
    const image = await loadTs("lib/image-generation.ts", {
      "./types": { STUDIO_PART_LABELS: { front: "앞표지" } },
    });
    const refs = Array.from({ length: 6 }, (_, index) => path.join(directory, `reference-${index + 1}.png`));
    const names = Array.from({ length: 6 }, (_, index) => `참고 ${index + 1}`);
    const longPrompt = "주인공과 배경 ".repeat(20000);
    await assert.rejects(image.generateCodexImage({
      cwd: directory, part: "front", prompt: longPrompt, referencePaths: refs,
      referenceNames: names, outputPath: path.join(directory, "generated.png"),
    }), /이미지 파일을 만들지 않았습니다/);
    const { argv, prompt } = JSON.parse(await fs.readFile(argvFile, "utf8"));
    const imageFlag = argv.indexOf("-i");
    assert.ok(imageFlag > 0);
    assert.deepEqual(argv.slice(imageFlag + 1), refs);
    assert.equal(argv[imageFlag - 1], "-", "the prompt must use stdin before the image flag");
    assert.ok(prompt.includes(longPrompt), "the full long prompt reaches stdin");
    for (const [index, name] of names.entries()) {
      assert.match(prompt, new RegExp(`Attached image ${index + 1} \\(이미지 ${index + 1}\\): "${name}"`));
    }
    assert.ok(prompt.indexOf('Attached image 6 (이미지 6): "참고 6"') < prompt.indexOf("User's image request begins:"));
  } finally {
    if (previousBin === undefined) delete process.env.CDSTUDIO_CODEX_BIN;
    else process.env.CDSTUDIO_CODEX_BIN = previousBin;
    if (previousCapture === undefined) delete process.env.CDSTUDIO_TEST_ARGV_FILE;
    else process.env.CDSTUDIO_TEST_ARGV_FILE = previousCapture;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
