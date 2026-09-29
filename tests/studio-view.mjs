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
const { selectedStudioParts, studioPrintEnabled, studioPrintResolution, studioSpineNeedsBack } = require(path.join(root, "lib/studio-view.ts"));
const ArtworkSheetPreview = require(path.join(root, "components/ArtworkSheetPreview.tsx")).default;
const sheetCss = fs.readFileSync(path.join(root, "components/ArtworkSheetPreview.module.css"), "utf8");
assert.match(sheetCss, /\.sheet\s*\{[^}]*width:\s*210mm;[^}]*height:\s*297mm;/s, "A4 dimensions must remain physical CSS mm");
for (const cssFile of ["components/ArtworkSheetPreview.module.css", "app/album/[id]/print/print.module.css"]) {
  const printCss = fs.readFileSync(path.join(root, cssFile), "utf8").split("@media print").at(-1);
  assert.match(printCss, /\.foldLine\s*\{[^}]*top:\s*-4mm;[^}]*bottom:\s*auto;[^}]*height:\s*2mm;[^}]*border-left:[^;]*solid/s,
    `${cssFile}: printed fold guide must be a short mark above the artwork`);
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
const resolution = (part, width, height, scale = 1, fit = "cover", separateSpine = false, offsetXMm = 0, offsetYMm = 0) =>
  studioPrintResolution({ width, height }, part, { fit, transform: { offsetXMm, offsetYMm, scale } }, separateSpine);
assert.equal(resolution("front", 1418, 1418).grade, "target", "front reaches 300 PPI at its full 120 mm size");
assert.equal(resolution("front-inner", 1417, 1417).grade, "below-target");
assert.equal(resolution("back", 1772, 1394).grade, "target", "full back uses 150 x 118 mm");
assert.equal(resolution("back-inner", 1772, 1394).grade, "target");
assert.equal(resolution("label", 1371, 1371).grade, "target", "label uses 116 mm diameter");
assert.equal(resolution("back-spine", 77, 1394).grade, "target", "narrow spine uses both physical axes");
assert.equal(resolution("back-spine", 1024, 1024).ppi, 220, "a square spine is constrained by its 118 mm height");
assert.equal(resolution("back", 1619, 1394).grade, "below-target", "full back needs more pixels across 150 mm");
assert.equal(resolution("back", 1619, 1394, 1, "cover", true).grade, "target", "selected separate spine narrows central panel to 137 mm");
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
assert.equal(resolution("back", 1772, 1394, 1.2, "cover", false, 14).fullBleed, true);
assert.equal(resolution("back", 1772, 1394, 1.2, "cover", true, 14).fullBleed, false,
  "selected spine changes the center panel's allowable offset");
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
assert.match(printClientSource, /여백 가능/);
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
assert.match(studioClientSource,
  /STUDIO_ARTWORK_PARTS\.some\(\(part\) => draftDirty\[part\] \|\| presentationDirty\[part\]\)/,
  "navigation guard checks dirty state restored for every studio part");
assert.match(studioClientSource,
  /async function persistDirtyPresentations[\s\S]*STUDIO_ARTWORK_PARTS\.filter\(\(part\) => presentationDirty\[part\]\)[\s\S]*await persistPresentation\(part\)/,
  "all dirty presentation parts are saved individually");
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
assert.ok(!unsplitHtml.includes("splitRegion"), "older back artwork stays full width");
assert.ok(unsplitHtml.includes("spineTextLeft"), "older automatic spine text remains");

console.log("studio-view: 5 A4 sheets, split tray geometry, safety, selection, source checks passed");
