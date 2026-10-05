import type { StudioArtworkPart } from "./types";

export interface DesignPreset {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  layout: "photo" | "type" | "collage" | "text" | "texture" | "split" | "list" | "strip" | "spine" | "disc";
  palette: readonly [string, string];
  instructions: string;
}

export interface PresetPromptContext {
  title: string;
  artist: string;
  tracks: readonly { order: number; title: string }[];
  referenceNames?: readonly string[];
  includeMetadata?: boolean;
}

const preset = (
  id: string,
  title: string,
  description: string,
  tags: readonly string[],
  layout: DesignPreset["layout"],
  palette: readonly [string, string],
  instructions: string,
): DesignPreset => ({ id, title, description, tags, layout, palette, instructions });

export const DESIGN_PRESETS: Record<StudioArtworkPart, readonly DesignPreset[]> = {
  front: [
    preset(
      "front-single-photo",
      "사진 한 장",
      "한 장의 강한 이미지와 절제된 음반 정보를 쓰는 표지",
      ["사진", "풀블리드", "절제"],
      "photo",
      ["#171512", "#e8e0d0"],
      "한 장의 이미지를 가장자리까지 크게 두고 시선이 머무는 지점에는 충분한 여백을 남긴다. 현재 연결된 참고 이미지가 있으면 그중 하나만 주 피사체로 사용하고, 없으면 특정 실물 사진인 것처럼 주장하지 않는 사진적 장면으로 구성한다. 제공된 글자는 작고 선명한 음반 타이포그래피로 배치한다.",
    ),
    preset(
      "front-faded-film",
      "빛바랜 필름",
      "오래 보관한 필름 인화처럼 따뜻하고 부드러운 표지",
      ["필름", "빈티지", "그레인"],
      "texture",
      ["#8b5e45", "#e5cfaa"],
      "낮은 채도, 부드러운 입자, 미세한 색 번짐과 빛샘을 사용해 오래된 필름 인화의 정서를 만든다. 실제 촬영 날짜나 장소를 암시하는 도장과 메모는 넣지 않는다. 제공된 제목과 아티스트는 인화지에 정갈하게 인쇄된 글자처럼 처리한다.",
    ),
    preset(
      "front-live-poster",
      "라이브 포스터",
      "공연 포스터의 힘 있는 위계와 인쇄 질감을 빌린 표지",
      ["공연", "포스터", "고대비"],
      "type",
      ["#d9362b", "#f2dfb5"],
      "큰 제목, 굵은 형태, 제한된 색과 거친 망점으로 라이브 포스터 같은 에너지를 만든다. 프로젝트에서 제공된 제목과 아티스트만 공연명처럼 사용할 수 있다. 날짜, 장소, 출연자, 주최 문구나 티켓 정보는 사용자가 제공하지 않았다면 만들지 말고 빈 장식 영역으로 남긴다.",
    ),
    preset(
      "front-typography",
      "타이포그래피",
      "글자 자체를 주인공으로 삼는 선명한 그래픽 표지",
      ["타이포", "그래픽", "모던"],
      "type",
      ["#111827", "#f4f1e8"],
      "제목의 정확한 철자와 줄바꿈을 중심으로 크기, 굵기, 자간의 대비를 만든다. 아티스트는 제목보다 한 단계 낮은 위계로 두고, 기하학적 선과 면은 글자의 리듬을 보조하도록 제한한다. 읽을 수 없는 가짜 글자로 빈 공간을 채우지 않는다.",
    ),
    preset(
      "front-photo-collage",
      "사진 콜라주",
      "여러 장면을 잘라 붙인 수작업 콜라주 표지",
      ["콜라주", "사진", "수작업"],
      "collage",
      ["#243447", "#d7c3a5"],
      "현재 연결된 참고 이미지들을 서로 다른 크기의 종이 조각처럼 겹치고, 가장자리와 그림자는 얇고 평면적으로 유지한다. 참고 이미지가 없으면 사진 조각을 실제 기록물로 가장하지 말고 추상적인 사진 질감과 색면으로 같은 리듬만 만든다. 제목과 아티스트는 콜라주 위에서 읽히는 한 개의 명확한 정보 블록으로 둔다.",
    ),
  ],
  "front-inner": [
    preset(
      "front-inner-hidden-scene",
      "숨은 한 장면",
      "표지를 연 뒤 발견하는 조용한 한 장면",
      ["사진", "내지", "고요"],
      "photo",
      ["#25302b", "#c8b99c"],
      "앞표지보다 조용하고 가까운 구도의 한 장면을 넓게 배치한다. 현재 연결된 참고 이미지가 있다면 표지에서 덜 드러난 세부를 선택하고, 없다면 실제 공연 기록이라고 단정하지 않는 사진적 장면을 만든다. 글자는 필요한 경우에만 작은 크기로 두어 이미지의 여운을 보존한다.",
    ),
    preset(
      "front-inner-short-letter",
      "짧은 편지",
      "짧은 글을 위한 종이와 필기 여백 중심의 내지",
      ["편지", "손글씨", "여백"],
      "text",
      ["#ece3d2", "#4a3d34"],
      "따뜻한 종이 바탕과 넓은 여백으로 짧은 편지를 읽는 구성을 만든다. 편지 문구나 메모는 사용자가 명시해 준 경우에만 그대로 사용한다. 문구가 없으면 내용을 지어내지 말고 나중에 직접 적을 수 있는 빈 영역과 작은 장식만 둔다.",
    ),
    preset(
      "front-inner-photo-strip",
      "사진 스트립",
      "연속된 순간을 보여 주는 가로 사진 스트립",
      ["사진", "스트립", "연속"],
      "strip",
      ["#121212", "#d8d4cc"],
      "세 장에서 다섯 장의 가로 프레임을 일정한 간격으로 이어 필름 스트립 같은 흐름을 만든다. 연결된 참고 이미지만 실제 사진으로 취급하고, 같은 이미지를 쓸 때는 서로 다른 크롭으로 변주한다. 참고가 없으면 특정 인물이나 공연의 기록이라고 주장하지 않는 사진적 프레임으로 구성한다.",
    ),
    preset(
      "front-inner-show-card",
      "공연 정보 카드",
      "공연 기록을 정리해 적을 수 있는 단정한 카드",
      ["공연", "정보", "카드"],
      "text",
      ["#203247", "#ddd2bc"],
      "제목 영역과 날짜, 장소, 출연자 메모 칸이 구분된 작은 공연 정보 카드를 중앙에 둔다. 프로젝트 제목과 아티스트 외의 날짜, 장소, 사람 이름은 사용자가 제공한 경우에만 채운다. 제공되지 않은 칸은 가짜 정보 대신 빈 줄이나 중립적인 필드명으로 남긴다.",
    ),
    preset(
      "front-inner-space-sentence",
      "여백과 한 문장",
      "넓은 여백 속 한 문장에 집중하는 내지",
      ["미니멀", "문장", "여백"],
      "text",
      ["#f2efe8", "#2b2a27"],
      "넓은 단색 여백과 작은 한 문장 자리만으로 조용한 내지를 만든다. 문장은 사용자가 직접 제공한 경우에만 정확히 사용하고 인용문이나 감상을 새로 쓰지 않는다. 문장이 없다면 작은 기준선이나 빈 텍스트 자리만 남겨 직접 입력할 수 있게 한다.",
    ),
  ],
  back: [
    preset(
      "back-orderly-tracklist",
      "정돈된 트랙리스트",
      "곡 순서를 가장 또렷하게 읽게 하는 정석 뒷표지",
      ["트랙리스트", "그리드", "가독성"],
      "list",
      ["#171717", "#e8e4da"],
      "곡 번호와 제목을 일정한 기준선에 맞추고 충분한 행간을 둔 단일 트랙리스트를 중심에 배치한다. 실제 제공된 모든 곡을 순서대로 빠짐없이 싣고 임의로 축약하거나 곡을 추가하지 않는다. 작은 제목과 아티스트 정보는 목록과 분리해 명확한 위계를 만든다.",
    ),
    preset(
      "back-photo-side-list",
      "사진 옆 곡 목록",
      "사진과 읽기 쉬운 곡 목록을 나란히 둔 뒷표지",
      ["사진", "트랙리스트", "분할"],
      "split",
      ["#27333a", "#d8ccb6"],
      "이미지 영역과 트랙리스트 영역을 비대칭으로 나누고 목록 쪽에는 단단한 대비를 확보한다. 현재 연결된 참고 이미지가 있으면 사진 영역에만 사용하며, 없으면 실제 사진 기록이라고 주장하지 않는 사진적 색면을 사용한다. 실제 제공된 모든 곡은 순서대로 전부 표기한다.",
    ),
    preset(
      "back-show-log",
      "공연 기록표",
      "셋리스트와 공연 메모 칸을 표처럼 정리한 뒷표지",
      ["공연", "기록표", "셋리스트"],
      "list",
      ["#203b35", "#d9d1b8"],
      "실제 트랙을 순서대로 담은 기록표를 만들고 곡 번호와 제목 열을 가장 넓게 둔다. 날짜, 장소, 연주자, 녹음 메모는 사용자가 제공하지 않았다면 채우지 말고 빈 필드로 남긴다. 표는 오래된 공연 문서의 분위기를 내되 실재 문서라고 오해할 도장이나 서명은 만들지 않는다.",
    ),
    preset(
      "back-small-type-on-photo",
      "사진 위 작은 글자",
      "사진의 분위기를 살리며 작은 곡 목록을 겹친 뒷표지",
      ["사진", "작은글자", "트랙리스트"],
      "photo",
      ["#15191c", "#e7ddd0"],
      "사진적 배경을 넓게 쓰고 한쪽의 조용한 영역에 작은 트랙리스트를 얹는다. 목록 뒤에는 미세한 명암막을 두어 모든 곡 제목이 읽히게 하며, 실제 제공된 모든 곡을 순서대로 유지한다. 참고 이미지가 없으면 특정 공연 사진인 것처럼 표현하지 않는다.",
    ),
    preset(
      "back-vintage-record",
      "빈티지 음반 뒷면",
      "오래된 LP 재킷의 인쇄 위계를 재해석한 뒷표지",
      ["빈티지", "음반", "트랙리스트"],
      "list",
      ["#5d3b2e", "#ddc79f"],
      "바랜 잉크, 작은 장식선, 고전적인 조판으로 오래된 음반 뒷면의 분위기를 만든다. 실제 트랙 전부를 순서대로 읽기 쉽게 싣는다. 카탈로그 번호, 레이블 로고, 바코드, 제작사와 저작권 문구는 사용자가 제공하지 않았다면 만들지 않는다.",
    ),
  ],
  "back-inner": [
    preset(
      "back-inner-hidden-full-photo",
      "숨겨진 전체 사진",
      "트레이 아래에서 온전히 드러나는 한 장의 이미지",
      ["전체사진", "숨은이미지", "트레이"],
      "photo",
      ["#1b2428", "#c6b89e"],
      "중앙의 트레이 아래 137mm 영역에 주 장면과 중요한 디테일을 모으고, 양쪽 접힘에는 자연스럽게 이어지는 배경만 둔다. 연결된 참고 이미지가 있으면 한 장을 크게 사용한다. 참고가 없으면 특정 사람이나 실제 공연의 사진이라고 단정하지 않는 사진적 장면으로 만든다.",
    ),
    preset(
      "back-inner-cover-continuation",
      "표지의 연장선",
      "앞표지의 색과 형태가 안쪽으로 이어지는 구성",
      ["연결", "색상", "연속"],
      "texture",
      ["#2e3440", "#d0b98a"],
      "선택한 팔레트와 프리셋의 시각 언어를 바탕으로 표지에서 이어지는 듯한 색면과 선의 흐름을 만든다. 업로드 원본이나 기존 앞표지 결과물을 자동으로 가져오거나 복제하지 않는다. 중앙 137mm에 중심 리듬을 두고 양쪽 6.5mm 접힘까지 배경만 자연스럽게 연장한다.",
    ),
    preset(
      "back-inner-photo-archive",
      "사진 아카이브",
      "작은 사진과 캡션 자리를 보관함처럼 배열한 안쪽면",
      ["아카이브", "사진", "그리드"],
      "collage",
      ["#30312f", "#d4c9b5"],
      "현재 연결된 참고 이미지들을 작은 인화 사진처럼 규칙적인 그리드에 배치한다. 이미지 이름은 제공된 정확한 이름으로만 식별하며, 날짜, 장소, 사람 이름과 캡션은 새로 만들지 않는다. 참고가 없으면 실재 사진 대신 빈 프레임과 추상적인 사진 질감으로 아카이브의 구조만 표현한다.",
    ),
    preset(
      "back-inner-venue-view",
      "공연장 풍경",
      "무대와 객석의 넓은 공간감을 담은 안쪽면",
      ["공연장", "풍경", "와이드"],
      "photo",
      ["#18212c", "#be9a72"],
      "무대와 객석을 멀리서 바라본 듯한 넓은 원근과 잔잔한 조명을 사용한다. 실제 장소명, 날짜, 관객이나 연주자의 정체를 만들어 내지 않는다. 참고 이미지가 없다면 특정 공연의 기록이 아니라 공연장을 연상시키는 사진적 공간으로만 표현한다.",
    ),
    preset(
      "back-inner-texture",
      "질감 중심",
      "종이와 잉크의 촉감만으로 채우는 절제된 안쪽면",
      ["질감", "추상", "미니멀"],
      "texture",
      ["#4b463f", "#c7b89f"],
      "섬유가 보이는 종이, 번진 잉크, 옅은 긁힘 같은 평면 질감을 겹쳐 깊이를 만든다. 읽을 수 없는 가짜 문서나 개인 메모를 질감으로 삽입하지 않는다. 중앙 137mm와 양쪽 접힘의 색조가 인쇄 후 하나의 연속된 면으로 보이게 한다.",
    ),
  ],
  "back-spine": [
    preset(
      "back-spine-standard-record",
      "표준 음반형",
      "제목과 아티스트를 또렷하게 읽는 정석 스파인",
      ["스파인", "표준", "가독성"],
      "spine",
      ["#151515", "#eee8dc"],
      "좁고 긴 한 줄 축을 따라 제목과 아티스트를 높은 대비로 정렬한다. 위아래 끝에는 인쇄 안전 여백을 충분히 남기고 작은 장식은 한 개만 사용한다. 한 개의 완성된 스트립이 양쪽 스파인에 동일하게 재사용되어도 자연스럽게 보이게 한다.",
    ),
    preset(
      "back-spine-cover-color",
      "표지 색상 연결형",
      "표지 계열의 두 색을 길게 이어 주는 스파인",
      ["스파인", "색상", "연결"],
      "spine",
      ["#334155", "#d6c2a1"],
      "선택한 두 팔레트 색이 세로 방향으로 부드럽게 이어지는 좁은 띠를 만든다. 기존 표지 이미지나 배치 설정을 자동으로 가져오지 말고 이 프리셋 자체의 색과 형태만 사용한다. 제공된 글자는 대비가 확보된 한 방향으로 단정하게 둔다.",
    ),
    preset(
      "back-spine-minimal",
      "미니멀형",
      "아주 적은 글자와 넓은 숨을 둔 스파인",
      ["스파인", "미니멀", "단색"],
      "spine",
      ["#f0ede5", "#272522"],
      "단색 바탕에 제목과 아티스트만 작고 선명하게 두고 나머지는 비운다. 글자가 6.5mm 폭 안에서 잘리지 않도록 좌우 안전 여백을 우선한다. 불필요한 번호, 심벌, 장식 문구를 추가하지 않는다.",
    ),
    preset(
      "back-spine-archive",
      "아카이브형",
      "보관 라벨의 질서를 빌린 세로 스파인",
      ["스파인", "아카이브", "라벨"],
      "spine",
      ["#36423b", "#d8cfb8"],
      "도서관 보관 라벨처럼 작은 구획과 기준선을 사용하되 실제 기관 표식처럼 보이지 않게 한다. 제목과 아티스트 외의 카탈로그 번호, 날짜, 장소, 소장 메모는 사용자가 제공하지 않았다면 넣지 않는다. 동일 스트립을 양쪽에 반복해도 방향과 정보가 일관되게 한다.",
    ),
    preset(
      "back-spine-logo-centered",
      "로고 중심형",
      "명시적으로 제공된 심벌을 중심에 둔 스파인",
      ["스파인", "로고", "중앙"],
      "spine",
      ["#1f2937", "#d9b66f"],
      "현재 참고 이미지 이름으로 명시된 로고나 심벌이 있을 때만 중앙의 작은 표식으로 사용한다. 로고가 제공되지 않았다면 새 로고를 만들지 말고 정확한 앨범 제목을 일반 타이포그래피로 중앙에 둔다. 위아래에는 아티스트를 작게 반복할 수 있지만 카탈로그 번호는 만들지 않는다.",
    ),
  ],
  label: [
    preset(
      "label-classic-record",
      "클래식 음반형",
      "중앙 홀을 감싸는 전통적인 음반 라벨 구성",
      ["라벨", "클래식", "타이포"],
      "disc",
      ["#7b2d26", "#e2c68c"],
      "중앙 홀 둘레에 원형 기준을 두고 제목과 아티스트를 위아래 호 형태로 균형 있게 배치한다. 작은 장식선은 중앙 홀과 바깥 가장자리의 안전 여백을 침범하지 않는다. 제공되지 않은 레이블명, 카탈로그 번호와 저작권 문구는 만들지 않는다.",
    ),
    preset(
      "label-photo",
      "사진 라벨형",
      "사진을 원형 면에 과감하게 자른 CD 라벨",
      ["라벨", "사진", "원형"],
      "disc",
      ["#182229", "#d6c4aa"],
      "현재 연결된 참고 이미지가 있으면 중심 홀에 중요한 피사체가 걸리지 않도록 원형 크롭한다. 참고가 없으면 실제 인물이나 공연 사진이라고 주장하지 않는 사진적 장면을 사용한다. 제목과 아티스트는 중앙 홀에서 떨어진 읽기 좋은 호나 짧은 직선으로 배치한다.",
    ),
    preset(
      "label-monochrome-minimal",
      "단색 미니멀형",
      "한 가지 바탕색과 작은 글자만 쓰는 라벨",
      ["라벨", "단색", "미니멀"],
      "disc",
      ["#202020", "#ece9e1"],
      "한 가지 바탕색을 원형 전체에 쓰고 제목과 아티스트를 한두 줄로만 배치한다. 중앙 홀과 바깥 가장자리 주변은 넓게 비워 인쇄 오차에도 글자가 잘리지 않게 한다. 가짜 제조 정보나 장식용 미세 문자를 추가하지 않는다.",
    ),
    preset(
      "label-handwritten-bootleg",
      "직접 기록한 부틀렉형",
      "CD에 직접 적어 둔 듯한 친밀한 기록형 라벨",
      ["라벨", "부틀렉", "손글씨"],
      "disc",
      ["#e7e2d7", "#2f4f5f"],
      "무광 CD 표면에 펜으로 제목과 아티스트를 직접 적은 듯한 필기감과 작은 밑줄을 사용한다. 날짜, 장소, 사람 이름, 개인 메모는 사용자가 제공하지 않았다면 지어내지 않는다. 손글씨 효과를 쓰더라도 제공된 글자의 철자는 정확하고 읽을 수 있어야 한다.",
    ),
    preset(
      "label-concentric-type",
      "동심원 타이포형",
      "중앙 홀을 따라 글자가 회전하는 그래픽 라벨",
      ["라벨", "동심원", "타이포"],
      "disc",
      ["#17324d", "#d8a84e"],
      "중앙 홀을 기준으로 두세 겹의 동심원 타이포그래피를 구성하고 제목과 아티스트의 정확한 글자를 반복해 리듬을 만든다. 글자의 위아래 방향은 일관되게 유지하고 중앙 홀 안전 영역에는 아무 정보도 두지 않는다. 의미 없는 가짜 문장을 채움 요소로 만들지 않는다.",
    ),
  ],
};

