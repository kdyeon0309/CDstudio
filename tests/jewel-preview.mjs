import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, parent, ...rest);
};
Module._extensions[".ts"] = function (module, filename) {
  const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  module._compile(result.outputText, filename);
};

const { canRenderJewelWebgl, deriveJewelArtwork, JEWEL_GEOMETRY } = require(path.join(root, "lib/jewel-preview.ts"));
assert.deepEqual(JEWEL_GEOMETRY.case, { widthMm: 142, heightMm: 125, depthMm: 10.4 });
assert.equal(JEWEL_GEOMETRY.tray.centerWidthMm + 2 * JEWEL_GEOMETRY.tray.spineMm, 150);
assert.deepEqual(JEWEL_GEOMETRY.disc, { outerDiameterMm: 120, innerDiameterMm: 15, thicknessMm: 1.2 });
assert.deepEqual(JEWEL_GEOMETRY.printableLabel, { outerDiameterMm: 116, innerDiameterMm: 23 });

const presentation = { fit: "contain", transform: { offsetXMm: 2, offsetYMm: -3, scale: 1.2 }, overlay: { enabled: true, color: "#fff", position: "bottom", fontSizeMm: 6 } };
const candidate = { id: "front-id", filename: "cover & art.png" };
const project = { id: "album/id", title: "Album", artist: "Artist", tracks: [], artwork: { variants: [], selected: 1 }, studio: { version: 1, printSource: "studio", snapshots: [], parts: { front: { candidates: [candidate], selectedCandidateId: "front-id", presentation }, back: { candidates: [{ ...candidate, id: "back", filename: "back.png" }], selectedCandidateId: "back", presentation }, "back-spine": { candidates: [{ ...candidate, id: "spine", filename: "spine.png" }], selectedCandidateId: "spine", presentation } } } };
const studio = deriveJewelArtwork(project);
assert.equal(studio.front.kind, "image");
assert.match(studio.front.url, /album%2Fid\/preview\/cover%20%26%20art\.png/);
assert.deepEqual(studio.front.transform, presentation.transform);
assert.deepEqual({ widthMm: studio.back.widthMm, heightMm: studio.back.heightMm }, { widthMm: 137, heightMm: 118 });
assert.equal(studio.backSpine.widthMm, 6.5);

project.studio.parts["back-spine"].selectedCandidateId = "missing";
const studioWithoutSpine = deriveJewelArtwork(project);
assert.equal(studioWithoutSpine.backSpine.kind, "placeholder", "missing spine art stays independent from the 137 mm rear face");
assert.equal(canRenderJewelWebgl(studioWithoutSpine), true, "image and placeholder faces are renderable together");
const placeholder = (part, widthMm = 120, heightMm = 120) => ({ kind: "placeholder", part, widthMm, heightMm });
const allPlaceholder = { source: "legacy", front: placeholder("front"), frontInner: placeholder("front-inner"), label: placeholder("label", 116, 116), back: placeholder("back", 150, 118), backInner: placeholder("back-inner", 150, 118), backSpine: placeholder("back-spine", 6.5, 118), splitBack: false };
assert.equal(canRenderJewelWebgl(allPlaceholder), true, "an album without generated art still receives a visible assembled case");
project.studio.printSource = "legacy";
project.artwork = { selected: 2, variants: [{ index: 2, name: "legacy", files: { front: "front.html", label: "disc.html" } }], partTransforms: { front: { offsetXMm: 4, offsetYMm: 1, scale: 1.4 } } };
const legacy = deriveJewelArtwork(project);
assert.equal(legacy.front.kind, "html");
assert.equal(legacy.label.kind, "html");
assert.equal(legacy.back.kind, "placeholder");
assert.equal(canRenderJewelWebgl(legacy), false, "any legacy HTML face keeps the artwork-preserving CSS renderer");
assert.equal(canRenderJewelWebgl({ ...allPlaceholder, front: studio.front, backInner: legacy.front }), false, "mixed image and HTML artwork must not silently drop its HTML face");

const clientPath = path.join(root, "app/album/[id]/preview/preview-client.tsx");
const client = fs.readFileSync(clientPath, "utf8");
const css = fs.readFileSync(path.join(root, "app/album/[id]/preview/preview.module.css"), "utf8");

