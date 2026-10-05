import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const Module = require("node:module");

async function loadArtifactsModule() {
  const sourcePath = path.resolve("lib/image-artifacts.ts");
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(compiled, sourcePath);
  return loaded.exports;
}

async function loadImageModule(fakeCodex, mocks = {}) {
  const artifacts = await loadArtifactsModule();
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
    : id === "./image-artifacts" ? artifacts
    : Object.hasOwn(mocks, id) ? mocks[id] : normalRequire(id);
  loaded._compile(compiled, sourcePath);
  if (previousBin === undefined) delete process.env.CDSTUDIO_CODEX_BIN;
  else process.env.CDSTUDIO_CODEX_BIN = previousBin;
  return loaded.exports;
}

test("generateCodexImage recovers only its JSONL thread artifact and validates it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-image-recover-test-"));
  const codexHome = path.join(dir, "codex-home");
  const threadId = "0199aa11-bb22-7cc3-8dd4-0123456789ab";
  const nativeName = "exec-0199aa11-bb22-7cc3-8dd4-abcdef012345.png";
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120, 1)]);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let schemaPath;
  let schemaMode;
  let schema;
  try {
    const spawn = (_command, args) => {
      const child = new EventEmitter();
      child.pid = 4321;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        if (args[0] === "login") {
          child.stderr.end("Logged in using ChatGPT\n");
        } else if (args[0] === "exec") {
          const schemaIndex = args.indexOf("--output-schema");
          assert.ok(schemaIndex >= 0);
          schemaPath = args[schemaIndex + 1];
          assert.equal(args[schemaIndex + 2], "-");
          schemaMode = statSync(schemaPath).mode & 0o777;
          schema = JSON.parse(require("node:fs").readFileSync(schemaPath, "utf8"));
          const nativeDir = path.join(codexHome, "generated_images", threadId);
          mkdirSync(nativeDir, { recursive: true });
          writeFileSync(path.join(nativeDir, nativeName), png);
          child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`);
          child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"failed","reason":"copy_failed"}' } })}\n`);
          child.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
          child.stdout.end();
        } else if (args.includes("-show_entries")) {
          child.stdout.end(JSON.stringify({ streams: [{ codec_name: "png", width: 1418, height: 1418 }] }));
        }
        child.stderr.end();
        child.stdout.end();
        child.emit("close", 0);
      });
      return child;
    };
    const image = await loadImageModule("/mock/codex", { child_process: { spawn } });
    const outputPath = path.join(dir, "generated.png");
    assert.deepEqual(await image.generateCodexImage({
      cwd: dir, part: "front", prompt: "recover", referencePaths: [], outputPath,
    }), { width: 1418, height: 1418 });
    assert.deepEqual(await readFile(outputPath), png);
    assert.equal(schemaMode, 0o600);
    assert.equal(schema.oneOf, undefined);
    assert.equal(schema.allOf, undefined);
    assert.equal(schema.properties.status.type, "string");
    assert.equal(schema.properties.reason.type, "string");
    assert.equal(schema.properties.explanation.type, "string");
    assert.equal(schema.properties.explanation.maxLength, 600);
    assert.equal(existsSync(schemaPath), false, "owned schema is removed after success");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a direct PNG cannot override a failed CLI turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-failed-turn-image-"));
  const outputPath = path.join(dir, "generated.png");
  try {
    await writeFile(outputPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120)]));
    const spawn = (_command, args) => {
      const child = new EventEmitter();
      child.pid = 4321; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      setImmediate(() => {
        if (args[0] === "login") child.stderr.write("Logged in using ChatGPT\n");
        else child.stdout.write(`${JSON.stringify({ type: "turn.failed" })}\n`);
        child.stdout.end(); child.stderr.end(); child.emit("close", args[0] === "login" ? 0 : 1);
      });
      return child;
    };
    const image = await loadImageModule("/mock/codex", { child_process: { spawn } });
    await assert.rejects(image.generateCodexImage({ cwd: dir, part: "front", prompt: "x", referencePaths: [], outputPath }), /완료되지 않았습니다/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("valid direct output does not depend on native thread metadata", async () => {
  for (const events of [
    [{ type: "thread.started", thread_id: "invalid" },
      { type: "item.completed", item: { type: "agent_message", text: '{"status":"failed","reason":"tool_error"}' } }],
    [{ type: "thread.started", thread_id: "0199aa11-bb22-7cc3-8dd4-0123456789ab" },
      { type: "thread.started", thread_id: "0199aa11-bb22-7cc3-8dd4-abcdef012345" }],
  ]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-direct-image-test-"));
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120, 1)]);
    const outputPath = path.join(dir, "generated.png");
    let executions = 0;
    try {
      await writeFile(outputPath, png);
      const spawn = (_command, args) => {
        const child = new EventEmitter();
        child.pid = 4321;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        setImmediate(() => {
          if (args[0] === "login") child.stderr.write("Logged in using ChatGPT\n");
          else if (args[0] === "exec") {
            executions += 1;
            for (const event of [...events, { type: "turn.completed" }]) child.stdout.write(`${JSON.stringify(event)}\n`);
          } else if (args.includes("-show_entries")) {
            child.stdout.write(JSON.stringify({ streams: [{ codec_name: "png", width: 1418, height: 1418 }] }));
          }
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0);
        });
        return child;
      };
      const image = await loadImageModule("/mock/codex", { child_process: { spawn } });
      assert.deepEqual(await image.generateCodexImage({ cwd: dir, part: "front", prompt: "direct", referencePaths: [], outputPath }), { width: 1418, height: 1418 });
      assert.equal(executions, 1);
      assert.deepEqual(await readFile(outputPath), png);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a normal completed turn reports its bounded failure reason when no PNG exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-reported-image-failure-"));
  try {
    const spawn = (_command, args) => {
      const child = new EventEmitter();
      child.pid = 4321; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      setImmediate(() => {
        if (args[0] === "login") child.stderr.write("Logged in using ChatGPT\n");
        else {
          child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"failed","reason":"moderation_blocked","explanation":"Failed at https://secret.invalid /Users/private/key OPENAI_API_KEY=sk-abcde\\u200bfghijklmnop"}' } })}\n`);
          child.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
        }
        child.stdout.end(); child.stderr.end(); child.emit("close", 0);
      });
      return child;
    };
    const image = await loadImageModule("/mock/codex", { child_process: { spawn } });
    await assert.rejects(image.generateCodexImage({ cwd: dir, part: "front", prompt: "x", referencePaths: [], outputPath: path.join(dir, "generated.png") }), (error) => {
      assert.match(error.message, /Codex가 이미지 서비스의 안전 검사에서 차단됐다고 응답했습니다/);
      assert.match(error.message, /같은 요청의 반복 대신 프롬프트·참고 이미지 검토가 필요합니다/);
      assert.doesNotMatch(error.message, /secret\.invalid|\/Users\/private|OPENAI_API_KEY|sk-abcde/);
      assert.doesNotMatch(error.message, /설명:/);
      return true;
    });
    assert.equal((await (await import("node:fs/promises")).readdir(dir)).some((name) => name.startsWith(".cdstudio-image-result-")), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("moderation report is explicit while the original user request remains verbatim", async () => {
  const image = await loadImageModule("/nonexistent/fake-codex");
  const userInput = `첫 줄 그대로\n${"가나다 ABC 123 !? ".repeat(3000)}\n마지막 줄 그대로`;
  const prompt = image.buildCodexPrompt("back", userInput, "/tmp/generated.png", []);
  assert.ok(prompt.includes(`User's image request begins:\n${userInput}\nUser's image request ends.`));
  assert.match(prompt, /use moderation_blocked only when the image tool actually reports that code or an output safety-review block/i);
});

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

test("image generation uses a 15-minute default and preserves bounded timeout overrides", async () => {
  const timeoutDelays = [];
  const spawnCalls = [];
  const spawn = (_command, args) => {
    spawnCalls.push(args);
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (args[0] === "login") {
        child.stderr.write("Logged in using ChatGPT\n");
        child.stderr.end();
        child.stdout.end();
        child.emit("close", 0);
      } else {
        child.stdout.write(`${JSON.stringify({ type: "turn.failed" })}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 1);
      }
    });
    return child;
  };
  const image = await loadImageModule("/mock/codex", { child_process: { spawn } });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const previousTimeout = process.env.CDSTUDIO_IMAGE_TIMEOUT_MS;
  globalThis.setTimeout = (_callback, delay) => {
    timeoutDelays.push(delay);
    return { delay };
  };
  globalThis.clearTimeout = () => {};
  try {
    const cases = [
      [undefined, 900_000],
      ["invalid", 900_000],
      ["29999", 900_000],
      ["900001", 900_000],
      ["30000", 30_000],
      ["900000", 900_000],
    ];
    for (const [configured, expected] of cases) {
      if (configured === undefined) delete process.env.CDSTUDIO_IMAGE_TIMEOUT_MS;
      else process.env.CDSTUDIO_IMAGE_TIMEOUT_MS = configured;
      timeoutDelays.length = 0;
      await assert.rejects(image.generateCodexImage({
        cwd: os.tmpdir(),
        part: "front",
        prompt: "timeout contract",
        referencePaths: [],
        outputPath: path.join(os.tmpdir(), "generated.png"),
      }), /완료되지 않았습니다/);
      assert.deepEqual(timeoutDelays, [10_000, expected], `timeout override ${configured ?? "unset"}`);
    }
    assert.equal(spawnCalls.length, 12, "each case runs login status and one generation command");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (previousTimeout === undefined) delete process.env.CDSTUDIO_IMAGE_TIMEOUT_MS;
    else process.env.CDSTUDIO_IMAGE_TIMEOUT_MS = previousTimeout;
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
  assert.match(backPrompt, /image canvas must not include either side-spine area/i);
  assert.match(backPrompt, /requested barcode, logo, album title, artist name, and track text.*inside a safe margin/i);
  assert.match(backPrompt, /Do not invent a barcode or logo/i);
  assert.match(backPrompt, /two 6\.5 mm side folds are composed separately/i);
  assert.doesNotMatch(backPrompt, /full 150 x 118 mm tray card/i);
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
    ["back", /137 x 118 mm.*1619 x 1394 native pixels/],
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
