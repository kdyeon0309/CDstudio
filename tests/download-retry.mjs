import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("lib/audio.ts");
const source = await readFile(sourcePath, "utf8");

async function fixture(mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdstudio-download-retry-"));
  const bin = path.join(dir, "fake-yt-dlp");
  const counter = path.join(dir, "attempts");
  const argsLog = path.join(dir, "args.jsonl");
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({id:'BxW_N_VruBc',title:'test track',duration:123,webpage_url:'https://www.youtube.com/watch?v=BxW_N_VruBc'}));
  process.exit(0);
}
const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm');
const part = output + '.part';
const counter = ${JSON.stringify(counter)};
const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
fs.writeFileSync(counter, String(attempt));
const mode = ${JSON.stringify(mode)};
if (mode === 'non403') {
  fs.writeFileSync(part, 'partial');
  process.stderr.write('ERROR: HTTP Error 429: Too Many Requests\\n');
  process.exit(1);
}
if (mode === 'permanent403' || mode === 'abort403' || mode === 'soundcloud403' ||
    (mode === 'transient403' && attempt === 1)) {
  fs.writeFileSync(part, 'partial');
  if (mode === 'transient403') fs.writeFileSync(output, 'stale complete-looking file');
  process.stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden https://media.example/file?token=secret\\n');
  process.exit(1);
}
if (mode === 'partialonly') {
  fs.writeFileSync(part, 'partial');
  fs.writeFileSync(output + '.ytdl', 'metadata');
  process.exit(0);
}
fs.writeFileSync(part, 'partial');
fs.writeFileSync(output, 'complete audio');
process.stdout.write('[download] 50.0% of 1MiB\\n');
process.exit(0);
`;
  await writeFile(bin, script, { mode: 0o755 });
  await chmod(bin, 0o755);

  const digest = createHash("sha256").update(await readFile(bin)).digest("hex");

  const patched = source.replace(
    'export const YT_DLP = path.join(process.cwd(), ".tools", "yt-dlp");',
    `export const YT_DLP = ${JSON.stringify(bin)};`,
  ).replace(
    'const YT_DLP_SHA256 = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6";',
    `const YT_DLP_SHA256 = ${JSON.stringify(digest)};`,
  );
  assert.notEqual(patched, source, "expected the production yt-dlp constant");
  const compiled = ts.transpileModule(patched, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(compiled, sourcePath);

  return {
    dir,
    bin,
    audio: loaded.exports,
    count: async () => Number(await readFile(counter, "utf8")),
    attempts: async () => (await readFile(argsLog, "utf8")).trim().split("\n").map(JSON.parse),
    leftovers: async () => (await readdir(dir)).filter((name) => name.startsWith(".tmp-")),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

const sourceUrl = "https://www.youtube.com/watch?v=BxW_N_VruBc";
const soundCloudUrl = "https://soundcloud.com/example/track";

test("one transient 403 starts a fresh process, emits retry, and returns only complete audio", async () => {
  const f = await fixture("transient403");
  try {
    const progress = [];
    const retries = [];
    const output = await f.audio.downloadAudio(
      sourceUrl, f.dir, (percent) => progress.push(percent), undefined,
      (attempt, maxAttempts) => retries.push([attempt, maxAttempts]),
    );
    assert.equal(await readFile(output, "utf8"), "complete audio");
    assert.deepEqual(retries, [[2, 3]]);
    assert.deepEqual(progress, [50, 100]);
    assert.equal(await f.count(), 2);
    assert.equal((await f.attempts()).length, 2);
    assert.ok((await f.attempts()).every((args) => args[0] === "--ignore-config"));
    assert.deepEqual(await f.leftovers(), [path.basename(output)]);
  } finally {
    await f.close();
  }
});

test("probe and full download use the same verified app binary with ignored user config", async () => {
  const f = await fixture("success");
  try {
    const probe = await f.audio.probeUrl(sourceUrl);
    assert.equal(probe.items[0].title, "test track");
    const output = await f.audio.downloadAudio(sourceUrl, f.dir, () => {});
    assert.equal(await readFile(output, "utf8"), "complete audio");
    const calls = await f.attempts();
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("--dump-single-json"));
    assert.ok(calls[1].includes("-o"));
    assert.ok(calls.every((args) => args[0] === "--ignore-config"));
  } finally {
    await f.close();
  }
});

test("missing or modified app binary fails with reinstall guidance before extraction", async () => {
  const f = await fixture("success");
  try {
    await rm(f.bin);
    await assert.rejects(f.audio.probeUrl(sourceUrl), /npm run setup:yt-dlp/);
    await writeFile(f.bin, "modified executable", { mode: 0o755 });
    await assert.rejects(
      f.audio.downloadAudio(sourceUrl, f.dir, () => {}),
      /검증에 실패.*npm run setup:yt-dlp/,
    );
  } finally {
    await f.close();
  }
});

test("persistent 403 stops after three tries, reports it, and removes partial files", async () => {
  const f = await fixture("permanent403");
  try {
    const retries = [];
    await assert.rejects(
      f.audio.downloadAudio(sourceUrl, f.dir, () => {}, undefined,
        (attempt, maxAttempts) => retries.push([attempt, maxAttempts])),
      (error) => {
        assert.match(error.message, /403 오류가 3회 반복/);
        assert.doesNotMatch(error.message, /token=secret/);
        return true;
      },
    );
    assert.deepEqual(retries, [[2, 3], [3, 3]]);
    assert.equal(await f.count(), 3);
    assert.ok((await f.attempts()).every((args) => !args.includes("--http-chunk-size")));
    assert.deepEqual(await f.leftovers(), []);
  } finally {
    await f.close();
  }
});

test("SoundCloud 403 retries three times without chunking", async () => {
  const f = await fixture("soundcloud403");
  try {
    const retries = [];
    await assert.rejects(
      f.audio.downloadAudio(soundCloudUrl, f.dir, () => {}, undefined,
        (attempt, maxAttempts) => retries.push([attempt, maxAttempts])),
      /403 오류가 3회 반복/,
    );
    assert.deepEqual(retries, [[2, 3], [3, 3]]);
    assert.ok((await f.attempts()).every((args) => !args.includes("--http-chunk-size")));
    assert.deepEqual(await f.leftovers(), []);
  } finally {
    await f.close();
  }
});

test("non-403 errors do not retry and remove partial files", async () => {
  const f = await fixture("non403");
  try {
    const retries = [];
    await assert.rejects(
      f.audio.downloadAudio(sourceUrl, f.dir, () => {}, undefined,
        (attempt, maxAttempts) => retries.push([attempt, maxAttempts])),
      /429/,
    );
    assert.deepEqual(retries, []);
    assert.equal(await f.count(), 1);
    assert.ok((await f.attempts()).every((args) => !args.includes("--http-chunk-size")));
    assert.deepEqual(await f.leftovers(), []);
  } finally {
    await f.close();
  }
});

test("abort during backoff prevents the next yt-dlp invocation", async () => {
  const f = await fixture("abort403");
  try {
    const controller = new AbortController();
    const retries = [];
    await assert.rejects(
      f.audio.downloadAudio(sourceUrl, f.dir, () => {}, controller.signal,
        (attempt, maxAttempts) => {
          retries.push([attempt, maxAttempts]);
          setTimeout(() => controller.abort(), 20);
        }),
      { name: "AbortError" },
    );
    assert.deepEqual(retries, [[2, 3]]);
    assert.equal(await f.count(), 1);
    assert.ok((await f.attempts()).every((args) => !args.includes("--http-chunk-size")));
    assert.deepEqual(await f.leftovers(), []);
  } finally {
    await f.close();
  }
});

test("exit 0 with only .part/.ytdl is rejected and cleaned", async () => {
  const f = await fixture("partialonly");
  try {
    await assert.rejects(
      f.audio.downloadAudio(sourceUrl, f.dir, () => {}),
      /다운로드된 파일을 찾을 수 없습니다/,
    );
    assert.equal(await f.count(), 1);
    assert.deepEqual(await f.leftovers(), []);
  } finally {
    await f.close();
  }
});
