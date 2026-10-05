import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
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
Module._extensions[".css"] = function (module) {
  module.exports = { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
};

const { renderToStaticMarkup } = require("react-dom/server");
const React = require("react");
const { ARTWORK_PARTS } = require(path.join(root, "lib/types.ts"));
const { canBackFold, canFrontFold, printPartsForTarget } = require(path.join(root, "lib/print-plan.ts"));
const { selectedStudioParts, studioBackMayCropLegacyCandidate, studioPrintEnabled, studioPrintResolution, studioSpineNeedsBack } = require(path.join(root, "lib/studio-view.ts"));
const ArtworkSheetPreview = require(path.join(root, "components/ArtworkSheetPreview.tsx")).default;
const FoldedFrontSheet = require(path.join(root, "components/FoldedFrontSheet.tsx")).default;
const FoldedBackSheet = require(path.join(root, "components/FoldedBackSheet.tsx")).default;
const sheetCss = fs.readFileSync(path.join(root, "components/ArtworkSheetPreview.module.css"), "utf8");
const foldedCss = fs.readFileSync(path.join(root, "components/FoldedFrontSheet.module.css"), "utf8");
const foldedBackCss = fs.readFileSync(path.join(root, "components/FoldedBackSheet.module.css"), "utf8");
assert.match(foldedBackCss, /page:\s*cd-back-fold/);
assert.match(foldedBackCss, /\.foldSheet[^}]*width:\s*210mm;[^}]*height:\s*297mm/s);
assert.match(foldedBackCss, /\.foldStrip[^}]*top:\s*30\.5mm;[^}]*left:\s*30mm;[^}]*width:\s*150mm;[^}]*height:\s*236mm/s);
assert.match(foldedBackCss, /\.face[^}]*width:\s*150mm;[^}]*height:\s*118mm/s);
assert.match(foldedBackCss, /\.inside\s*\{[^}]*rotate\(180deg\)/s);
assert.doesNotMatch(foldedBackCss, /scaleX|scaleY/);
assert.match(foldedBackCss, /@page cd-back-fold\s*\{[^}]*size:\s*A4 portrait;[^}]*margin:\s*0/s);
assert.match(foldedBackCss.split("@media print").at(-1), /\.sheetLabel, \.screenFoldLine, \.screenSpineLine\s*\{\s*display:\s*none/s);
assert.match(foldedBackCss, /max-width:\s*900px\) and \(min-width:\s*681px\)[^{]*\{\s*\.foldSheet\s*\{\s*zoom:\s*\.72/s);
const backSheetWidthPx = 210 * 96 / 25.4;
for (const viewportWidth of [320, 340, 341, 420, 421, 540, 541, 680, 681, 800, 900, 901, 1024]) {
  const zoom = viewportWidth <= 340 ? .24 : viewportWidth <= 420 ? .29
    : viewportWidth <= 540 ? .33 : viewportWidth <= 680 ? .42
      : viewportWidth <= 900 ? .72 : .98;
  assert.ok(backSheetWidthPx * zoom <= viewportWidth - 48,
    `${viewportWidth}px viewport keeps portrait back-fold preview inside padded content`);
}
assert.match(sheetCss, /\.sheet\s*\{[^}]*width:\s*210mm;[^}]*height:\s*297mm;/s, "A4 dimensions must remain physical CSS mm");
assert.match(sheetCss, /\.sheet\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s,
  "existing portrait sheets remain centered on A4");
for (const cssFile of ["components/ArtworkSheetPreview.module.css", "app/album/[id]/print/print.module.css"]) {
  const printCss = fs.readFileSync(path.join(root, cssFile), "utf8").split("@media print").at(-1);
  assert.match(printCss, /\.foldLine\s*\{[^}]*top:\s*-4mm;[^}]*bottom:\s*auto;[^}]*height:\s*2mm;[^}]*border-left:[^;]*solid/s,
    `${cssFile}: printed fold guide must be a short mark above the artwork`);
}
assert.match(foldedCss, /\.wrapper\s*\{[^}]*page:\s*cd-front-fold;/s,
  "outer wrapper owns the named page so no anonymous portrait page starts before it");
assert.match(foldedCss, /\.foldSheet\s*\{[^}]*width:\s*297mm;[^}]*height:\s*210mm;/s,
  "fold sheet is one named landscape A4 page");
assert.match(foldedCss, /\.foldStrip\s*\{[^}]*top:\s*45mm;[^}]*left:\s*28\.5mm;[^}]*display:\s*flex;[^}]*width:\s*240mm;[^}]*height:\s*120mm;/s,
  "240 x 120 mm strip is exactly centered on landscape A4");
assert.match(foldedCss, /\.foldPanel\s*\{[^}]*width:\s*120mm;[^}]*height:\s*120mm;[^}]*overflow:\s*hidden;/s,
  "the touching fold panels are each 120 mm square");