// Execute the actual pure interaction helpers rather than duplicating their state table in the test.
const source = ts.createSourceFile(clientPath, client, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const helperNames = new Set(["PreviewPreset", "TrayStyle", "WebglFallbackState", "resolvePreviewPreset", "resolveManualLidPreset", "resolveAssemblyVisibility", "remainingForegroundTime", "resolveFallbackVisible", "resolveFallbackMessage", "resolveWebglMode"]);
const helperSource = source.statements
  .filter((node) => (ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && helperNames.has(node.name.text))
  .map((node) => node.getText(source))
  .join("\n");
const compiledHelpers = ts.transpileModule(`${helperSource}\nmodule.exports={resolvePreviewPreset,resolveManualLidPreset,resolveAssemblyVisibility,remainingForegroundTime,resolveFallbackVisible,resolveFallbackMessage,resolveWebglMode};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helperModule = { exports: {} };
new Function("module", "exports", compiledHelpers)(helperModule, helperModule.exports);
const { resolvePreviewPreset, resolveManualLidPreset, resolveAssemblyVisibility, remainingForegroundTime, resolveFallbackVisible, resolveFallbackMessage, resolveWebglMode } = helperModule.exports;

assert.deepEqual(resolvePreviewPreset("front"), { lidOpen: false, inspectInside: false, yaw: -24, pitch: -12 });
assert.deepEqual(resolvePreviewPreset("open"), { lidOpen: true, inspectInside: false, yaw: -18, pitch: -18 });
assert.deepEqual(resolvePreviewPreset("back"), { lidOpen: false, inspectInside: false, yaw: 156, pitch: -12 });
assert.deepEqual(resolvePreviewPreset("inside"), { lidOpen: true, inspectInside: true, yaw: -18, pitch: -18 });
assert.equal(resolveManualLidPreset("inside", true), "front", "closing during inside inspection exits inspection coherently");
assert.equal(resolveManualLidPreset("inside", false), "open", "opening during inside inspection exits to the normal open assembly");
assert.deepEqual(resolveAssemblyVisibility("inside", "black", true), { showTray: false, showDisc: false, innerExposed: true });
assert.deepEqual(resolveAssemblyVisibility("open", "clear", false), { showTray: true, showDisc: false, innerExposed: true });
assert.deepEqual(resolveAssemblyVisibility("front", "black", true), { showTray: true, showDisc: true, innerExposed: false });
assert.equal(remainingForegroundTime(4500, 1000, 2600), 2900, "only foreground elapsed time is charged to the renderer watchdog");
assert.equal(remainingForegroundTime(2900, 9000, 9000), 2900, "a paused watchdog does not consume time");
assert.equal(remainingForegroundTime(700, 1000, 2500), 0, "foreground time is clamped at expiry");
assert.equal(resolveFallbackVisible(false, false), true, "legacy and unavailable renderers keep the fallback visible");
assert.equal(resolveFallbackVisible(true, false), true, "the fallback remains visible while the first detailed frame loads");
assert.equal(resolveFallbackVisible(true, true), false, "a successful first frame hides the duplicate CSS assembly");
assert.equal(resolveFallbackVisible(false, true), true, "failure restores the fallback even if an old ready flag was observed");
assert.equal(resolveFallbackMessage(null), "");
assert.match(resolveFallbackMessage({ kind: "automatic", reason: "3D 첫 화면 준비가 너무 오래 걸렸습니다." }), /첫 화면 준비.+간단 미리보기로 전환했습니다/, "automatic fallback keeps its user-safe reason");
assert.match(resolveFallbackMessage({ kind: "manual" }), /사용자가.+다시 불러오기/, "manual selection is not described as an automatic renderer failure");
assert.deepEqual(resolveWebglMode(false, false, null, false), { usesWebgl: false, webglInteractive: false, fallbackVisible: true, canRequestWebgl: false, canRetryWebgl: false }, "an ineligible source remains on the CSS model");
assert.deepEqual(resolveWebglMode(true, false, null, false), { usesWebgl: false, webglInteractive: false, fallbackVisible: true, canRequestWebgl: true, canRetryWebgl: false }, "an eligible source still defaults to the CSS model until explicit selection");
assert.deepEqual(resolveWebglMode(true, false, null, true), { usesWebgl: false, webglInteractive: false, fallbackVisible: true, canRequestWebgl: true, canRetryWebgl: false }, "a stale ready event cannot hide the default CSS model");
assert.deepEqual(resolveWebglMode(true, true, null, false), { usesWebgl: true, webglInteractive: false, fallbackVisible: true, canRequestWebgl: false, canRetryWebgl: false }, "explicit selection mounts WebGL while retaining CSS during loading");
assert.deepEqual(resolveWebglMode(true, true, null, true), { usesWebgl: true, webglInteractive: true, fallbackVisible: false, canRequestWebgl: false, canRetryWebgl: false }, "only an explicitly requested ready renderer replaces CSS");
assert.deepEqual(resolveWebglMode(true, false, { kind: "automatic", reason: "실패" }, true), { usesWebgl: false, webglInteractive: false, fallbackVisible: true, canRequestWebgl: false, canRetryWebgl: true }, "failure wins over stale readiness and exposes retry");
assert.deepEqual(resolveWebglMode(true, false, { kind: "manual" }, false), { usesWebgl: false, webglInteractive: false, fallbackVisible: true, canRequestWebgl: false, canRetryWebgl: true }, "manual fallback stays on CSS until explicit retry");

assert.match(client, /cache:\s*"no-store"/);
assert.match(client, /return <PreviewContent key=\{projectId\}/, "project changes remount preview state");
assert.match(client, /viewPreset=\{viewPreset\}[\s\S]*trayStyle=\{trayStyle\}[\s\S]*discVisible=\{discVisible && viewPreset !== "inside"\}/);
assert.match(client, /const \[webglRequested, setWebglRequested\] = useState\(false\)/, "refresh and project-key remount default to the CSS model");
assert.match(client, /const artwork = useMemo[\s\S]*const webglAvailable = Boolean\(artwork && canRenderJewelWebgl\(artwork\)\)[\s\S]*resolveWebglMode\(webglAvailable, webglRequested, webglFallback, webglReady\)/, "renderer mode combines source eligibility, explicit request, fallback, and readiness");
assert.doesNotMatch(client, /studioWebglAvailable|printSource === "studio"/, "renderer eligibility is not coupled to project generation mode");
assert.match(client, /document\.addEventListener\("visibilitychange", onVisibilityChange\)[\s\S]*document\.removeEventListener\("visibilitychange", onVisibilityChange\)/, "the outer watchdog pauses and resumes with page visibility");
assert.match(client, /if \(document\.hidden\) pause\(\); else resume\(\)/);
assert.match(client, /const tick = \(now: number\) => \{[\s\S]*frame = null;[\s\S]*if \(!document\.hidden\) frame = requestAnimationFrame\(tick\)/, "the fallback rotation loop never reschedules while hidden");
assert.match(client, /const resume = \(\) => \{[\s\S]{0,180}previous = performance\.now\(\);[\s\S]{0,100}requestAnimationFrame\(tick\)/, "resuming resets the frame clock so hidden time cannot cause a rotation jump");
assert.match(client, /const pause = \(\) => \{[\s\S]{0,140}cancelAnimationFrame\(frame\);[\s\S]{0,80}frame = null/, "pausing cancels the one outstanding fallback frame");
assert.doesNotMatch(client, /고급 3D|기본 3D|GPU|WebGL을/, "implementation and quality tiers are not exposed in product copy");
assert.match(client, /canRequestWebgl && <button[^>]*onClick=\{requestWebgl\}>정밀 미리보기 시도<\/button>/, "precision rendering requires an explicit user action outside the viewport");
assert.match(client, /usesWebgl && <button[^>]*onClick=\{showSimplePreview\}>화면이 안 보이면 간단 미리보기로 전환<\/button>/, "manual fallback stays available while detailed rendering is loading or ready");
assert.match(client, /const showSimplePreview[\s\S]{0,600}setWebglRequested\(false\)[\s\S]{0,600}setWebglReady\(false\)[\s\S]{0,600}kind: "manual"[\s\S]{0,600}drag\.current = null[\s\S]{0,600}setAutoRotate\(false\)[\s\S]{0,600}viewRef\.current = \{ \.\.\.INITIAL_VIEW \}[\s\S]{0,200}applyTransform\(\)/, "manual fallback disables WebGL and restores a stable, visible 100% CSS view");
assert.match(client, /const handleWebglFailure[\s\S]{0,300}setWebglRequested\(false\)[\s\S]{0,300}kind: "automatic"[\s\S]{0,200}setWebglReady\(false\)/, "automatic failure immediately revokes the WebGL request");
assert.match(client, /const requestWebgl[\s\S]{0,400}setWebglReady\(false\)[\s\S]{0,200}setWebglResetKey[\s\S]{0,200}setWebglRequested\(true\)/, "the initial precision attempt is an explicit fresh mount");
assert.match(client, /const retryWebgl[\s\S]{0,500}setWebglReady\(false\)[\s\S]{0,200}setWebglResetKey[\s\S]{0,200}setWebglFallback\(null\)[\s\S]{0,200}setWebglRequested\(true\)/, "retry clears stale readiness and explicitly remounts WebGL");
assert.match(client, /canRetryWebgl && <button[^>]*onClick=\{retryWebgl\}>다시 불러오기<\/button>/, "retry is offered only after automatic or manual fallback");
assert.equal((client.match(/setWebglRequested\(true\)/g) ?? []).length, 2, "only the two explicit user-button callbacks can activate WebGL");
assert.doesNotMatch(client, /on(?:Initializing|Ready)=\{[^}]*setWebglRequested\(true\)/, "renderer lifecycle callbacks cannot activate WebGL");
assert.match(client, /\{fallbackMessage && <p[^>]*role="status">\{fallbackMessage\}<\/p>\}/, "failure reason is rendered outside the WebGL layer");
assert.match(client, /onInitializing=\{\(\) => setWebglReady\(false\)\}/, "a renderer source remount invalidates stale readiness before its next frame");

const webglSource = fs.readFileSync(path.join(root, "app/album/[id]/preview/webgl-jewel.tsx"), "utf8");
assert.match(webglSource, /onFailure\(reason\?: string\): void/, "renderer failures may carry a user-safe reason");
assert.match(webglSource, /useLayoutEffect\(\(\) => \{ callbacks\.current\.onInitializing\?\.\(\); \}, \[artwork, project\]\)/, "initialization clears stale parent readiness before paint without callback identity dependencies");
for (const reason of ["3D 렌더러를 시작할 수 없습니다.", "3D 화면을 페이지에 연결하지 못했습니다.", "3D 카메라 조작을 준비하지 못했습니다.", "3D 조명 환경을 준비하지 못했습니다.", "3D 케이스 모델을 조립하지 못했습니다.", "3D 표시 영역의 크기를 읽지 못했습니다.", "3D 첫 화면 준비가 너무 오래 걸렸습니다.", "3D 연결이 끊겼습니다.", "3D 첫 화면을 그리지 못했습니다."]) {
  assert.ok(webglSource.includes(reason), `missing safe renderer failure reason: ${reason}`);
}
assert.doesNotMatch(webglSource, /callbacks\.current\.onFailure\(\)/, "renderer failure branches do not discard their reason");
assert.match(client, /<Artwork source=\{artwork\.back\}[\s\S]*<Artwork source=\{artwork\.backSpine\}/, "rear and folded spine artwork use separate physical elements");
assert.match(client, /!assembly\.showTray \? styles\.trayRemoved[\s\S]*!assembly\.showDisc \? styles\.discHidden/);
assert.match(client, /viewRef\.current = \{ \.\.\.INITIAL_VIEW, x: next\.pitch \};[\s\S]*setView\(\{ \.\.\.INITIAL_VIEW, x: next\.pitch \}\)/, "preset selection clears stale pan and zoom before reframing");
assert.match(client, /className=\{`\$\{styles\.floor\} \$\{!fallbackVisible \? styles\.fallbackHidden[\s\S]*aria-hidden=\{!fallbackVisible\}[\s\S]*styles\.scene/s, "the floor and CSS case hide together after the first detailed frame");
assert.match(client, /disabled=\{viewPreset === "inside"\}[\s\S]*속지 검사 중/, "the disc toggle cannot imply a mounted disc during inspection");
assert.match(client, /142 × 125 × 10\.4mm/);

assert.match(css, /--case-h:calc\(var\(--mm\) \* 125\)/, "all fallback proportions derive from the 142 mm case scale");
assert.match(css, /--hinge-strip:calc\(var\(--mm\) \* 10\.5\)[\s\S]*--lid-w:calc\(var\(--mm\) \* 131\.5\)/, "the fixed hinge strip is excluded from the moving lid");
assert.match(css, /--lid-pivot-y:calc\(var\(--mm\) \* 6\.9\)/);
assert.match(css, /\.lidOpen\s*\{[^}]*rotateY\(-114deg\)/s);
assert.match(css, /\.frontInsert\s*\{[^}]*translateZ\(calc\(var\(--mm\) \* 2\.205\)\)/s, "outer booklet face is at world depth 9.105 mm");
assert.match(css, /\.frontInner\s*\{[^}]*translateZ\(calc\(var\(--mm\) \* 1\.915\)\) rotateY\(180deg\)/s, "inner booklet face remains a thin paper layer at world depth 8.815 mm");
assert.match(css, /--disc-center-x:calc\(50% \+ var\(--mm\) \* 5\)/, "the disc is anchored at physical X +5 mm");
assert.match(css, /--booklet-left:calc\(var\(--mm\) \* 5\.5\)/, "booklet local offset plus the 10.5 mm hinge strip centers it at physical X +5 mm");
assert.match(css, /--back-w:calc\(var\(--mm\) \* 137\)/);
assert.match(css, /\.backInner\s*\{[^}]*opacity:1/s, "inner artwork is not artificially faded");
assert.match(css, /\.backCenter\s*\{[^}]*inset:0!important[^}]*width:100%!important[^}]*height:100%!important/s, "the central rear source fills its 137 × 118 mm plane");
assert.match(css, /\.placeholder\s*\{[^}]*position:absolute[^}]*width:100%[^}]*height:100%/s, "empty artwork still occupies every physical face");
assert.doesNotMatch(css, /\.scene\s*\{[^}]*transition:\s*transform/s, "RAF transforms are applied directly instead of chasing a transition");
assert.doesNotMatch(css, /\.webglLayer\s*\{[^}]*transition:/s, "the ready commit atomically swaps renderers without a blank opacity interval");
assert.match(css, /\.fallbackHidden\s*\{[^}]*visibility:hidden[^}]*pointer-events:none/s, "hidden fallback cannot ghost through the alpha canvas or receive input");
assert.match(css, /\.trayRemoved \.tray\s*\{\s*visibility:hidden/, "inside inspection removes the tray instead of floating the disc outside");
assert.match(css, /\.discHidden \.discAssembly,\.discHidden \.hub/);
assert.match(css, /\.trayClear\s*\{[^}]*--tray-bg:[^}]*rgba/s);
assert.match(css, /\.trayBlack\s*\{[^}]*--tray-bg:[^}]*#0c0f13/s);
assert.match(css, /\.spinePanel\s*\{[^}]*width:var\(--spine-depth\)!important[^}]*height:var\(--back-h\)!important/s, "spines retain their 6.5 × 118 mm source dimensions");
assert.doesNotMatch(css, /grid-template-columns:6\.5fr 137fr 6\.5fr/);
assert.match(css, /touch-action:\s*none/);
assert.match(css, /rotateY\(-1(?:1[0-9]|2[0-5])deg\)/);