const PART_GEOMETRY: Record<StudioArtworkPart, string> = {
  front: "앞표지 한 면을 정확히 120×120mm 정사각형으로 제작한다.",
  "front-inner": "앞표지 내부 한 면을 정확히 120×120mm 정사각형으로 제작한다.",
  back: "스파인을 포함하지 않는 중앙 뒷표지 한 면만 정확히 137×118mm로 제작한다. 150mm 풀폭 트레이카드나 좌우 6.5mm 스파인을 이 이미지 안에 합치지 않는다.",
  "back-inner": "뒷표지 내부 전체를 정확히 150×118mm로 제작한다. 중앙 137×118mm는 트레이 아래에서 보이는 핵심 영역이고, 양쪽 각 6.5mm는 접힘 영역이므로 중요한 글자와 피사체는 중앙에 둔다.",
  "back-spine": "정확히 6.5×118mm인 스파인 스트립 하나만 제작한다. 이 한 스트립을 좌우 스파인에 동일하게 재사용하므로 왼쪽용과 오른쪽용을 따로 나누거나 두 개 만들지 않는다.",
  label: "외경 Ø116mm, 중앙 내경 Ø23mm인 CD 라벨 한 면을 제작한다. 중앙 홀과 바깥 가장자리 가까이에는 중요한 글자나 피사체를 두지 않는다.",
};

