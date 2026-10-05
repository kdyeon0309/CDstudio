import type {
  AlbumProject,
  ArtworkPart,
  PartTransform,
  PhotoFit,
  StudioArtworkPart,
  StudioPresentation,
} from "@/lib/types";

export const JEWEL_GEOMETRY = {
  case: { widthMm: 142, heightMm: 125, depthMm: 10.4 },
  front: { widthMm: 120, heightMm: 120 },
  tray: { widthMm: 150, centerWidthMm: 137, heightMm: 118, spineMm: 6.5 },
  disc: { outerDiameterMm: 120, innerDiameterMm: 15, thicknessMm: 1.2 },
  printableLabel: { outerDiameterMm: 116, innerDiameterMm: 23 },
} as const;

export const IDENTITY_TRANSFORM: PartTransform = {
  offsetXMm: 0,
  offsetYMm: 0,
  scale: 1,
};

export type PreviewArtworkSource =
  | {
      kind: "image";
      part: StudioArtworkPart;
      url: string;
      fit: PhotoFit;
      transform: PartTransform;
      overlay: StudioPresentation["overlay"];
      widthMm: number;
      heightMm: number;
    }
  | {
      kind: "html";
      part: ArtworkPart;
      url: string;
      fit: "cover";
      transform: PartTransform;
      widthMm: number;
      heightMm: number;
    }
  | { kind: "placeholder"; part: StudioArtworkPart; widthMm: number; heightMm: number };

export interface PreviewArtworkSet {
  source: "studio" | "legacy";
  front: PreviewArtworkSource;
  frontInner: PreviewArtworkSource;
  label: PreviewArtworkSource;
  back: PreviewArtworkSource;
  backInner: PreviewArtworkSource;
  backSpine: PreviewArtworkSource;
  splitBack: boolean;
}

/** WebGL can reproduce bitmap and empty faces, but must not replace legacy HTML artwork. */
export function canRenderJewelWebgl(artwork: PreviewArtworkSet) {
  return [artwork.front, artwork.frontInner, artwork.label, artwork.back, artwork.backInner, artwork.backSpine]
    .every((source) => source.kind !== "html");
}

function fileUrl(projectId: string, type: "asset" | "artwork", filename: string) {
  if (type === "asset") {
    return `/api/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(filename)}`;
  }
  const params = new URLSearchParams({ type, name: filename });
  return `/api/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`;
}

function dimensions(part: StudioArtworkPart, studio: boolean) {
  if (part === "label") return { widthMm: 116, heightMm: 116 };
  if (part === "back-spine") return { widthMm: 6.5, heightMm: 118 };
  if (part === "back" && studio) return { widthMm: 137, heightMm: 118 };
  if (part === "back" || part === "back-inner") return { widthMm: 150, heightMm: 118 };
  return { widthMm: 120, heightMm: 120 };
}

function studioSource(project: AlbumProject, part: StudioArtworkPart): PreviewArtworkSource {
  const size = dimensions(part, true);
  const state = project.studio?.parts[part];
  const candidate = state?.candidates.find((item) => item.id === state.selectedCandidateId);
  if (!state || !candidate) return { kind: "placeholder", part, ...size };
  return {
    kind: "image",
    part,
    url: fileUrl(project.id, "asset", candidate.filename),
    fit: state.presentation.fit,
    transform: state.presentation.transform,
    overlay: state.presentation.overlay,
    ...size,
  };
}

function legacySource(project: AlbumProject, part: ArtworkPart): PreviewArtworkSource {
  const size = dimensions(part, false);
  const selected = project.artwork.selected;
  const variant = project.artwork.variants.find((item) => item.index === selected) ?? project.artwork.variants[0];
  const filename = variant?.files[part];
  if (!filename) return { kind: "placeholder", part, ...size };
  return {
    kind: "html",
    part,
    url: fileUrl(project.id, "artwork", filename),
    fit: "cover",
    transform: project.artwork.partTransforms?.[part] ?? IDENTITY_TRANSFORM,
    ...size,
  };
}

/** Derive the read-only artwork shown by the mockup from the active print source. */
export function deriveJewelArtwork(project: AlbumProject): PreviewArtworkSet {
  if (project.studio?.printSource === "studio") {
    const spine = studioSource(project, "back-spine");
    return {
      source: "studio",
      front: studioSource(project, "front"),
      frontInner: studioSource(project, "front-inner"),
      label: studioSource(project, "label"),
      back: studioSource(project, "back"),
      backInner: studioSource(project, "back-inner"),
      backSpine: spine,
      splitBack: true,
    };
  }
  return {
    source: "legacy",
    front: legacySource(project, "front"),
    frontInner: legacySource(project, "front-inner"),
    label: legacySource(project, "label"),
    back: legacySource(project, "back"),
    backInner: legacySource(project, "back-inner"),
    backSpine: { kind: "placeholder", part: "back-spine", ...dimensions("back-spine", false) },
    splitBack: false,
  };
}