// Parse and execute the CSS fallback geometry instead of only matching new constants.
const rule = (pattern, index = 0) => {
  const matches = [...css.matchAll(new RegExp(`${pattern}\\s*\\{([^}]*)\\}`, "g"))];
  const match = index < 0 ? matches.at(index) : matches[index];
  assert.ok(match, `missing CSS rule: ${pattern}`);
  return match[1];
};
const declaration = (block, property) => {
  const match = block.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  assert.ok(match, `missing CSS declaration: ${property}`);
  return match[1].trim().replace(/!important$/, "").trim();
};
const sceneRule = rule("\\.scene");
const cssVars = {};
for (const match of sceneRule.matchAll(/--([a-z-]+):calc\(var\(--mm\)\s*\*\s*([\d.]+)\)/g)) cssVars[match[1]] = Number(match[2]);
cssVars.mm = 1;
const caseWidthMm = Number(sceneRule.match(/--mm:calc\(var\(--case-w\)\s*\/\s*([\d.]+)\)/)?.[1]);
const evaluateLength = (value, percentBase) => {
  let expression = value.replace(/^calc\((.*)\)$/s, "$1");
  expression = expression.replace(/var\(--([a-z-]+)\)/g, (_, name) => {
    assert.ok(Number.isFinite(cssVars[name]), `unknown CSS length variable: ${name}`);
    return String(cssVars[name]);
  });
  expression = expression.replace(/([\d.]+)%/g, (_, percent) => String(percentBase * Number(percent) / 100));
  assert.match(expression, /^[\d.()+\-*/\s]+$/, `unsafe CSS arithmetic: ${expression}`);
  return Function(`"use strict"; return (${expression});`)();
};
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);
const extents = (points, axis) => {
  const values = points.map((point) => point[axis]);
  return [Math.min(...values), Math.max(...values)];
};
const nearExtents = (actual, expected) => { near(actual[0], expected[0]); near(actual[1], expected[1]); };
const foldedPlane = ({ left, top, width, height, originX, transform }) => {
  const match = transform.match(/^translateZ\(var\(--([a-z-]+)\)\)\s+rotateY\((-?[\d.]+)deg\)$/);
  assert.ok(match, `unexpected folded transform: ${transform}`);
  const translateZ = cssVars[match[1]], angle = THREE.MathUtils.degToRad(Number(match[2]));
  const origin = new THREE.Vector3(originX, height / 2, 0);
  const matrix = new THREE.Matrix4().makeTranslation(0, 0, translateZ).multiply(new THREE.Matrix4().makeRotationY(angle));
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => new THREE.Vector3(x, y, 0).sub(origin).applyMatrix4(matrix).add(origin).add(new THREE.Vector3(left, top, 0)));
  const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().makeRotationY(angle)).normalize();
  return { corners, normal };
};
const rotatedPlane = ({ left, top, width, height, originX, originY, axis, degrees }) => {
  const origin = new THREE.Vector3(originX, originY, 0);
  const rotation = axis === "x" ? new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(degrees)) : new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(degrees));
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => new THREE.Vector3(x, y, 0).sub(origin).applyMatrix4(rotation).add(origin).add(new THREE.Vector3(left, top, 0)));
  return { corners, normal: new THREE.Vector3(0, 0, 1).applyMatrix4(rotation).normalize() };
};