assert.match(foldedCss, /@page cd-front-fold\s*\{[^}]*size:\s*A4 landscape;[^}]*margin:\s*0;/s);
assert.equal((foldedCss.match(/page:\s*cd-front-fold/g) ?? []).length, 1,
  "only the folded sheet opts into the named landscape page");
assert.match(foldedCss, /\.foldTick\s*\{[^}]*left:\s*120mm;[^}]*height:\s*2mm;[^}]*border-left:[^;]*solid/s,
  "the center fold is indicated only by short solid ticks");
assert.match(foldedCss, /\.foldTickTop\s*\{\s*top:\s*-4mm;/);
assert.match(foldedCss, /\.foldTickBottom\s*\{\s*bottom:\s*-4mm;/);
assert.match(foldedCss.split("@media print").at(-1), /\.foldSheet\s*\{[^}]*zoom:\s*1 !important/s,
  "print restores exact physical dimensions");
assert.match(foldedCss.split("@media print").at(-1), /\.sheetLabel,\s*\.screenFoldLine\s*\{\s*display:\s*none;/s,
  "the full-height dotted fold preview never prints across artwork");
assert.doesNotMatch(foldedCss, /scaleX|rotate|transform:/,
  "fold panels are never mirrored or rotated");
const foldedZoomRules = [...foldedCss.matchAll(
  /@media screen and \(max-width:\s*(\d+)px\)\s*\{\s*\.foldSheet\s*\{\s*zoom:\s*([\d.]+);/gs,
)].map((match) => ({ maxWidth: Number(match[1]), zoom: Number(match[2]) }));
const landscapeSheetWidthPx = 297 * 96 / 25.4;
const defaultFoldedZoom = Number(foldedCss.match(/\.foldSheet\s*\{[^}]*zoom:\s*([\d.]+)/s)?.[1]);
for (const viewportWidth of [320, 321, 340, 341, 344, 360, 365, 366, 375, 380, 381, 420, 421, 540, 541, 680, 681, 900, 901, 1024, 1122, 1200, 1201, 1440, 1920]) {
  const zoom = foldedZoomRules.reduce(
    (current, rule) => viewportWidth <= rule.maxWidth ? rule.zoom : current,
    defaultFoldedZoom,
  );
  const availableWidth = Math.min(viewportWidth, 1152) - 48;
  assert.ok(landscapeSheetWidthPx * zoom <= availableWidth,
    `${viewportWidth}px viewport keeps the landscape A4 preview inside padded album content`);
}

const presentation = {
  fit: "cover",
  transform: { offsetXMm: 0, offsetYMm: 0, scale: 1 },
  overlay: { enabled: true, color: "#ffffff", position: "top", fontSizeMm: 6 },
};
const candidate = {
  id: "candidate-1",
  filename: "test art.png",
  prompt: "test",
  referenceFiles: [],
  width: 1440,
  height: 1440,
  createdAt: new Date().toISOString(),
};
const allPrintParts = Object.freeze([...ARTWORK_PARTS]);
assert.equal(canFrontFold(allPrintParts), true);
assert.equal(canBackFold(allPrintParts), true);
assert.deepEqual(printPartsForTarget(allPrintParts, "back-fold"), ["back", "back-inner"]);
assert.deepEqual(printPartsForTarget(["back-inner", "front", "back"], "back-fold"), ["back", "back-inner"], "back fold uses physical outside-before-inside order");
assert.deepEqual(printPartsForTarget(["back", "front"], "back-fold"), []);
assert.equal(canBackFold(["back-inner"]), false);
assert.deepEqual(printPartsForTarget(["back-inner"], "back-fold"), []);
assert.deepEqual(printPartsForTarget([], "back-fold"), []);
assert.deepEqual(printPartsForTarget(allPrintParts, "front-fold"), ["front-inner", "front"],
  "front fold has exactly the physical left-to-right inside/outside order");
assert.deepEqual(printPartsForTarget(allPrintParts, "remaining"), ["label", "back", "back-inner"],
  "remaining pages preserve the existing non-front order");
assert.deepEqual(
  printPartsForTarget(["back", "front", "back-inner", "front-inner", "label"], "remaining"),
  ["back", "back-inner", "label"],
  "remaining preserves caller order while removing only the two front faces",
);
assert.deepEqual(printPartsForTarget(allPrintParts, "all"), ARTWORK_PARTS,
  "all keeps the existing print plan");
assert.notEqual(printPartsForTarget(allPrintParts, "all"), allPrintParts,
  "the planner returns a new array rather than exposing its input");
assert.deepEqual(allPrintParts, ARTWORK_PARTS, "planning does not mutate frozen input metadata");
assert.equal(canFrontFold(["front", "back"]), false);
assert.deepEqual(printPartsForTarget(["front", "back"], "front-fold"), [],
  "a missing inside cover never degrades to a partial fold sheet");
assert.deepEqual(printPartsForTarget(["front-inner", "back"], "front-fold"), [],
  "a missing outside cover never degrades to a partial fold sheet");
assert.deepEqual(printPartsForTarget([], "all"), [], "an empty plan stays empty");
assert.deepEqual(printPartsForTarget(["front-inner"], "front-fold"), [],
  "an inside-only plan cannot print a fold sheet");
assert.deepEqual(printPartsForTarget(["front", "front-inner"], "front-fold"), ["front-inner", "front"],
  "fold panel order is fixed even when the available input is reversed");
assert.deepEqual(printPartsForTarget(["front"], "remaining"), [],
  "a front-only project has no remaining pages");
const resolution = (part, width, height, scale = 1, fit = "cover", separateSpine = false, offsetXMm = 0, offsetYMm = 0) =>
  studioPrintResolution({ width, height }, part, { fit, transform: { offsetXMm, offsetYMm, scale } }, separateSpine);
assert.equal(resolution("front", 1418, 1418).grade, "target", "front reaches 300 PPI at its full 120 mm size");
assert.equal(resolution("front-inner", 1417, 1417).grade, "below-target");
assert.equal(resolution("back", 1619, 1394).grade, "target", "back always uses the spine-free 137 x 118 mm center");
assert.equal(resolution("back-inner", 1772, 1394).grade, "target");
assert.equal(resolution("label", 1371, 1371).grade, "target", "label uses 116 mm diameter");
assert.equal(resolution("back-spine", 77, 1394).grade, "target", "narrow spine uses both physical axes");
assert.equal(resolution("back-spine", 1024, 1024).ppi, 220, "a square spine is constrained by its 118 mm height");
assert.equal(resolution("back", 1619, 1394, 1, "cover", true).grade, "target", "legacy separate-spine argument does not change center geometry");
assert.equal(studioBackMayCropLegacyCandidate({ width: 1772, height: 1394 }, { fit: "cover" }), true,
  "an old 150 mm full-width candidate warns before center cropping");
assert.equal(studioBackMayCropLegacyCandidate({ width: 1619, height: 1394 }, { fit: "cover" }), false,
  "a new 137 mm center candidate does not warn");
assert.equal(studioBackMayCropLegacyCandidate({ width: 1772, height: 1394 }, { fit: "contain" }), false,
  "whole-image fit avoids the legacy crop warning");
assert.equal(resolution("front", 1418, 1418, 1.5).ppi, 200, "enlargement lowers effective print PPI");
assert.equal(resolution("front", 1000, 1000, 1.2).grade, "low", "under 200 PPI is low resolution");
assert.equal(resolution("front", 2000, 1000, 1, "contain").ppi, 192, "contain includes the 110%-size blurred full-bleed background");
assert.equal(resolution("front", 2000, 1000, 3, "contain").ppi, 141, "scaled contain foreground can be limiting");
assert.equal(resolution("front", 1418, 1418, 0.5).ppi, 300, "shrinking cover artwork cannot inflate reported PPI");
assert.equal(resolution("front", 1418, 1418, 0.5).fullBleed, false, "shrinking cover artwork leaves white margins");
assert.equal(resolution("front", 1418, 1418, 1.2, "cover", false, 12, -12).fullBleed, true,
  "CSS scale then translate allows offsets inside the expanded boundary");
assert.equal(resolution("front", 1418, 1418, 1.2, "cover", false, 12.1).fullBleed, false,
  "offset past the expanded boundary can leave margins");
assert.equal(resolution("back", 1772, 1394, 1.2, "cover", false, 14).fullBleed, false,
  "back offsets are bounded by the 137 mm center even without a selected spine");
assert.equal(resolution("back", 1772, 1394, 1.2, "cover", true, 14).fullBleed, false,
  "legacy separate-spine argument cannot change the center panel's allowable offset");
assert.equal(resolution("front", 1418, 1418, 0.5, "contain", false, 60).fullBleed, true,
  "contain keeps its independent blurred background full bleed");
for (const [width, height, scale] of [[0, 1418, 1], [-10, 1418, 1], [NaN, 1418, 1], [Infinity, 1418, 1], [Number.MAX_VALUE, 1418, 1], [1418.5, 1418, 1], [8193, 1418, 1], ["1418", 1418, 1], [1418, 0, 1], [1418, Infinity, 1], [1418, 8193, 1], [1418, 1418, 0], [1418, 1418, NaN], [1418, 1418, "1"]]) {
  const result = resolution("front", width, height, scale);
  assert.equal(result.ppi, 0, "invalid metadata cannot claim PPI");
  assert.equal(result.grade, "low");
  assert.equal(result.fullBleed, false);
}
assert.equal(resolution("front", 8192, 8192).grade, "target", "valid 64MP upper bound is accepted");
assert.ok(Number.isFinite(resolution("front", 8192, 8192, Number.MIN_VALUE, "contain").ppi),
  "tiny but finite presentation scale cannot produce Infinity PPI");
assert.equal(resolution("front", 1418, 1418, 1, "cover", false, NaN).fullBleed, false,
  "invalid offset cannot claim full bleed");
const studioClientSource = fs.readFileSync(path.join(root, "app/album/[id]/design/studio-client.tsx"), "utf8");
const printClientSource = fs.readFileSync(path.join(root, "app/album/[id]/print/print-client.tsx"), "utf8");
const printModuleSource = fs.readFileSync(path.join(root, "app/album/[id]/print/print.module.css"), "utf8");
const globalsSource = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
const nextConfigSource = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
const previewRouteSource = fs.readFileSync(path.join(root, "app/api/projects/[id]/preview/[name]/route.ts"), "utf8");
const uploadRouteSource = fs.readFileSync(path.join(root, "app/api/projects/[id]/assets/route.ts"), "utf8");
assert.match(studioClientSource, /MAX_UPLOAD_BYTES = 20 \* 1024 \* 1024/);
assert.match(studioClientSource, /이미지는 파일당 20MB 이하/);
assert.match(studioClientSource, /참고 이미지는 파일당 20MB 이하/);
assert.match(uploadRouteSource, /MAX_FILE_BYTES = 20 \* 1024 \* 1024/);
assert.match(uploadRouteSource, /MAX_REQUEST_BYTES = 20 \* 1024 \* 1024/);
assert.match(uploadRouteSource, /MAX_FILES = 5/);
assert.match(studioClientSource, /선택한 스파인 인쇄 이미지/);
assert.match(studioClientSource, /300PPI 목표 미달/);
assert.match(printClientSource, /선택한 스파인 인쇄 이미지/);
assert.match(printClientSource, /300PPI 목표 미달/);
assert.match(printClientSource, /studioPrintResolution\(candidate, part/);
assert.match(studioClientSource, /여백 가능/);
assert.match(studioClientSource, /기존 풀폭 뒷표지 이미지는 137mm 중앙 영역에 맞출 때 양옆이 잘릴 수 있습니다/);
assert.match(studioClientSource, /‘이미지 전체 보기’로 전환하거나 새 규격으로 다시 생성하세요/);
assert.match(printClientSource, /여백 가능/);
assert.match(printClientSource, /150×118mm 트레이카드 · 중앙 아트 137×118mm · 좌우 스파인 각 6\.5mm/);
assert.match(printClientSource, /기존 풀폭 뒷표지 이미지는 중앙 137mm에 맞출 때 양옆이 잘릴 수 있습니다/);
assert.equal((printClientSource.match(/printPartsForTarget\(printableParts, printTarget\)/g) ?? []).length, 2,
  "studio and legacy print paths both use the selected print plan");
assert.match(printClientSource, /const unverifiedOverlay = renderedParts\.some/,
  "studio overlay verification is limited to rendered target pages");
assert.match(printClientSource, /const overflowingParts = renderedParts\.filter/,
  "an unrelated back overflow cannot block front-only fold printing");
assert.match(printClientSource, /printTarget !== "front-fold" && studioSpineNeedsBack\(project\)/,
  "an orphan spine blocks all and remaining, but not a valid front fold pair");
assert.match(printClientSource, /const renderedParts = blockedByOrphanSpine \? \[\] : plannedParts/,
  "blocked orphan-spine targets leave no printable sheets even through browser Ctrl+P");
assert.match(printClientSource, /value="front-fold"[^>]*disabled=\{!frontFoldAvailable\}/,
  "the front fold option is disabled instead of printing a single available side");
assert.match(printClientSource, /value="remaining"[^>]*disabled=\{!remainingAvailable\}/,
  "the remaining option is disabled when it has no pages");
assert.match(printClientSource, /disabled=\{plannedParts\.length === 0\}/,
  "legacy printing cannot open an empty target plan");
assert.match(printClientSource, /앞표지 외에 인쇄할 나머지 영역이 없습니다/,
  "an empty remaining plan has a clear Korean notice");
assert.match(printClientSource, /displayedParts = printTarget === "all" \? ARTWORK_PARTS : plannedParts/,
  "legacy all keeps its existing screen placeholders while targeted modes render only planned pages");
assert.match(printClientSource, /:\s*displayedParts\.map\(\(part\) => \(/,
  "legacy non-fold targets keep using the existing artwork page renderer");
assert.match(printClientSource, /printTarget === "front-fold"[\s\S]*<FoldedFrontSheet[\s\S]*filename=\{selectedVariant\.files\["front-inner"\]\!\}[\s\S]*filename=\{selectedVariant\.files\.front\!\}/,
  "legacy fold mode renders eager inside/outside frames through the shared sheet");
assert.match(printClientSource, /filename=\{selectedVariant\.files\["front-inner"\]\!\}[\s\S]*transform=\{transforms\["front-inner"\] \?\? IDENTITY\} eager/,
  "legacy folded inside uses its saved transform and eager iframe");
assert.match(printClientSource, /filename=\{selectedVariant\.files\.front\!\}[\s\S]*transform=\{transforms\.front \?\? IDENTITY\} eager/,
  "legacy folded outside uses its saved transform and eager iframe");
assert.equal((printClientSource.match(/<FoldedFrontSheet/g) ?? []).length, 2,
  "studio and legacy routes share one folded-sheet component");
assert.match(printClientSource, /A4 가로·단면·배율 100%·여백 0/);
assert.match(printClientSource, /왼쪽은 앞표지 내부, 오른쪽은 앞표지/);
assert.match(printClientSource, /바깥 네 모서리 표식에 맞춰 외곽 사각형만 자르고/);
assert.match(printClientSource, /중앙 위·아래 짧은 표식은 자르지 말고 접는 위치/);
assert.match(printClientSource, /인쇄되지 않은 뒷면끼리 맞닿도록 접으면 인쇄면이 바깥/);
assert.match(printClientSource, /기존 디자인의 조정값은 ‘전체 영역’의 ‘조정’에서 변경/);
assert.match(printClientSource, /나머지 영역을 기존 크기와 순서로 인쇄/);
assert.match(studioClientSource, /import Image from "next\/image"/);
assert.match(studioClientSource, /fill\s+sizes=\{sizes\}\s+loading="lazy"\s+decoding="async"/s,
  "thumbnail helper uses the Next.js optimizer with lazy async decoding");
assert.match(studioClientSource, /<AssetThumbnail[^>]*sizes="112px"[^>]*className="object-cover"/,
  "candidate thumbnails request card-scale image variants");
assert.match(studioClientSource, /\/preview\/\$\{encodeURIComponent\(filename\)\}/,
  "optimized thumbnails use the queryless preview route");
assert.match(nextConfigSource, /pathname:\s*"\/api\/projects\/\*\/preview\/\*",\s*search:\s*""/,
  "the optimizer allowlist is limited to queryless project previews");
assert.match(previewRouteSource, /IMAGE_EXTENSIONS = new Set\(\["\.jpg", "\.jpeg", "\.png", "\.webp", "\.gif"\]\)/);
assert.match(previewRouteSource, /return getProjectFile\(fileRequest/,
  "preview route delegates existing asset validation and streaming");
assert.match(studioClientSource, /lg:col-start-2 lg:row-start-2[^\n]*xl:col-start-3 xl:row-start-1/,
  "studio controls move below the preview at intermediate widths and return to column three at xl");
assert.match(studioClientSource, /aria-pressed=\{Boolean\(candidate\.favorite\)\}/);
assert.match(studioClientSource, /aria-label=\{`\$\{STUDIO_PART_LABELS\[activePart\]\} 후보 \$\{candidateNumber\}, \$\{candidateSource\} 미리보기`\}/);
assert.match(studioClientSource, /min-h-7 min-w-7[^\n]*>비교<\/button>/);
assert.match(studioClientSource, /MAX_STUDIO_BODY_BYTES = 1024 \* 1024/);
assert.match(studioClientSource, /new TextEncoder\(\)\.encode\(value\)\.byteLength/);
assert.match(studioClientSource, /요청 전체가 UTF-8 기준 1MiB/);
assert.match(studioClientSource, /fontSizeMm: \{ min: 2, max: 20 \}/);
assert.match(studioClientSource, /if \(!validPresentation\(value\)\)|if \(validPresentation\(value\)\)/,
  "cached presentation data is range checked before restoration");
assert.doesNotMatch(printModuleSource, /\.preview\s*\{\s*zoom:/s,
  "mobile scaling must not shrink print controls and status text");
assert.match(printModuleSource, /@page\s*\{\s*size:\s*A4;\s*margin:\s*0;/s,
  "ordinary print sheets keep the anonymous portrait A4 page");
assert.doesNotMatch(printModuleSource, /landscape|cd-front-fold/,
  "the fold page cannot change ordinary portrait print CSS");
assert.match(printModuleSource, /\.sheet\s*\{[^}]*width:\s*var\(--a4-width\);[^}]*height:\s*var\(--a4-height\);[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s,
  "legacy front sheets remain centered at physical size on A4");
assert.match(printModuleSource, /\.sheet,\s*\.scaledSheet\s*\{\s*zoom:/s,
  "mobile scaling targets only physical sheet wrappers");
assert.match(printModuleSource.split("@media print").at(-1), /\.scaledSheet,\s*\.sheet\s*\{[^}]*zoom:\s*1 !important/s,
  "print media restores unscaled physical dimensions");
const mobileSheetZoomRules = [...printModuleSource.matchAll(
  /@media screen and \(max-width:\s*(\d+)px\)\s*\{\s*\.sheet,\s*\.scaledSheet\s*\{\s*zoom:\s*([\d.]+);/gs,
)].map((match) => ({ maxWidth: Number(match[1]), zoom: Number(match[2]) }));
const mobileSheetWidthPx = 210 * 96 / 25.4;
const albumMainHorizontalPaddingPx = 48;
for (const viewportWidth of [344, 360, 375]) {
  const zoom = mobileSheetZoomRules.reduce(
    (current, rule) => viewportWidth <= rule.maxWidth ? rule.zoom : current,
    1,
  );
  const availableWidth = viewportWidth - albumMainHorizontalPaddingPx;
  assert.ok(mobileSheetWidthPx * zoom <= availableWidth,
    `${viewportWidth}px viewport keeps the scaled A4 sheet inside the album content width`);
}
for (const match of printClientSource.matchAll(/<FoldedFrontSheet/g)) {
  assert.ok(!printClientSource.slice(Math.max(0, match.index - 180), match.index).includes("scaledSheet"),
    "folded sheets own their only responsive zoom and are never nested in scaledSheet");
}
assert.match(studioClientSource,
  /STUDIO_ARTWORK_PARTS\.some\(\(part\) => draftDirty\[part\] \|\| presentationDirty\[part\]\)/,
  "navigation guard checks dirty state restored for every studio part");
assert.match(studioClientSource,
  /async function persistDirtyPresentations[\s\S]*presentationDirty\[part\] && !generationControllersRef\.current\.has\(part\)[\s\S]*await persistPresentation\(part\)/,
  "all unlocked dirty presentation parts are saved individually");
assert.match(studioClientSource,
  /if \(!\(await persistDirtyPresentations\(\)\)\) return;[\s\S]*window\.location\.href = `\/album\/\$\{encodeURIComponent\(projectId\)\}\/print`/,
  "print navigation waits for every dirty presentation and stops after a save failure");
assert.doesNotMatch(printClientSource, /5단계 · 실치수 인쇄/);
assert.equal((printClientSource.match(/③ 실치수 인쇄/g) ?? []).length, 3,
  "all print variants show the current step number");
assert.match(globalsSource, /--color-fg-dim:\s*#8b8882/);
const project = {
  id: "test-project",
  title: '<img src=x onerror=alert(1)>',
  artist: "테스트",
  tracks: [{ id: "track-1", order: 1, title: "첫 곡", durationSec: 183 }],
  artwork: { variants: [] },
  studio: {
    version: 1,
    printSource: "studio",
    parts: {
      front: { prompt: "", referenceFiles: [], candidates: [candidate], selectedCandidateId: "missing", presentation },
      back: { prompt: "", referenceFiles: [], candidates: [candidate], selectedCandidateId: candidate.id, presentation },
    },
    snapshots: [],
  },
};

assert.deepEqual(selectedStudioParts(project), ["back"], "missing selected ids must not print");
assert.equal(studioPrintEnabled(project), true);
assert.equal(studioPrintEnabled({ ...project, studio: undefined }), false, "no implicit studio fallback");
assert.equal(studioPrintEnabled({ ...project, studio: { ...project.studio, printSource: "legacy" } }), false);
const spineCandidate = { ...candidate, id: "spine-1", filename: "spine.png" };
const splitProject = {
  ...project,
  studio: {
    ...project.studio,
    parts: {
      ...project.studio.parts,
      "back-spine": {
        prompt: "Independently designed spine",
        referenceFiles: [],
        candidates: [spineCandidate],
        selectedCandidateId: spineCandidate.id,
        presentation,
      },
    },
  },
};
assert.deepEqual(selectedStudioParts(splitProject), ["back"], "one spine candidate reuses the back A4 sheet");
const orphanSpineProject = {
  ...splitProject,
  studio: { ...splitProject.studio, parts: { "back-spine": splitProject.studio.parts["back-spine"] } },
};
assert.deepEqual(selectedStudioParts(orphanSpineProject), [], "a selected spine alone cannot produce a back sheet");
assert.equal(studioSpineNeedsBack(orphanSpineProject), true, "studio print requires a selected back with its spine");
assert.equal(studioSpineNeedsBack({ ...orphanSpineProject, studio: { ...orphanSpineProject.studio, printSource: "legacy" } }), false,
  "legacy print remains available with a studio spine but no studio back");

const insideCandidate = { ...candidate, id: "inside-candidate", filename: "inside.png" };
const outsideCandidate = { ...candidate, id: "outside-candidate", filename: "outside.png" };
const frontFoldProject = {
  ...project,
  studio: {
    ...project.studio,
    parts: {
      front: { prompt: "", referenceFiles: [], candidates: [outsideCandidate], selectedCandidateId: outsideCandidate.id, presentation },
      "front-inner": { prompt: "", referenceFiles: [], candidates: [insideCandidate], selectedCandidateId: insideCandidate.id, presentation },
      back: project.studio.parts.back,
    },
  },
};
const frontFoldPlan = printPartsForTarget(selectedStudioParts(frontFoldProject), "front-fold");
assert.deepEqual(frontFoldPlan, ["front-inner", "front"]);
const embeddedInside = React.createElement(ArtworkSheetPreview, {
  project: frontFoldProject, part: "front-inner", candidate: insideCandidate, presentation, embedded: true,
});
const embeddedOutside = React.createElement(ArtworkSheetPreview, {
  project: frontFoldProject, part: "front", candidate: outsideCandidate, presentation, embedded: true,
});
const frontFoldHtml = renderToStaticMarkup(React.createElement(FoldedFrontSheet, {
  left: embeddedInside,
  right: embeddedOutside,
}));
assert.equal((frontFoldHtml.match(/<section/g) ?? []).length, 1,
  "front fold renders exactly one A4 sheet");
assert.equal((frontFoldHtml.match(/class="foldPanel"/g) ?? []).length, 2,
  "one sheet contains exactly two touching panels");
assert.ok(frontFoldHtml.indexOf("inside.png") < frontFoldHtml.indexOf("outside.png"),
  "actual embedded content is inside-left then outside-right");
assert.equal((frontFoldHtml.match(/width:120mm;height:120mm/g) ?? []).length, 2,
  "both embedded artwork faces preserve 120 x 120 mm geometry");
assert.equal((frontFoldHtml.match(/<i class=/g) ?? []).length, 4,
  "the shared strip has only four outer crop marks");
assert.equal((frontFoldHtml.match(/class="foldTick /g) ?? []).length, 2,
  "the center has one short fold tick above and below the strip");
assert.ok(!frontFoldHtml.includes('class="cropMarks"'),
  "embedded panels do not add internal crop marks");
assert.ok(!frontFoldHtml.includes('class="foldLine '),
  "embedded front panels do not print an artwork-crossing fold line");
assert.ok(!frontFoldHtml.includes("A4 인쇄 미리보기"),
  "embedded panels do not nest portrait A4 wrappers or sheet labels");

const ordinaryFrontHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
  project: frontFoldProject, part: "front", candidate: outsideCandidate, presentation,
}));
const embeddedFrontHtml = renderToStaticMarkup(embeddedOutside);
assert.ok(ordinaryFrontHtml.includes('class="wrapper '));
assert.ok(ordinaryFrontHtml.includes('class="sheet '));
assert.ok(ordinaryFrontHtml.includes('class="cropMarks"'));
assert.ok(!embeddedFrontHtml.includes('class="wrapper '));
assert.ok(!embeddedFrontHtml.includes('class="sheet '));
assert.ok(!embeddedFrontHtml.includes('class="cropMarks"'));
assert.match(embeddedFrontHtml, /translate\(0mm, 0mm\) scale\(1\)/,
  "embedded mode reuses the unchanged artwork transform and image content");

for (const part of ARTWORK_PARTS) {
  const html = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
    project, part, candidate, presentation,
  }));
  assert.ok(html.includes('class="sheet '), "each part must use the shared A4 sheet class");
  const expected = part === "label" ? "width:116mm;height:116mm" :
    part.startsWith("back") ? "width:150mm;height:118mm" : "width:120mm;height:120mm";
  assert.ok(html.includes(expected), `${part} physical size`);
  if (part === "label") assert.ok(html.includes("--hole-size:23mm"), "label hub size");
  if (part.startsWith("back")) assert.ok(html.includes("--spine-size:6.5mm"), "back spine width");
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), "hostile metadata must be escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "metadata still visible as text");
  assert.ok(html.includes("test%20art.png"), "asset filename URL encoded");
  const uploadedHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
    project, part, candidate: { ...candidate, source: "upload" },
    presentation: { ...presentation, fit: "cover", transform: { offsetXMm: 4, offsetYMm: -3, scale: 1.4 } },
  }));
  assert.ok(uploadedHtml.includes(expected), `${part} uploaded artwork keeps physical size`);
  assert.ok(uploadedHtml.includes("translate(4mm, -3mm) scale(1.4)"), "uploaded crop placement reaches shared print renderer");
  assert.ok(uploadedHtml.includes("artworkImage cover"), "uploaded artwork uses non-destructive cover crop");
}

const splitHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
  project: splitProject,
  part: "back",
  candidate,
  presentation,
  spineCandidate,
  spinePresentation: presentation,
}));
assert.ok(splitHtml.includes("width:150mm;height:118mm"), "split tray card stays 150 x 118 mm");
assert.equal((splitHtml.match(/<img[^>]*spine\.png/g) ?? []).length, 2, "one spine asset renders twice");
assert.match(splitHtml, /splitSpineLeft/);
assert.match(splitHtml, /splitCenter/);
assert.match(splitHtml, /splitSpineRight/);
assert.ok(!splitHtml.includes("spineTextLeft"), "the old back overlay spine text is suppressed");
assert.equal((splitHtml.match(/<span class="splitSpineText/g) ?? []).length, 2, "spine overlay uses its own presentation on both sides");
assert.match(splitHtml, /splitSpineTextLeft splitSpineTextEnd/, "rotated left spine aligns to the physical top");
assert.match(splitHtml, /splitSpineText\s+splitSpineTextStart/, "right spine aligns to the physical top");
const bottomPresentation = { ...presentation, overlay: { ...presentation.overlay, position: "bottom" } };
const bottomSplitHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
  project: splitProject, part: "back", candidate, presentation,
  spineCandidate, spinePresentation: bottomPresentation,
}));
assert.match(bottomSplitHtml, /splitSpineTextLeft splitSpineTextStart/, "rotated left spine aligns to the physical bottom");
assert.match(bottomSplitHtml, /splitSpineText\s+splitSpineTextEnd/, "right spine aligns to the physical bottom");
const standaloneSpineHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
  project: splitProject, part: "back-spine", candidate: spineCandidate, presentation: bottomPresentation,
}));
assert.match(standaloneSpineHtml, /width:6\.5mm;height:118mm/, "standalone spine preview preserves its physical dimensions");
assert.match(standaloneSpineHtml, /splitSpineText\s+splitSpineTextEnd/, "standalone spine preview honors bottom alignment");
assert.match(sheetCss, /\.splitSpineLeft\s*\{[^}]*width:\s*var\(--spine-size\)/s);
assert.match(sheetCss, /\.splitCenter\s*\{[^}]*left:\s*var\(--spine-size\);[^}]*right:\s*var\(--spine-size\)/s);
assert.match(sheetCss, /\.splitSpineRight\s*\{[^}]*width:\s*var\(--spine-size\)/s);
assert.match(sheetCss, /\.splitSpineTextStart\s*\{[^}]*text-align:\s*start/s);
assert.match(sheetCss, /\.splitSpineTextEnd\s*\{[^}]*text-align:\s*end/s);

const unsplitHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
  project, part: "back", candidate, presentation,
}));
assert.match(unsplitHtml, /splitCenter/, "older back artwork is still confined to the 137 mm center");
assert.equal((unsplitHtml.match(/<img[^>]*test%20art\.png/g) ?? []).length, 1,
  "no-spine side strips never duplicate or crop the center artwork");
assert.equal((unsplitHtml.match(/neutralSpine/g) ?? []).length, 2,
  "no-spine tray card has two intentional neutral side folds");
assert.ok(!unsplitHtml.includes("spineTextLeft"), "center metadata is never copied onto neutral side folds");

const backInnerHtml = renderToStaticMarkup(React.createElement(ArtworkSheetPreview, {
  project, part: "back-inner", candidate, presentation,
}));
assert.ok(!backInnerHtml.includes("splitCenter"), "back-inner remains an unsplit 150 x 118 mm image");
assert.equal((backInnerHtml.match(/<img[^>]*test%20art\.png/g) ?? []).length, 1, "back-inner artwork renders once at full width");

const foldedBackHtml = renderToStaticMarkup(React.createElement(FoldedBackSheet, {
  outside: React.createElement(ArtworkSheetPreview, { project: splitProject, part: "back", candidate, presentation, spineCandidate, spinePresentation: presentation, embedded: true }),
  inside: React.createElement(ArtworkSheetPreview, { project, part: "back-inner", candidate, presentation, embedded: true }),
}));
assert.equal((foldedBackHtml.match(/<section/g) ?? []).length, 1, "back fold renders exactly one A4 section");
assert.equal((foldedBackHtml.match(/width:150mm;height:118mm/g) ?? []).length, 2, "both back faces retain 150 x 118 mm geometry");
assert.ok(foldedBackHtml.indexOf("위: 뒷표지 바깥면") < foldedBackHtml.indexOf("아래: 뒷표지 안쪽면"));
assert.equal((foldedBackHtml.match(/<i>/g) ?? []).length, 4, "only four outer crop marks render");
assert.equal((foldedBackHtml.match(/foldLine/g) ?? []).length, 0, "embedded faces suppress their internal back fold lines");
assert.equal((foldedBackHtml.match(/<img[^>]*spine\.png/g) ?? []).length, 2, "outside face preserves the selected split spine");
assert.match(foldedBackHtml, /translate\(0mm, 0mm\) scale\(1\)/, "saved presentation transform reaches folded rendering");

console.log("studio-view: target plans, folded front/back sheets, split tray geometry, safety, selection, source checks passed");
