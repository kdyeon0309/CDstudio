"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AlbumProject, ArtworkPart, ArtworkVariant } from "@/lib/types";
import { PRINT_SPECS } from "@/lib/types";
import styles from "./print.module.css";

function artworkUrl(projectId: string, filename: string) {
  const params = new URLSearchParams({ type: "artwork", name: filename });
  return `/api/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`;
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

function ArtworkFrame({
  projectId,
  variant,
  part,
  title,
}: {
  projectId: string;
  variant: ArtworkVariant;
  part: ArtworkPart;
  title: string;
}) {
  return (
    <iframe
      className={styles.artworkFrame}
      src={artworkUrl(projectId, variant.files[part])}
      title={title}
      loading="lazy"
      sandbox=""
    />
  );
}

export default function PrintClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("프로젝트를 불러오지 못했습니다.");
        return (await response.json()) as AlbumProject;
      })
      .then((data) => {
        if (active) setProject(data);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "프로젝트를 불러오지 못했습니다.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [projectId]);

  const selectedVariant = useMemo(() => {
    if (!project?.artwork.variants.length) return null;
    return (
      project.artwork.variants.find(
        (variant) => variant.index === project.artwork.selected,
      ) ?? project.artwork.variants[0]
    );
  }, [project]);

  if (loading) {
    return <p className="py-16 text-center text-sm text-fg-muted">앨범을 불러오는 중…</p>;
  }

  if (error || !project) {
    return (
      <section className="rounded-2xl border border-rose/40 bg-rose/10 p-6 text-rose">
        {error || "프로젝트가 없습니다."}
      </section>
    );
  }

  if (!selectedVariant) {
    return (
      <section className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center shadow-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-amber">
          5단계 · 실치수 인쇄
        </p>
        <h2 className="mt-3 text-xl font-semibold text-fg">
          먼저 디자인 단계에서 아트워크를 생성·선택하세요
        </h2>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          앞커버, 뒷커버, CD 라벨이 준비되면 실물 크기로 미리 보고 인쇄할 수 있습니다.
        </p>
        <Link
          href={`/album/${encodeURIComponent(projectId)}/design`}
          className="mt-6 inline-flex rounded-lg bg-violet-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-600"
        >
          디자인 단계로 이동
        </Link>
      </section>
    );
  }

  const frontStyle = {
    width: `${PRINT_SPECS.front.widthMm}mm`,
    height: `${PRINT_SPECS.front.heightMm}mm`,
  };
  const backStyle = {
    width: `${PRINT_SPECS.back.widthMm}mm`,
    height: `${PRINT_SPECS.back.heightMm}mm`,
    "--spine-width": `${PRINT_SPECS.back.spineMm}mm`,
  } as React.CSSProperties;
  const labelStyle = {
    width: `${PRINT_SPECS.label.outerDiameterMm}mm`,
    height: `${PRINT_SPECS.label.outerDiameterMm}mm`,
    "--label-hole": `${PRINT_SPECS.label.innerDiameterMm}mm`,
  } as React.CSSProperties;

  return (
    <div className={styles.printRoot}>
      <header className={`${styles.screenOnly} mb-8 flex flex-wrap items-end justify-between gap-5`}>
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-violet-400">
            5단계 · 실치수 인쇄
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-fg">인쇄 미리보기</h2>
          <p className="mt-1 text-sm text-fg-muted">
            {selectedVariant.index}안 · {selectedVariant.name} — A4, 배율 100%로 인쇄하세요.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-xl bg-violet-700 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-violet-950/30 transition hover:bg-violet-600"
        >
          인쇄 (PDF 저장)
        </button>
      </header>

      <div className={styles.preview}>
        <section className={styles.sheet} aria-label="앞커버 인쇄 페이지">
          <div className={styles.part} style={frontStyle}>
            <CropMarks />
            <ArtworkFrame
              projectId={projectId}
              variant={selectedVariant}
              part="front"
              title={`${project.title} 앞커버`}
            />
          </div>
        </section>

        <section className={styles.sheet} aria-label="뒷커버 인쇄 페이지">
          <div className={styles.part} style={backStyle}>
            <CropMarks />
            <ArtworkFrame
              projectId={projectId}
              variant={selectedVariant}
              part="back"
              title={`${project.title} 뒷커버`}
            />
            <span className={`${styles.foldLine} ${styles.foldLeft}`} aria-hidden="true" />
            <span className={`${styles.foldLine} ${styles.foldRight}`} aria-hidden="true" />
          </div>
        </section>

        <section className={styles.sheet} aria-label="CD 라벨 인쇄 페이지">
          <div className={`${styles.part} ${styles.label}`} style={labelStyle}>
            <CropMarks />
            <div className={styles.labelArtwork}>
              <ArtworkFrame
                projectId={projectId}
                variant={selectedVariant}
                part="label"
                title={`${project.title} CD 라벨`}
              />
            </div>
            <span className={styles.labelHole} aria-hidden="true" />
          </div>
        </section>
      </div>
    </div>
  );
}