assert.equal(caseWidthMm, 142);
assert.deepEqual({ backWidth: cssVars["back-w"], backHeight: cssVars["back-h"], spineDepth: cssVars["spine-depth"] }, { backWidth: 137, backHeight: 118, spineDepth: 6.5 });
const caseHeightMm = cssVars["case-h"], borderMm = cssVars["case-border"];
const paddingWidth = caseWidthMm - 2 * borderMm, paddingHeight = caseHeightMm - 2 * borderMm;
const spinePanelRule = rule("\\.spinePanel"), leftRule = rule("\\.spineLeft"), rightRule = rule("\\.spineRight");
const top = borderMm + evaluateLength(declaration(spinePanelRule, "top"), paddingHeight);
const spineWidth = evaluateLength(declaration(spinePanelRule, "width"), paddingWidth), spineHeight = evaluateLength(declaration(spinePanelRule, "height"), paddingHeight);
const leftSeam = borderMm + evaluateLength(declaration(leftRule, "left"), paddingWidth);
const rightBoxLeft = borderMm + evaluateLength(declaration(rightRule, "left"), paddingWidth);
const leftSpine = foldedPlane({ left: leftSeam, top, width: spineWidth, height: spineHeight, originX: 0, transform: declaration(leftRule, "transform") });
const rightSpine = foldedPlane({ left: rightBoxLeft, top, width: spineWidth, height: spineHeight, originX: spineWidth, transform: declaration(rightRule, "transform") });
near(spineWidth, 6.5); near(spineHeight, 118);
assert.equal(declaration(leftRule, "transform-origin"), "left center");
assert.equal(declaration(rightRule, "transform-origin"), "right center");
nearExtents(extents(leftSpine.corners, "x"), [2.5, 2.5]);
nearExtents(extents(rightSpine.corners, "x"), [139.5, 139.5]);
nearExtents(extents(leftSpine.corners, "y"), [3.5, 121.5]);
nearExtents(extents(rightSpine.corners, "y"), [3.5, 121.5]);
nearExtents(extents(leftSpine.corners, "z"), [1.42, 7.92]);
nearExtents(extents(rightSpine.corners, "z"), [1.42, 7.92]);
near(leftSpine.normal.x, -1); near(leftSpine.normal.z, 0);
near(rightSpine.normal.x, 1); near(rightSpine.normal.z, 0);

