/** 한 번의 추출 요청에서 처리할 수 있는 최대 곡 수. */
export const MAX_EXTRACT_ITEMS = 50;

/** 조회 결과에서 처음 기본 선택할 항목을 추출 상한까지만 고른다. */
export function initialExtractSelection(itemCount: number): boolean[] {
  const safeCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  return Array.from({ length: safeCount }, (_, index) => index < MAX_EXTRACT_ITEMS);
}
