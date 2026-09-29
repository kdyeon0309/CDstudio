import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("lib/extract-contract.ts");

async function loadContract() {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = new Module(sourcePath);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(compiled, sourcePath);
  return loaded.exports;
}

test("51개 조회 결과는 추출 상한 50개만 기본 선택한다", async () => {
  const contract = await loadContract();
  const selected = contract.initialExtractSelection(51);

  assert.equal(contract.MAX_EXTRACT_ITEMS, 50);
  assert.equal(selected.length, 51);
  assert.equal(selected.filter(Boolean).length, 50);
  assert.equal(selected[49], true);
  assert.equal(selected[50], false);
});

test("잘못된 항목 수는 빈 선택으로 안전하게 처리한다", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.initialExtractSelection(-1), []);
  assert.deepEqual(contract.initialExtractSelection(Number.NaN), []);
});
