"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import type {
  AlbumProject,
  StudioArtworkPart,
  StudioCandidate,
  StudioPresentation,
} from "@/lib/types";
import { formatDuration, PRINT_SPECS, STUDIO_PART_LABELS } from "@/lib/types";
import styles from "./ArtworkSheetPreview.module.css";

interface Props {
  project: AlbumProject;
  part: StudioArtworkPart;
  candidate: StudioCandidate;
  presentation: StudioPresentation;
  spineCandidate?: StudioCandidate;
  spinePresentation?: StudioPresentation;
  last?: boolean;
  guides?: boolean;
  screenScale?: number;
  className?: string;
  embedded?: boolean;
  onOverflow?: (overflow: boolean) => void;
}

function assetUrl(projectId: string, filename: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/file?type=asset&name=${encodeURIComponent(filename)}`;
}

function partStyle(part: StudioArtworkPart): CSSProperties {
  if (part === "back-spine") return { width: `${PRINT_SPECS.back.spineMm}mm`, height: `${PRINT_SPECS.back.heightMm}mm` };
  if (part === "label") {
    return {
      width: `${PRINT_SPECS.label.outerDiameterMm}mm`,
      height: `${PRINT_SPECS.label.outerDiameterMm}mm`,
      "--hole-size": `${PRINT_SPECS.label.innerDiameterMm}mm`,
    } as CSSProperties;
  }
  const spec = PRINT_SPECS[part];
  return {
    width: `${spec.widthMm}mm`,
    height: `${spec.heightMm}mm`,
    ...("spineMm" in spec ? { "--spine-size": `${spec.spineMm}mm` } : {}),
  } as CSSProperties;
}

function CropMarks() {
  return (
    <span className={styles.cropMarks} aria-hidden="true">
      <i className={styles.cropTopLeft} />
      <i className={styles.cropTopRight} />
      <i className={styles.cropBottomLeft} />
      <i className={styles.cropBottomRight} />
    </span>
  );
}

function TextOverlay({
  project,
  part,
  presentation,
  splitBack,
  contentRef,
  trackRef,
}: {
  project: AlbumProject;
  part: StudioArtworkPart;
  presentation: StudioPresentation;
  splitBack?: boolean;
  contentRef: React.RefObject<HTMLDivElement | null>;
  trackRef: React.RefObject<HTMLOListElement | null>;
}) {
  const { overlay } = presentation;
  if (!overlay.enabled) return null;
  const back = part === "back" || part === "back-inner";
  const label = part === "label";
  const columns = project.tracks.length > 45 ? 3 : 2;
  const trackFontMm = Math.max(
    1.5,
    Math.min(overlay.fontSizeMm * 0.47, 82 / (Math.ceil(project.tracks.length / columns) * 1.25 || 1)),
  );
  const style = {
    color: overlay.color,
    fontSize: `${overlay.fontSizeMm}mm`,
  };
  return (
    <>
      <div
        ref={contentRef}
        className={`${styles.textOverlay} ${overlay.position === "top" ? styles.textTop : styles.textBottom} ${back ? styles.backText : ""} ${splitBack ? styles.splitBackText : ""} ${label ? styles.labelText : ""}`}
        style={style}
      >
        <strong className={styles.albumTitle}>{project.title}</strong>
        <span className={styles.artist}>{project.artist}</span>
        {back && (
          <ol ref={trackRef} className={styles.trackList} style={{ columns, fontSize: `${trackFontMm}mm` }}>
            {project.tracks.map((track) => (
              <li key={track.id}>
                <span>{String(track.order).padStart(2, "0")}</span>
                <span>{track.title}</span>
                <span>{formatDuration(track.durationSec)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function ArtworkImage({ projectId, candidate, presentation }: {
  projectId: string;
  candidate: StudioCandidate;
  presentation: StudioPresentation;
}) {
  const src = assetUrl(projectId, candidate.filename);
  const transform = presentation.transform;
  const imageStyle: CSSProperties = {
    transform: `translate(${transform.offsetXMm}mm, ${transform.offsetYMm}mm) scale(${transform.scale})`,
  };
  return (
    <>
      {presentation.fit === "contain" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.blurFill} src={src} alt="" aria-hidden="true" />
      )}
      <div className={styles.imageTransform} style={imageStyle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={`${styles.artworkImage} ${presentation.fit === "contain" ? styles.contain : styles.cover}`} src={src} alt="" />
      </div>
    </>
  );
}

function SpineText({ project, presentation, left, textRef }: {
  project: AlbumProject;
  presentation: StudioPresentation;
  left: boolean;
  textRef?: React.RefObject<HTMLSpanElement | null>;
}) {
  if (!presentation.overlay.enabled) return null;
  // The left copy is rotated, so its logical text alignment is reversed.
  const logicalStart = left ? presentation.overlay.position === "bottom" : presentation.overlay.position === "top";
  return <span ref={textRef} className={`${styles.splitSpineText} ${left ? styles.splitSpineTextLeft : ""} ${logicalStart ? styles.splitSpineTextStart : styles.splitSpineTextEnd}`} style={{ color: presentation.overlay.color, fontSize: `${presentation.overlay.fontSizeMm}mm` }}>{project.artist} · {project.title}</span>;
}

/** 화면 미리보기와 실제 인쇄가 공유하는 A4 실치수 렌더러. */
export default function ArtworkSheetPreview({
  project,
  part,
  candidate,
  presentation,
  spineCandidate,
  spinePresentation,
  last = false,
  guides = false,
  screenScale,
  className = "",
  embedded = false,
  onOverflow,
}: Props) {
  const clipRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLOListElement>(null);
  const spineTextRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const hasSpineOverlay = (part === "back" && Boolean(spineCandidate) && Boolean(spinePresentation?.overlay.enabled))
      || (part === "back-spine" && presentation.overlay.enabled);
    if (!presentation.overlay.enabled && !hasSpineOverlay) {
      onOverflow?.(false);
      return;
    }
    const report = () => {
      const clip = clipRef.current;
      const content = contentRef.current;
      const list = trackRef.current;
      const spineText = spineTextRef.current;
      let centerOverflow = false;
      if (clip && content) {
        const outer = clip.getBoundingClientRect();
        const inner = content.getBoundingClientRect();
        centerOverflow = inner.top < outer.top - 1 || inner.bottom > outer.bottom + 1 ||
          content.scrollHeight > content.clientHeight + 1 ||
          Boolean(list && (list.scrollHeight > list.clientHeight + 1 || list.scrollWidth > list.clientWidth + 1));
      }
      const spineOverflow = Boolean(spineText &&
        (spineText.scrollHeight > spineText.clientHeight + 1 ||
          spineText.scrollWidth > spineText.clientWidth + 1));
      onOverflow?.(centerOverflow || spineOverflow);
    };
    report();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    if (clipRef.current) observer?.observe(clipRef.current);
    if (contentRef.current) observer?.observe(contentRef.current);
    if (trackRef.current) observer?.observe(trackRef.current);
    if (spineTextRef.current) observer?.observe(spineTextRef.current);
    window.addEventListener("resize", report);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [project.title, project.artist, project.tracks, presentation.overlay, spinePresentation?.overlay, spineCandidate, part, onOverflow]);
  const wrapperStyle: CSSProperties | undefined = screenScale
    ? {
        width: `calc(210mm * ${screenScale})`,
        height: `calc(297mm * ${screenScale})`,
      }
    : undefined;
  const sheetStyle: CSSProperties | undefined = screenScale ? { zoom: screenScale } : undefined;
  const back = part === "back" || part === "back-inner";
  const label = part === "label";
  const splitBack = part === "back";

  const artwork = (
    <div className={`${styles.part} ${label ? styles.label : ""}`} style={partStyle(part)}>
      {!embedded && <CropMarks />}
      {splitBack ? (
        <div className={styles.contentClip}>
          <div className={`${styles.splitRegion} ${styles.splitSpineLeft} ${!spineCandidate || !spinePresentation ? styles.neutralSpine : ""}`}>
            {spineCandidate && spinePresentation && <ArtworkImage projectId={project.id} candidate={spineCandidate} presentation={spinePresentation} />}
            {spineCandidate && spinePresentation && <SpineText project={project} presentation={spinePresentation} left textRef={spineTextRef} />}
          </div>
          <div ref={clipRef} className={`${styles.splitRegion} ${styles.splitCenter}`}>
            <ArtworkImage projectId={project.id} candidate={candidate} presentation={presentation} />
            <TextOverlay project={project} part={part} presentation={presentation} splitBack contentRef={contentRef} trackRef={trackRef} />
          </div>
          <div className={`${styles.splitRegion} ${styles.splitSpineRight} ${!spineCandidate || !spinePresentation ? styles.neutralSpine : ""}`}>
            {spineCandidate && spinePresentation && <ArtworkImage projectId={project.id} candidate={spineCandidate} presentation={spinePresentation} />}
            {spineCandidate && spinePresentation && <SpineText project={project} presentation={spinePresentation} left={false} />}
          </div>
          {guides && <span className={styles.safeArea} aria-hidden="true" />}
        </div>
      ) : (
        <div ref={clipRef} className={`${styles.contentClip} ${label ? styles.label : ""}`}>
          <ArtworkImage projectId={project.id} candidate={candidate} presentation={presentation} />
          {part === "back-spine"
            ? <SpineText project={project} presentation={presentation} left={false} textRef={spineTextRef} />
            : <TextOverlay project={project} part={part} presentation={presentation} contentRef={contentRef} trackRef={trackRef} />}
          {guides && <span className={styles.safeArea} aria-hidden="true" />}
        </div>
      )}
      {back && !embedded && (
        <>
          <span className={`${styles.foldLine} ${styles.foldLeft}`} aria-hidden="true" />
          <span className={`${styles.foldLine} ${styles.foldRight}`} aria-hidden="true" />
        </>
      )}
      {label && <span className={styles.hole} aria-hidden="true" />}
    </div>
  );

  if (embedded) return artwork;

  return (
    <div className={`${styles.wrapper} ${className}`} style={wrapperStyle}>
      <section
        className={`${styles.sheet} ${last ? styles.lastSheet : ""}`}
        style={sheetStyle}
        aria-label={`${STUDIO_PART_LABELS[part]} A4 인쇄 미리보기`}
      >
        <span className={styles.sheetLabel}>{STUDIO_PART_LABELS[part]}{back ? " · 점선은 미리보기용, 인쇄 시 위쪽 표식만 표시" : ""}</span>
        {artwork}
      </section>
    </div>
  );
}