const backRule = rule("\\.backInsert"), innerRule = rule("\\.backInner");
assert.equal(declaration(backRule, "transform"), "translateZ(var(--rear-outer-z)) rotateY(180deg)", "rear outer face translates to its factory depth before flipping");
assert.equal(declaration(innerRule, "transform"), "translateZ(var(--rear-inner-z))");
near(cssVars["rear-outer-z"], 1.305);
near(cssVars["rear-inner-z"], 1.535);
near(borderMm + evaluateLength(declaration(backRule, "top"), paddingHeight), 3.5);
near(borderMm + evaluateLength(declaration(innerRule, "top"), paddingHeight), 3.5);
const backWidth = evaluateLength(declaration(backRule, "width"), paddingWidth), backHeight = evaluateLength(declaration(backRule, "height"), paddingHeight);
const backLeft = borderMm + paddingWidth / 2 - backWidth / 2, backTop = borderMm + evaluateLength(declaration(backRule, "top"), paddingHeight);
near(backLeft, 2.5);
near(backLeft + backWidth, 139.5);
const backAngle = Number(declaration(backRule, "transform").match(/rotateY\((-?[\d.]+)deg\)/)?.[1]);
const backOrigin = new THREE.Vector3(backWidth / 2, backHeight / 2, 0), backRotation = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(backAngle));
const mapBackSourcePoint = (x) => new THREE.Vector3(x, backHeight / 2, 0).sub(backOrigin).applyMatrix4(backRotation).add(backOrigin).add(new THREE.Vector3(backLeft, backTop, cssVars["rear-outer-z"]));
near(mapBackSourcePoint(0).x, 139.5, 1e-8);
near(mapBackSourcePoint(backWidth).x, 2.5, 1e-8);

