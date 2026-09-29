import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const Module = require("node:module");

async function loadImageModule(fakeCodex) {
  const sourcePath = path.resolve("lib/image-generation.ts");
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const previousBin = process.env.CDSTUDIO_CODEX_BIN;
  process.env.CDSTUDIO_CODEX_BIN = fakeCodex;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const normalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => id === "./types"
    ? { STUDIO_PART_LABELS: { front: "앞표지", "front-inner": "앞표지 내부", label: "CD 라벨", back: "뒷표지", "back-inner": "뒷표지 내부", "back-spine": "뒷표지 스파인" } }
    : normalRequire(id);
  loaded._compile(compiled, sourcePath);
  if (previousBin === undefined) delete process.env.CDSTUDIO_CODEX_BIN;
  else process.env.CDSTUDIO_CODEX_BIN = previousBin;
  return loaded.exports;
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Codex reports ChatGPT login from stderr, and success text without an image is rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-image-test-"));
  try {
    const bin = path.join(dir, "fake-codex");
    await writeFile(bin, `#!/usr/bin/env node
if (process.argv[2] === 'login') {
  process.stderr.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');
`, { mode: 0o755 });
    await chmod(bin, 0o755);
    const image = await loadImageModule(bin);
    const status = await image.codexImageAvailability();
    assert.equal(status.connected, true);
    await assert.rejects(image.generateCodexImage({
      cwd: dir,
      part: "front",
      prompt: "abstract blue circle",
      referencePaths: [],
      outputPath: path.join(dir, "generated.png"),
    }), /이미지 파일을 만들지 않았습니다/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spine prompt requests one narrow reusable strip without tray or label artwork", async () => {
  const image = await loadImageModule("/nonexistent/fake-codex");
  const prompt = image.buildCodexPrompt("back-spine", "짙은 파란색", "/tmp/spine.png", []);
  assert.match(prompt, /one narrow vertical spine artwork/i);
  assert.match(prompt, /same single image will be reused on both left and right spines/i);
  assert.match(prompt, /Do not include a CD label, the central back cover, a jewel case mockup, or fold\/crop lines/i);
  const backPrompt = image.buildCodexPrompt("back", "짙은 파란색", "/tmp/back.png", []);
  assert.match(backPrompt, /central 137 x 118 mm panel/i);
  assert.match(backPrompt, /Do not draw side-spine artwork/i);
  assert.match(backPrompt, /full 150 x 118 mm tray card/i);
  const backInnerPrompt = image.buildCodexPrompt("back-inner", "짙은 파란색", "/tmp/back-inner.png", []);
  assert.match(backInnerPrompt, /150 x 118 mm printing/i);
  assert.match(backInnerPrompt, /both 6\.5 mm side folds/i);
  assert.doesNotMatch(backInnerPrompt, /central 137 x 118 mm panel/i);
});

test("print pixel targets preserve user-requested low-fi style and native files", async () => {
  const image = await loadImageModule("/nonexistent/fake-codex");
  const targets = [
    ["front", /120 x 120 mm.*1418 x 1418 pixels/],
    ["front-inner", /120 x 120 mm.*1418 x 1418 pixels/],
    ["back", /150 x 118 mm.*1772 x 1394 native pixels/],
    ["back-inner", /150 x 118 mm.*1772 x 1394 native pixels/],
    ["label", /116 mm.*1371 x 1371 pixels/],
    ["back-spine", /6\.5 x 118 mm.*256 x 1394 native pixels/],
  ];
  for (const [part, target] of targets) {
    const prompt = image.buildCodexPrompt(part, "Very soft focus, Low resolution, Old JPEG compression", "/tmp/artwork.png", []);
    assert.match(prompt, target, part);
    assert.match(prompt, /highest native output resolution available/i);
    assert.match(prompt, /print-ready native pixel count even when intentionally depicting soft focus, low-fi JPEG texture/i);
    assert.match(prompt, /If the pixel target is unavailable, keep the real native image rather than resizing or fabricating detail/i);
    assert.match(prompt, /Very soft focus, Low resolution, Old JPEG compression/);
  }
  const spinePrompt = image.buildCodexPrompt("back-spine", "긴 띠 형태", "/tmp/spine.png", []);
  assert.match(spinePrompt, /at least 256 pixels on both axes to pass image validation/i);
});

test("back artwork honors an explicitly requested track list without contradictory overlay instructions", async () => {
  const image = await loadImageModule("/nonexistent/fake-codex");
  const request = "뒷표지에 01. 첫 곡 / 02. 둘째 곡을 이 순서대로 적어 주세요.";
  for (const part of ["back", "back-inner"]) {
    const prompt = image.buildCodexPrompt(part, request, "/tmp/artwork.png", []);
    assert.match(prompt, /01\. 첫 곡 \/ 02\. 둘째 곡/);
    assert.match(prompt, /Treat a track list supplied in the user's request.*as text to render visibly in this image by default/i);
    assert.match(prompt, /Preserve the supplied track names, spelling, and order/i);
    assert.match(prompt, /Do not defer a visible track list to the app's optional print overlay/i);
    assert.doesNotMatch(prompt, /Do not paint track names/i);
    assert.doesNotMatch(prompt, /the app will overlay accurate text/i);
  }
});

test("a bare numbered list is visible back-cover text unless marked as reference only", async () => {
  const image = await loadImageModule("/nonexistent/fake-codex");
  const list = "01. 첫 곡\n02. 둘째 곡";
  for (const part of ["back", "back-inner"]) {
    const prompt = image.buildCodexPrompt(part, list, "/tmp/artwork.png", []);
    assert.match(prompt, /01\. 첫 곡\n02\. 둘째 곡/);
    assert.match(prompt, /including a bare numbered list, as text to render visibly in this image by default/i);
    assert.match(prompt, /If the user explicitly asks for no text in the image or asks to omit the track list, follow that instruction even when a list is supplied/i);
    assert.match(prompt, /Also omit the list if the user says it is context or reference only/i);
    assert.doesNotMatch(prompt, /Do not draw any text, letters, logos, or watermarks into the image unless the user explicitly asked for image text/i);
  }
  for (const part of ["front", "front-inner", "label", "back-spine"]) {
    const prompt = image.buildCodexPrompt(part, "앨범명: 푸른 밤, 아티스트: 이문세", "/tmp/artwork.png", []);
    assert.match(prompt, /Text supplied or requested by the user, including album titles, artist names, track lists, logos, and other lettering, may appear in the generated image/i);
    assert.match(prompt, /preserving its spelling and order as closely as possible/i);
    assert.match(prompt, /Do not invent unrelated text/i);
    assert.doesNotMatch(prompt, /Do not paint album title or artist/i);
    assert.doesNotMatch(prompt, /Do not draw any text, letters, logos, or watermarks/i);
    assert.doesNotMatch(prompt, /including a bare numbered list/i);
  }
});

test("an explicit no-text request takes precedence over a supplied back-cover list", async () => {
  const image = await loadImageModule("/nonexistent/fake-codex");
  const request = "01. 첫 곡\n02. 둘째 곡\n이미지에는 글자를 넣지 마.";
  for (const part of ["back", "back-inner"]) {
    const prompt = image.buildCodexPrompt(part, request, "/tmp/artwork.png", []);
    assert.match(prompt, /이미지에는 글자를 넣지 마/);
    assert.match(prompt, /follow that instruction even when a list is supplied/i);
    assert.match(prompt, /including a bare numbered list, as text to render visibly in this image by default/i);
  }
});

test("back print overlay copy names the project track list and possible image duplication", async () => {
  const source = await readFile(path.resolve("app/album/[id]/design/studio-client.tsx"), "utf8");
  assert.match(source, /activePart === "back" \|\| activePart === "back-inner" \? "앨범명·아티스트·트랙리스트 추가 표시" : "앨범명·아티스트 글자 표시"/);
  assert.match(source, /앨범에 등록된 오디오 트랙명을 이미지 위에 추가해 A4 미리보기·인쇄에 표시합니다/);
  assert.match(source, /프롬프트에 적은 세트리스트를 옮기는 기능은 아닙니다/);
  assert.match(source, /생성 이미지에 이미 같은 목록이 있으면 중복될 수 있습니다/);
});

test("an early successful CLI exit cannot accept a partially flushed stdin prompt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-image-early-stdin-test-"));
  try {
    const bin = path.join(dir, "fake-codex");
    await writeFile(bin, `#!/usr/bin/env node
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n', () => process.exit(0));
});
`, { mode: 0o755 });
    await chmod(bin, 0o755);
    const image = await loadImageModule(bin);
    await assert.rejects(image.runProcess(bin, ["exec", "-"], {
      cwd: dir, stdin: "한글과 긴 입력 ".repeat(200000), timeoutMs: 5000,
    }), /끝까지 전달하지 못했습니다/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort kills the CLI process group, including a helper that ignores SIGTERM", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-image-abort-test-"));
  try {
    const bin = path.join(dir, "fake-codex");
    const pidFile = path.join(dir, "grandchild.pid");
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
helper.stdout.once('data', () => fs.writeFileSync(process.env.TEST_PID_FILE, String(helper.pid)));
process.on('SIGTERM', () => process.exit(0));
setInterval(()=>{},1000);
`, { mode: 0o755 });
    await chmod(bin, 0o755);
    const image = await loadImageModule(bin);
    const previousPidFile = process.env.TEST_PID_FILE;
    process.env.TEST_PID_FILE = pidFile;
    try {
      const controller = new AbortController();
      const running = image.runProcess(bin, ["exec"], {
        cwd: dir, signal: controller.signal, timeoutMs: 5000,
        stdin: "긴 프롬프트 ".repeat(100000),
      });
      await waitForFile(pidFile);
      const pid = Number(await readFile(pidFile, "utf8"));
      controller.abort();
      await assert.rejects(running, /취소되었습니다/);
      let alive = true;
      const deadline = Date.now() + 2000;
      while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(alive, false, "SIGTERM-ignoring helper survived after abort");
    } finally {
      if (previousPidFile === undefined) delete process.env.TEST_PID_FILE;
      else process.env.TEST_PID_FILE = previousPidFile;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timeout terminates a hanging CLI", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-image-timeout-test-"));
  try {
    const bin = path.join(dir, "fake-codex");
    await writeFile(bin, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n", { mode: 0o755 });
    await chmod(bin, 0o755);
    const image = await loadImageModule(bin);
    await assert.rejects(image.runProcess(bin, ["exec"], { cwd: dir, timeoutMs: 100 }), /시간이 초과/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