const PART_NAMES: Record<StudioArtworkPart, string> = {
  front: "앞표지",
  "front-inner": "앞표지 내부",
  back: "뒷표지 중앙",
  "back-inner": "뒷표지 내부",
  "back-spine": "뒷표지 스파인",
  label: "CD 라벨",
};

function isStudioArtworkPart(value: string): value is StudioArtworkPart {
  return Object.prototype.hasOwnProperty.call(DESIGN_PRESETS, value);
}

function metadataBlock(part: StudioArtworkPart, context: PresetPromptContext): string {
  if (context.includeMetadata !== true) {
    return [
      "[사용자 원문 우선]",
      "이 프리셋은 스타일과 구성만 제안한다. 기존 사용자 프롬프트, 사용자가 지정한 모든 글자와 사용자 지정 셋리스트가 항상 우선하며, 이를 바꾸거나 다시 쓰거나 보충하지 않는다.",
      "위 구성 지시에 나오는 제목, 아티스트, 트랙리스트 언급은 배치 예시일 뿐이며 새 글자를 추가하라는 지시가 아니다.",
      "프로젝트 제목, 아티스트와 트랙 메타데이터는 이 프롬프트에 포함하지 않았다.",
    ].join("\n");
  }

  const lines = [
    "[프로젝트에서 제공된 정확한 글자]",
    `앨범 제목: “${context.title}”`,
    `아티스트: “${context.artist}”`,
    "위 글자는 철자를 바꾸거나 번역하거나 다른 이름으로 보충하지 않는다.",
  ];

  if (part === "back") {
    const sortedTracks = context.tracks
      .map((track, index) => ({ track, index }))
      .sort((left, right) => left.track.order - right.track.order || left.index - right.index);

    lines.push("[실제 트랙리스트 — 아래 항목 전체를 이 순서대로 사용]");
    if (sortedTracks.length === 0) {
      lines.push("실제 트랙이 아직 없다. 곡명이나 순서를 만들지 말고 사용자가 나중에 직접 입력할 수 있는 빈 트랙리스트 영역을 둔다.");
    } else {
      for (const { track } of sortedTracks) {
        lines.push(`${String(track.order).padStart(2, "0")}. “${track.title}”`);
      }
    }
  }

  return lines.join("\n");
}