const bottomWallRule = rule("\\.caseBase::before"), rightWallRule = rule("\\.caseBase::after", -1);
const wallLeft = borderMm + evaluateLength(declaration(bottomWallRule, "left"), paddingWidth);
const wallRight = borderMm + paddingWidth - evaluateLength(declaration(bottomWallRule, "right"), paddingWidth);
const wallBottom = borderMm + paddingHeight - evaluateLength(declaration(bottomWallRule, "bottom"), paddingHeight);
const bottomWallHeight = evaluateLength(declaration(bottomWallRule, "height"), paddingHeight);
const bottomWall = rotatedPlane({ left: wallLeft, top: wallBottom - bottomWallHeight, width: wallRight - wallLeft, height: bottomWallHeight, originX: (wallRight - wallLeft) / 2, originY: bottomWallHeight, axis: "x", degrees: Number(declaration(bottomWallRule, "transform").match(/rotateX\((-?[\d.]+)deg\)/)?.[1]) });
const rightWallTop = borderMm + evaluateLength(declaration(rightWallRule, "top"), paddingHeight);
const rightWallBottom = borderMm + paddingHeight - evaluateLength(declaration(rightWallRule, "bottom"), paddingHeight);
const rightWallEdge = borderMm + paddingWidth - evaluateLength(declaration(rightWallRule, "right"), paddingWidth);
const rightWallWidth = evaluateLength(declaration(rightWallRule, "width"), paddingWidth);
const rightWall = rotatedPlane({ left: rightWallEdge - rightWallWidth, top: rightWallTop, width: rightWallWidth, height: rightWallBottom - rightWallTop, originX: rightWallWidth, originY: (rightWallBottom - rightWallTop) / 2, axis: "y", degrees: Number(declaration(rightWallRule, "transform").match(/rotateY\((-?[\d.]+)deg\)/)?.[1]) });
assert.equal(declaration(bottomWallRule, "transform-origin"), "center bottom");
assert.equal(declaration(rightWallRule, "transform-origin"), "right center");
nearExtents(extents(bottomWall.corners, "x"), [0, 142]);
nearExtents(extents(bottomWall.corners, "y"), [125, 125]);
nearExtents(extents(bottomWall.corners, "z"), [0, 10.4]);
nearExtents(extents(rightWall.corners, "x"), [142, 142]);
nearExtents(extents(rightWall.corners, "y"), [0, 125]);
nearExtents(extents(rightWall.corners, "z"), [0, 10.4]);
near(bottomWall.normal.y, 1); near(bottomWall.normal.z, 0);
near(rightWall.normal.x, 1); near(rightWall.normal.z, 0);

