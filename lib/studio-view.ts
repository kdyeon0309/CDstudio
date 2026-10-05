import type {
  AlbumProject,
  ArtworkPart,
  StudioArtworkPart,
  StudioCandidate,
  StudioPart,
  StudioPresentation,
} from "@/lib/types";
import { ARTWORK_PARTS, PRINT_SPECS } from "@/lib/types";

export const DEFAULT_PRESENTATION: StudioPresentation = {
  fit: "cover",
  transform: { offsetXMm: 0, offsetYMm: 0, scale: 1 },
  overlay: { enabled: false, color: "#ffffff", position: "bottom", fontSizeMm: 6 },
};

export function studioPart(project: AlbumProject, part: StudioArtworkPart): StudioPart {
  return project.studio?.parts[part] ?? {
    prompt: "",
    referenceFiles: [],
    candidates: [],
    presentation: DEFAULT_PRESENTATION,
  };
}

export function selectedStudioCandidate(
  project: AlbumProject,
  part: StudioArtworkPart,
): StudioCandidate | undefined {
  const state = studioPart(project, part);
  return state.candidates.find((candidate) => candidate.id === state.selectedCandidateId);
}

export function selectedStudioParts(project: AlbumProject): ArtworkPart[] {
  return ARTWORK_PARTS.filter((part) => Boolean(selectedStudioCandidate(project, part)));
}

export function studioPrintEnabled(project: AlbumProject): boolean {
  return project.studio?.printSource === "studio";
}

/** 스파인은 뒷표지 중앙과 같은 트레이카드에만 인쇄할 수 있다. */
export function studioSpineNeedsBack(project: AlbumProject): boolean {
  return studioPrintEnabled(project)
    && Boolean(selectedStudioCandidate(project, "back-spine"))
    && !selectedStudioCandidate(project, "back");
}

export type PrintPpiGrade = "target" | "below-target" | "low";

export interface StudioPrintResolution {
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
  scale: number;
  ppi: number;
  grade: PrintPpiGrade;
  fullBleed: boolean;
}

/** Warn about older full-width tray-card images before fitting them into the 137 mm center. */
export function studioBackMayCropLegacyCandidate(
  candidate: Pick<StudioCandidate, "width" | "height">,
  presentation: Pick<StudioPresentation, "fit">,
): boolean {
  if (presentation.fit !== "cover" || candidate.width <= 0 || candidate.height <= 0) return false;
  const centerAspect = (PRINT_SPECS.back.widthMm - 2 * PRINT_SPECS.back.spineMm) / PRINT_SPECS.back.heightMm;
  return candidate.width / candidate.height > centerAspect * 1.03;
}

/**
 * Printed pixels per inch after CSS object-fit and the user's scale. `contain`
 * also paints an unscaled blurred cover background at 110% of the panel size;
 * report the lower density of that background and the scaled contain foreground.
 */
export function studioPrintResolution(
  candidate: Pick<StudioCandidate, "width" | "height">,
  part: StudioArtworkPart,
  presentation: Pick<StudioPresentation, "fit" | "transform">,
  separateSpine = false,
): StudioPrintResolution {
  // Kept for callers loading older project/UI code; back geometry is now always central-only.
  void separateSpine;
  const dimensions = part === "label"
    ? { widthMm: PRINT_SPECS.label.outerDiameterMm, heightMm: PRINT_SPECS.label.outerDiameterMm }
    : part === "back-spine"
      ? { widthMm: PRINT_SPECS.back.spineMm, heightMm: PRINT_SPECS.back.heightMm }
      : part === "back"
        ? { widthMm: PRINT_SPECS.back.widthMm - 2 * PRINT_SPECS.back.spineMm, heightMm: PRINT_SPECS.back.heightMm }
        : { widthMm: PRINT_SPECS[part].widthMm, heightMm: PRINT_SPECS[part].heightMm };
  const { scale, offsetXMm, offsetYMm } = presentation.transform;
  const validWidth = typeof candidate.width === "number" && Number.isInteger(candidate.width)
    && candidate.width > 0 && candidate.width <= 8192;
  const validHeight = typeof candidate.height === "number" && Number.isInteger(candidate.height)
    && candidate.height > 0 && candidate.height <= 8192;
  const validScale = typeof scale === "number" && Number.isFinite(scale) && scale > 0;
  const validOffsets = typeof offsetXMm === "number" && Number.isFinite(offsetXMm)
    && typeof offsetYMm === "number" && Number.isFinite(offsetYMm);
  const valid = validWidth && validHeight && candidate.width * candidate.height <= 64 * 1024 * 1024
    && validScale && validOffsets;
  const safeScale = validScale ? scale : 1;
  const widthDensity = validWidth ? candidate.width / dimensions.widthMm : 0;
  const heightDensity = validHeight ? candidate.height / dimensions.heightMm : 0;
  const coverDensity = Math.min(widthDensity, heightDensity);
  // ArtworkSheetPreview.module.css .blurFill uses width/height 110%.
  const containBackgroundDensity = coverDensity / 1.1;
  const foregroundDensity = presentation.fit === "contain"
    ? Math.max(widthDensity, heightDensity) / safeScale
    : coverDensity / Math.max(safeScale, 1);
  const effectiveDensity = presentation.fit === "contain"
    ? Math.min(containBackgroundDensity, foregroundDensity)
    : foregroundDensity;
  const measuredPpi = valid
    ? Math.floor(effectiveDensity * 25.4)
    : 0;
  const ppi = Number.isFinite(measuredPpi) && measuredPpi > 0 ? measuredPpi : 0;
  // CSS `translate(xmm, ymm) scale(s)` scales around center, then translates.
  // At scale 1 there is no spare image area for any offset; below 1 a cover
  // image cannot cover the full panel. `contain` has a separate blurred fill.
  const fullBleed = valid && ppi > 0 && (presentation.fit === "contain" || (
    scale >= 1 && Math.abs(offsetXMm) <= (scale - 1) * dimensions.widthMm / 2 + 1e-9
    && Math.abs(offsetYMm) <= (scale - 1) * dimensions.heightMm / 2 + 1e-9
  ));
  return {
    widthPx: validWidth ? candidate.width : 0,
    heightPx: validHeight ? candidate.height : 0,
    ...dimensions,
    scale,
    ppi,
    grade: ppi >= 300 ? "target" : ppi >= 200 ? "below-target" : "low",
    fullBleed,
  };
}
