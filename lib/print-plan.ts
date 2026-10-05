import type { ArtworkPart } from "./types";

export type PrintTarget = "all" | "front-fold" | "back-fold" | "remaining";

/** 접지 시트의 물리적 좌→우 순서. */
const FRONT_FOLD_PARTS: readonly ArtworkPart[] = ["front-inner", "front"];
const BACK_FOLD_PARTS: readonly ArtworkPart[] = ["back", "back-inner"];

export function canFrontFold(parts: readonly ArtworkPart[]): boolean {
  return FRONT_FOLD_PARTS.every((part) => parts.includes(part));
}

export function canBackFold(parts: readonly ArtworkPart[]): boolean {
  return BACK_FOLD_PARTS.every((part) => parts.includes(part));
}

/** 인쇄 대상만 새 배열로 반환하며 입력 순서와 배열 자체는 변경하지 않는다. */
export function printPartsForTarget(
  parts: readonly ArtworkPart[],
  target: PrintTarget,
): ArtworkPart[] {
  if (target === "front-fold") {
    return canFrontFold(parts) ? [...FRONT_FOLD_PARTS] : [];
  }
  if (target === "back-fold") {
    return canBackFold(parts) ? [...BACK_FOLD_PARTS] : [];
  }
  if (target === "remaining") {
    return parts.filter((part) => !FRONT_FOLD_PARTS.includes(part));
  }
  return [...parts];
}