function referenceBlock(referenceNames: readonly string[] | undefined): string {
  if (!referenceNames || referenceNames.length === 0) {
    return [
      "[현재 참고 이미지]",
      "현재 이 요청에 연결된 참고 이미지는 없다. 사진적 스타일은 사용할 수 있지만 실제 사진, 특정 인물, 특정 공연 또는 실재 기록물을 보고 재현한 것처럼 주장하지 않는다.",
      "라이브러리에 있을 수 있는 업로드 원본, 다른 참고 자산이나 기존 프레젠테이션 설정을 자동으로 적용하지 않는다.",
    ].join("\n");
  }

  return [
    "[현재 참고 이미지 — 아래 이름만 정확히 사용]",
    ...referenceNames.map((name) => `- [${name}]`),
    "참고 이미지를 지칭할 때는 위 대괄호 안 이름을 정확히 사용한다. 기존 사용자 프롬프트가 각 이름에 지정한 역할과 해석이 있으면 그것을 우선하며 새 역할을 덧씌우지 않는다. 목록 밖의 업로드 원본, 다른 참고 자산이나 기존 프레젠테이션 설정은 자동으로 적용하지 않는다.",
  ].join("\n");
}

export function buildPresetPrompt(
  part: StudioArtworkPart,
  presetId: string,
  context: PresetPromptContext,
): string {
  if (!isStudioArtworkPart(part)) {
    throw new Error(`알 수 없는 디자인 영역: ${String(part)}`);
  }

  const selected = DESIGN_PRESETS[part].find((item) => item.id === presetId);
  if (!selected) {
    throw new Error(`알 수 없는 ${PART_NAMES[part]} 프리셋: ${presetId}`);
  }

  return [
    `[CDstudio ${PART_NAMES[part]} 디자인 프리셋]`,
    `프리셋: ${selected.title}`,
    `의도: ${selected.description}`,
    `팔레트: ${selected.palette[0]}, ${selected.palette[1]}`,
    "",
    "[구성 지시]",
    selected.instructions,
    "",
    "[인쇄 규격]",
    PART_GEOMETRY[part],
    "원근이 있는 목업, 주얼 케이스 합성, 기울어진 원반, 손이나 배경이 함께 나온 제품 사진이 아니라 정면의 평면 인쇄 아트워크만 만든다. 재단선, 접기선, 치수선, 템플릿 안내선은 결과 이미지에 그리지 않는다.",
    "",
    metadataBlock(part, context),
    "",
    referenceBlock(context.referenceNames),
    "",
    "[사실성 원칙]",
    "사용자가 명시적으로 제공하지 않은 공연 날짜, 장소, 사람, 개인 메모, 로고, 카탈로그 번호와 바코드는 만들지 않는다. 사용자가 제공한 정확한 글자는 사용할 수 있으며, 글자 자체를 보편적으로 금지하지 않는다.",
  ].join("\n");
}

export function applyPresetPrompt(
  current: string,
  generated: string,
  mode: "replace" | "append",
): string {
  if (mode === "replace") return generated;
  if (mode !== "append") throw new Error(`알 수 없는 프롬프트 적용 방식: ${String(mode)}`);
  if (current.length === 0) return generated;
  if (generated.length === 0) return current;
  return `${current}\n\n${generated}`;
}
