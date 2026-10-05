import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("lib/design-presets.ts");

async function loadPresets() {
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

const expectedTitles = {
  front: ["사진 한 장", "빛바랜 필름", "라이브 포스터", "타이포그래피", "사진 콜라주"],
  "front-inner": ["숨은 한 장면", "짧은 편지", "사진 스트립", "공연 정보 카드", "여백과 한 문장"],
  back: ["정돈된 트랙리스트", "사진 옆 곡 목록", "공연 기록표", "사진 위 작은 글자", "빈티지 음반 뒷면"],
  "back-inner": ["숨겨진 전체 사진", "표지의 연장선", "사진 아카이브", "공연장 풍경", "질감 중심"],
  "back-spine": ["표준 음반형", "표지 색상 연결형", "미니멀형", "아카이브형", "로고 중심형"],
  label: ["클래식 음반형", "사진 라벨형", "단색 미니멀형", "직접 기록한 부틀렉형", "동심원 타이포형"],
};

const baseContext = {
  title: "테스트 음반",
  artist: "테스트 아티스트",
  tracks: [],
};

test("여섯 영역에 정확히 다섯 개씩, 내용이 있는 고유 프리셋을 제공한다", async () => {
  const { DESIGN_PRESETS } = await loadPresets();
  assert.deepEqual(Object.keys(DESIGN_PRESETS), Object.keys(expectedTitles));

  const all = Object.values(DESIGN_PRESETS).flat();
  assert.equal(all.length, 30);
  assert.equal(new Set(all.map((item) => item.id)).size, 30);
  for (const [part, titles] of Object.entries(expectedTitles)) {
    assert.equal(DESIGN_PRESETS[part].length, 5);
    assert.deepEqual(DESIGN_PRESETS[part].map((item) => item.title), titles);
    for (const item of DESIGN_PRESETS[part]) {
      assert.ok(item.id && item.description && item.instructions);
      assert.ok(item.tags.length > 0);
      assert.equal(item.palette.length, 2);
    }
  }
});

test("영역별 프롬프트가 실제 인쇄 기하와 평면 출력 제약을 명시한다", async () => {
  const { DESIGN_PRESETS, buildPresetPrompt } = await loadPresets();
  const prompts = Object.fromEntries(Object.entries(DESIGN_PRESETS).map(([part, items]) => [
    part,
    buildPresetPrompt(part, items[0].id, { ...baseContext, includeMetadata: true }),
  ]));

  assert.match(prompts.front, /120×120mm 정사각형/);
  assert.match(prompts["front-inner"], /120×120mm 정사각형/);
  assert.match(prompts.back, /중앙 뒷표지 한 면만 정확히 137×118mm/);
  assert.match(prompts.back, /스파인을 포함하지 않는/);
  assert.match(prompts.back, /좌우 6\.5mm 스파인을 이 이미지 안에 합치지 않는다/);
  assert.match(prompts["back-inner"], /전체를 정확히 150×118mm/);
  assert.match(prompts["back-inner"], /중앙 137×118mm는 트레이 아래/);
  assert.match(prompts["back-spine"], /정확히 6\.5×118mm/);
  assert.match(prompts["back-spine"], /스트립 하나만/);
  assert.match(prompts["back-spine"], /좌우 스파인에 동일하게 재사용/);
  assert.match(prompts.label, /외경 Ø116mm, 중앙 내경 Ø23mm/);
  assert.match(prompts.label, /중앙 홀.*중요한 글자나 피사체를 두지 않는다/);

  for (const prompt of Object.values(prompts)) {
    assert.match(prompt, /정면의 평면 인쇄 아트워크만/);
    assert.match(prompt, /재단선, 접기선, 치수선, 템플릿 안내선은 결과 이미지에 그리지 않는다/);
    assert.match(prompt, /글자 자체를 보편적으로 금지하지 않는다/);
  }
});

test("뒷표지는 50개 실제 트랙을 안정 정렬한 복사본으로 전부 싣고 입력을 바꾸지 않는다", async () => {
  const { DESIGN_PRESETS, buildPresetPrompt } = await loadPresets();
  const tracks = Array.from({ length: 50 }, (_, index) => ({
    order: 50 - index,
    title: `한국어 곡 ${String(50 - index).padStart(2, "0")}`,
  }));
  const before = structuredClone(tracks);
  const prompt = buildPresetPrompt("back", DESIGN_PRESETS.back[0].id, {
    title: "긴 공연",
    artist: "연주자",
    tracks,
    includeMetadata: true,
  });

  assert.deepEqual(tracks, before);
  const lines = prompt.split("\n").filter((line) => /^\d{2}\. “한국어 곡 \d{2}”$/.test(line));
  assert.equal(lines.length, 50);
  assert.equal(lines[0], "01. “한국어 곡 01”");
  assert.equal(lines.at(-1), "50. “한국어 곡 50”");
  assert.ok(prompt.indexOf(lines[0]) < prompt.indexOf(lines.at(-1)));

  const noTracks = buildPresetPrompt("back", DESIGN_PRESETS.back[0].id, {
    ...baseContext,
    includeMetadata: true,
  });
  assert.match(noTracks, /실제 트랙이 아직 없다/);
  assert.match(noTracks, /곡명이나 순서를 만들지 말고.*직접 입력/);
});

test("메타데이터 제외 프롬프트는 프로젝트 글자를 누설하지 않고 사용자 원문과 셋리스트를 우선한다", async () => {
  const { DESIGN_PRESETS, buildPresetPrompt } = await loadPresets();
  const prompt = buildPresetPrompt("back", DESIGN_PRESETS.back[2].id, {
    title: "절대 포함하면 안 되는 제목",
    artist: "절대 포함하면 안 되는 아티스트",
    tracks: [{ order: 7, title: "절대 바꾸면 안 되는 사용자 곡" }],
    includeMetadata: false,
  });

  assert.doesNotMatch(prompt, /절대 포함하면 안 되는 제목|절대 포함하면 안 되는 아티스트|절대 바꾸면 안 되는 사용자 곡/);
  assert.match(prompt, /스타일과 구성만 제안/);
  assert.match(prompt, /기존 사용자 프롬프트.*항상 우선/);
  assert.match(prompt, /사용자 지정 셋리스트.*바꾸거나 다시 쓰거나 보충하지 않는다/);
  assert.match(prompt, /트랙리스트 언급은 배치 예시일 뿐.*새 글자를 추가하라는 지시가 아니다/);
});

test("append는 30,000자 원문을 자르거나 고치지 않고 replace는 생성문을 그대로 쓴다", async () => {
  const { applyPresetPrompt } = await loadPresets();
  const original = `  시작\n${"가나다라마바사".repeat(4_285)}\n끝  `;
  assert.ok(original.length > 30_000);
  const generated = "새 프리셋\n둘째 줄";
  const appended = applyPresetPrompt(original, generated, "append");

  assert.equal(appended.slice(0, original.length), original);
  assert.equal(appended, `${original}\n\n${generated}`);
  assert.equal(applyPresetPrompt(original, generated, "replace"), generated);
  assert.equal(applyPresetPrompt(original, "", "append"), original);
});

test("알 수 없는 영역과 해당 영역에 없는 프리셋 ID를 거절한다", async () => {
  const { DESIGN_PRESETS, buildPresetPrompt, applyPresetPrompt } = await loadPresets();
  assert.throws(() => buildPresetPrompt("unknown-part", "anything", baseContext), /알 수 없는 디자인 영역/);
  assert.throws(() => buildPresetPrompt("front", "missing-preset", baseContext), /알 수 없는 앞표지 프리셋/);
  assert.throws(
    () => buildPresetPrompt("front", DESIGN_PRESETS.back[0].id, baseContext),
    /알 수 없는 앞표지 프리셋/,
  );
  assert.throws(() => applyPresetPrompt("a", "b", "merge"), /알 수 없는 프롬프트 적용 방식/);
});

test("현재 참고 이름 0개와 여러 개를 구분하고 전달된 이름을 정확히 매핑한다", async () => {
  const { DESIGN_PRESETS, buildPresetPrompt } = await loadPresets();
  const none = buildPresetPrompt("front", DESIGN_PRESETS.front[0].id, {
    ...baseContext,
    includeMetadata: false,
  });
  assert.match(none, /현재 이 요청에 연결된 참고 이미지는 없다/);
  assert.match(none, /사진적 스타일은 사용할 수 있지만 실제 사진.*주장하지 않는다/);
  assert.match(none, /업로드 원본.*자동으로 적용하지 않는다/);

  const names = ["무대 왼쪽", "관객-필름 02", "로고 원본(흰색)"];
  const multiple = buildPresetPrompt("front", DESIGN_PRESETS.front[4].id, {
    ...baseContext,
    referenceNames: names,
    includeMetadata: false,
  });
  for (const name of names) assert.match(multiple, new RegExp(`- \\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  assert.match(multiple, /위 대괄호 안 이름을 정확히 사용/);
  assert.match(multiple, /기존 사용자 프롬프트가 각 이름에 지정한 역할과 해석.*우선/);
  assert.match(multiple, /목록 밖의 업로드 원본.*자동으로 적용하지 않는다/);
});
