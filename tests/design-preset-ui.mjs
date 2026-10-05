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
for (const extension of [".ts", ".tsx"]) {
  Module._extensions[extension] = function (module, filename) {
    const source = fs.readFileSync(filename, "utf8");
    const result = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2022,
      },
    });
    module._compile(result.outputText, filename);
  };
}

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { STUDIO_ARTWORK_PARTS } = require(path.join(root, "lib/types.ts"));
const { DESIGN_PRESETS } = require(path.join(root, "lib/design-presets.ts"));
const presetUi = require(path.join(root, "app/album/[id]/design/DesignPresetPicker.tsx"));
const DesignPresetPicker = presetUi.default;

test("preset request and confirmation decisions reject busy and stale-part actions", () => {
  assert.deepEqual(
    presetUi.requestPresetApplication("front", "preset-a", "", false),
    { kind: "apply", pending: { part: "front", presetId: "preset-a" } },
    "a truly empty draft applies directly",
  );
  assert.equal(presetUi.requestPresetApplication("front", "preset-a", "수동 내용", false).kind, "confirm");
  assert.deepEqual(presetUi.requestPresetApplication("front", "preset-a", "", true), { kind: "blocked" });

  const pending = { part: "front", presetId: "preset-a" };
  assert.deepEqual(presetUi.resolvePresetApplication(pending, "front", "cancel", false), { kind: "unchanged" });
  assert.deepEqual(presetUi.resolvePresetApplication(pending, "back", "replace", false), { kind: "unchanged" }, "a part switch invalidates the pending choice");
  assert.deepEqual(presetUi.resolvePresetApplication(pending, "front", "append", true), { kind: "unchanged" }, "busy handlers cannot apply a preset");
  assert.deepEqual(presetUi.resolvePresetApplication(pending, "front", "replace", false), { kind: "apply", mode: "replace" });
});

test("applying a confirmation uses the latest draft and preserves references and other areas", () => {
  const references = ["portrait.png"];
  const labels = { "portrait.png": "인물" };
  const longManualPrompt = `수동 시작\n${"세부 지시 ".repeat(10_000)}\n수동 끝`;
  const drafts = {
    front: { prompt: longManualPrompt, referenceFiles: references, referenceLabels: labels },
    back: { prompt: "뒷표지는 그대로", referenceFiles: ["back.png"] },
  };
  const pending = { part: "front", presetId: "preset-a" };

  const cancelled = presetUi.applyPresetToDrafts(drafts, pending, "front", "cancel", "추천 스타일", false);
  assert.equal(cancelled.applied, false);
  assert.equal(cancelled.drafts, drafts, "cancel is exactly unchanged");

  const appended = presetUi.applyPresetToDrafts(drafts, pending, "front", "append", "추천 스타일", false);
  assert.equal(appended.applied, true);
  assert.ok(appended.drafts.front.prompt.includes(longManualPrompt), "the complete unlimited manual prompt remains exact");
  assert.ok(appended.drafts.front.prompt.includes("추천 스타일"));
  assert.equal(appended.drafts.front.referenceFiles, references, "selected reference files retain identity and order");
  assert.equal(appended.drafts.front.referenceLabels, labels, "temporary reference labels are preserved");
  assert.equal(appended.drafts.back, drafts.back, "other artwork areas are untouched");

  const switched = presetUi.applyPresetToDrafts(drafts, pending, "label", "replace", "교체", false);
  assert.equal(switched.applied, false);
  assert.equal(switched.drafts, drafts);
});

test("all six areas SSR exactly five compact code-native preset cards", () => {
  let cardCount = 0;
  for (const part of STUDIO_ARTWORK_PARTS) {
    assert.equal(DESIGN_PRESETS[part].length, 5, `${part} exposes five recommendations`);
    const html = renderToStaticMarkup(React.createElement(DesignPresetPicker, {
      part,
      disabled: false,
      pendingPresetId: null,
      appendPreviewPrompt: "",
      replacePreviewPrompt: "",
      onRequest() {},
      onResolve() {},
    }));
    const cards = html.match(/추천 프롬프트 사용/g) ?? [];
    assert.equal(cards.length, 5, `${part} renders five accessible cards`);
    assert.equal((html.match(/>구성 예시<\/span>/g) ?? []).length, 5, `${part} renders five code-native layout swatches`);
    assert.match(html, /이미지 생성은 시작되지 않으며 API 비용도 발생하지 않습니다/);
    for (const preset of DESIGN_PRESETS[part]) {
      assert.ok(html.includes(preset.title), `${part} renders the exact catalog title ${preset.title}`);
      for (const tag of preset.tags) assert.ok(html.includes(tag), `${part}/${preset.id} renders tag ${tag}`);
    }
    cardCount += cards.length;
  }
  assert.equal(cardCount, 30);
});

test("confirmation SSR exposes full preview and all explicit choices without generating", () => {
  const part = "front";
  const preset = DESIGN_PRESETS[part][0];
  const appendPreview = "사용자 원문을 우선하는 스타일 추가 프롬프트";
  const replacePreview = "제목과 아티스트를 포함한 전체 추천 프롬프트";
  const html = renderToStaticMarkup(React.createElement(DesignPresetPicker, {
    part,
    disabled: false,
    pendingPresetId: preset.id,
    appendPreviewPrompt: appendPreview,
    replacePreviewPrompt: replacePreview,
    onRequest() {},
    onResolve() {},
  }));
  assert.ok(html.includes(appendPreview));
  assert.ok(html.includes(replacePreview));
  assert.match(html, /기존 내용에 스타일 추가/);
  assert.match(html, /추천안으로 바꾸기/);
  assert.match(html, />취소</);
  assert.match(html, /미리보기 확인만으로 이미지 생성은 시작되지 않습니다/);
});