const caseWidths = [...css.matchAll(/--case-w:(\d+)px/g)].map(([, value]) => Number(value));
assert.deepEqual(caseWidths, [426, 326, 284, 240, 210]);
assert.match(client, /<Artwork source=\{artwork\.backSpine\}[\s\S]*<Artwork source=\{artwork\.backSpine\}[\s\S]*<div className=\{`\$\{styles\.lid\}/, "both spines remain outside the moving lid");
for (const caseWidth of caseWidths) {
  const pxPerMm = caseWidth / caseWidthMm;
  const scale = new THREE.Matrix4().makeScale(pxPerMm, pxPerMm, pxPerMm);
  for (const lidAngle of [0, -114]) {
    const scaledLeft = leftSpine.corners.map((point) => point.clone().applyMatrix4(scale));
    const scaledRight = rightSpine.corners.map((point) => point.clone().applyMatrix4(scale));
    near(extents(scaledLeft, "x")[0], 2.5 * pxPerMm);
    near(extents(scaledRight, "x")[0], 139.5 * pxPerMm);
    near(extents(scaledLeft, "y")[0], 3.5 * pxPerMm);
    near(extents(scaledLeft, "y")[1], 121.5 * pxPerMm);
    near(extents(scaledLeft, "z")[0], 1.42 * pxPerMm);
    near(extents(scaledLeft, "z")[1], 7.92 * pxPerMm);
    near(extents(scaledRight, "z")[0], 1.42 * pxPerMm);
    near(extents(scaledRight, "z")[1], 7.92 * pxPerMm);
    assert.ok(extents(scaledLeft, "x")[0] >= 0 && extents(scaledRight, "x")[1] <= 142 * pxPerMm, "spines stay between the shell side walls");
    assert.ok(extents(scaledLeft, "y")[0] >= 0 && extents(scaledRight, "y")[1] <= 125 * pxPerMm, "spines stay between the shell top and bottom walls");
    assert.ok(extents(scaledLeft, "z")[0] >= 0 && extents(scaledRight, "z")[1] <= 10.4 * pxPerMm, "spines stay inside the positive shell depth");
    assert.ok(lidAngle === 0 || lidAngle === -114, "lid state cannot alter the sibling spine matrix");
  }
}

const spineOverlayRule = rule("\\.spinePanel \\.overlay"), spineTitleRule = rule("\\.spineTitle");
near(evaluateLength(declaration(spineOverlayRule, "top"), cssVars["back-h"]), 3);
near(evaluateLength(declaration(spineOverlayRule, "bottom"), cssVars["back-h"]), 3);
near(cssVars["back-h"] - 3 - 3, 112);
assert.equal(declaration(spineOverlayRule, "writing-mode"), "vertical-rl");
assert.equal(declaration(spineOverlayRule, "flex-direction"), "row", "vertical inline axis is the flex main axis");
assert.match(css, /\.spineLeft \.overlayTop,\.spineRight \.overlayBottom\s*\{\s*justify-content:flex-start/);
assert.match(css, /\.spineLeft \.overlayBottom,\.spineRight \.overlayTop\s*\{\s*justify-content:flex-end/);
assert.match(css, /\.spineRight \.overlay\s*\{\s*transform:rotate\(180deg\)/, "the print-left copy is reversed on the world-right spine after the rear 180-degree mapping");
assert.doesNotMatch(rule("\\.spinePanel \\.artTransform"), /rotate|transform/, "the original spine bitmap is not rotated by the text correction");
assert.equal(declaration(spineTitleRule, "font-size"), "inherit");
assert.equal(declaration(spineTitleRule, "max-height"), "100%");
assert.doesNotMatch(spineTitleRule, /\.45em/);
assert.match(client, /source\.part === "back-spine" \? `calc\(var\(--mm\) \* \$\{source\.overlay\.fontSizeMm\}\)`/, "spine overlay type scales in physical millimetres");
const worldRightOverlayRule = rule("\\.spineRight \\.overlay"), overlayAngle = Number(declaration(worldRightOverlayRule, "transform").match(/rotate\((-?[\d.]+)deg\)/)?.[1]);
const rightFoldAngle = Number(declaration(rightRule, "transform").match(/rotateY\((-?[\d.]+)deg\)/)?.[1]);
const leftFoldAngle = Number(declaration(leftRule, "transform").match(/rotateY\((-?[\d.]+)deg\)/)?.[1]);
const printLeftInline = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(overlayAngle)));
const worldRightInline = printLeftInline.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(rightFoldAngle)));
const worldLeftInline = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(leftFoldAngle)));
near(worldRightInline.x, 0); near(worldRightInline.y, -1); near(worldRightInline.z, 0);
near(worldLeftInline.x, 0); near(worldLeftInline.y, 1); near(worldLeftInline.z, 0);

console.log("jewel-preview: artwork mapping, presets, fallback assembly, and recovery contract passed");
