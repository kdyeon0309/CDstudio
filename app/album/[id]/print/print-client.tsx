"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AlbumProject,
  ArtworkPart,
  ArtworkState,
  ArtworkVariant,
  PartTransform,
} from "@/lib/types";
import { ARTWORK_PARTS, PART_LABELS, PRINT_SPECS } from "@/lib/types";
import styles from "./print.module.css";

/** 미세조정 범위 — lib/types.ts 의 PartTransform 주석 및 서버 PATCH 검증과 동일 */
const OFFSET_MIN_MM = -60;
const OFFSET_MAX_MM = 60;
const SCALE_MIN = 0.5;
const SCALE_MAX = 3;
const SCALE_STEP = 0.05;
/** 이동 단위 (mm) — 큰 단위 / 미세 단위 */
const MOVE_STEPS = [1, 0.2] as const;
const SAVE_DEBOUNCE_MS = 600;

type MoveStep = (typeof MOVE_STEPS)[number];
type PartTransforms = Partial<Record<ArtworkPart, PartTransform>>;
type SaveState = "idle" | "saving" | "saved" | "error";

const IDENTITY: PartTransform = { offsetXMm: 0, offsetYMm: 0, scale: 1 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** 이동값은 0.1mm 격자로 (1mm·0.2mm 단계 누적 시 부동소수 오차 방지) */
function roundMm(value: number) {
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/** 배율은 0.01 격자로 (5% 단계) */
function roundScale(value: number) {
  return Math.round(value * 100) / 100;
}

function isIdentity(t: PartTransform) {
  return t.offsetXMm === 0 && t.offsetYMm === 0 && t.scale === 1;
}

/** 저장된 값을 범위 안으로 정규화 (기본값과 같은 영역은 제외) */
function readTransforms(artwork: ArtworkState | undefined): PartTransforms {
  const out: PartTransforms = {};
  const saved = artwork?.partTransforms;
  if (!saved) return out;
  for (const part of ARTWORK_PARTS) {
    const raw = saved[part];
    if (!raw) continue;
    const next: PartTransform = {
      offsetXMm: roundMm(
        clamp(Number(raw.offsetXMm) || 0, OFFSET_MIN_MM, OFFSET_MAX_MM),
      ),
      offsetYMm: roundMm(
        clamp(Number(raw.offsetYMm) || 0, OFFSET_MIN_MM, OFFSET_MAX_MM),
      ),
      scale: roundScale(clamp(Number(raw.scale) || 1, SCALE_MIN, SCALE_MAX)),
    };
    if (!isIdentity(next)) out[part] = next;
  }
  return out;
}

/** "+2.0mm" / "−1.0mm" (음수는 U+2212) */
function formatMm(value: number) {
  const v = roundMm(value);
  return `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}mm`;
}

function formatTransform(t: PartTransform) {
  return `x ${formatMm(t.offsetXMm)} · y ${formatMm(t.offsetYMm)} · ${Math.round(
    t.scale * 100,
  )}%`;
}

/** 영역 실치수 안내 문구 */
function partNote(part: ArtworkPart) {
  if (part === "label") {
    const spec = PRINT_SPECS.label;
    return `Ø${spec.outerDiameterMm}mm · 내경 Ø${spec.innerDiameterMm}mm`;
  }
  const spec = PRINT_SPECS[part];
  const spine = "spineMm" in spec ? ` · 스파인 ${spec.spineMm}mm` : "";
  return `${spec.widthMm}×${spec.heightMm}mm${spine}`;
}

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

/**
 * 아트워크 iframe.
 * sandbox iframe 내부는 건드릴 수 없으므로 프레임 요소 자체에 mm transform 을 준다.
 * mm 는 CSS 절대단위라 축소 미리보기(zoom) 안에서도 박스와 같은 비율로 줄어든다.
 */
function ArtworkFrame({
  projectId,
  filename,
  title,
  transform,
}: {
  projectId: string;
  filename: string;
  title: string;
  transform: PartTransform;
}) {
  const style: React.CSSProperties = {
    transform: `translate(${transform.offsetXMm}mm, ${transform.offsetYMm}mm) scale(${transform.scale})`,
    transformOrigin: "center center",
  };
  return (
    <iframe
      className={styles.artworkFrame}
      style={style}
      src={artworkUrl(projectId, filename)}
      title={title}
      loading="lazy"
      sandbox=""
    />
  );
}

function partStyle(part: ArtworkPart): React.CSSProperties {
  if (part === "label") {
    const spec = PRINT_SPECS.label;
    return {
      width: `${spec.outerDiameterMm}mm`,
      height: `${spec.outerDiameterMm}mm`,
      "--label-hole": `${spec.innerDiameterMm}mm`,
    } as React.CSSProperties;
  }

  const spec = PRINT_SPECS[part];
  return {
    width: `${spec.widthMm}mm`,
    height: `${spec.heightMm}mm`,
    ...("spineMm" in spec
      ? { "--spine-width": `${spec.spineMm}mm` }
      : {}),
  } as React.CSSProperties;
}

const iconButtonClass =
  "flex h-8 w-8 items-center justify-center rounded-md border border-line text-sm text-fg-muted transition hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30";

/** 영역별 위치·크기 조정 컨트롤 (화면 전용) */
function AdjustControls({
  transform,
  moveStep,
  onMoveStep,
  onMove,
  onScale,
  onReset,
}: {
  transform: PartTransform;
  moveStep: MoveStep;
  onMoveStep: (step: MoveStep) => void;
  onMove: (dxMm: number, dyMm: number) => void;
  onScale: (delta: number) => void;
  onReset: () => void;
}) {
  const atMinX = transform.offsetXMm <= OFFSET_MIN_MM;
  const atMaxX = transform.offsetXMm >= OFFSET_MAX_MM;
  const atMinY = transform.offsetYMm <= OFFSET_MIN_MM;
  const atMaxY = transform.offsetYMm >= OFFSET_MAX_MM;

  return (
    <div className="mt-3 flex flex-wrap items-start gap-5">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-dim">
          위치
        </p>
        <div className="mt-1.5 grid grid-cols-3 grid-rows-3 gap-1">
          <span />
          <button
            type="button"
            className={iconButtonClass}
            disabled={atMinY}
            onClick={() => onMove(0, -moveStep)}
            aria-label={`위로 ${moveStep}mm`}
            title={`위로 ${moveStep}mm`}
          >
            ↑
          </button>
          <span />
          <button
            type="button"
            className={iconButtonClass}
            disabled={atMinX}
            onClick={() => onMove(-moveStep, 0)}
            aria-label={`왼쪽으로 ${moveStep}mm`}
            title={`왼쪽으로 ${moveStep}mm`}
          >
            ←
          </button>
          <button
            type="button"
            className={iconButtonClass}
            disabled={isIdentity(transform)}
            onClick={onReset}
            aria-label="원래대로"
            title="원래대로"
          >
            ⟲
          </button>
          <button
            type="button"
            className={iconButtonClass}
            disabled={atMaxX}
            onClick={() => onMove(moveStep, 0)}
            aria-label={`오른쪽으로 ${moveStep}mm`}
            title={`오른쪽으로 ${moveStep}mm`}
          >
            →
          </button>
          <span />
          <button
            type="button"
            className={iconButtonClass}
            disabled={atMaxY}
            onClick={() => onMove(0, moveStep)}
            aria-label={`아래로 ${moveStep}mm`}
            title={`아래로 ${moveStep}mm`}
          >
            ↓
          </button>
          <span />
        </div>
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-dim">
          이동 단위
        </p>
        <div className="mt-1.5 flex gap-1">
          {MOVE_STEPS.map((step) => {
            const active = moveStep === step;
            return (
              <button
                key={step}
                type="button"
                aria-pressed={active}
                onClick={() => onMoveStep(step)}
                className={`rounded-md border px-2.5 py-1.5 text-[11px] transition ${
                  active
                    ? "border-amber/70 bg-amber/15 text-amber-bright"
                    : "border-line text-fg-muted hover:bg-panel-2 hover:text-fg"
                }`}
              >
                {step}mm
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-dim">
          크기
        </p>
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            className={iconButtonClass}
            disabled={transform.scale <= SCALE_MIN}
            onClick={() => onScale(-SCALE_STEP)}
            aria-label="5% 축소"
            title="5% 축소"
          >
            −
          </button>
          <span className="w-14 text-center font-mono text-xs text-fg">
            {Math.round(transform.scale * 100)}%
          </span>
          <button
            type="button"
            className={iconButtonClass}
            disabled={transform.scale >= SCALE_MAX}
            onClick={() => onScale(SCALE_STEP)}
            aria-label="5% 확대"
            title="5% 확대"
          >
            +
          </button>
        </div>
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-dim">
          되돌리기
        </p>
        <button
          type="button"
          disabled={isIdentity(transform)}
          onClick={onReset}
          className="mt-1.5 rounded-md border border-line px-3 py-1.5 text-[11px] text-fg-muted transition hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
        >
          원래대로
        </button>
      </div>
    </div>
  );
}

function ArtworkPage({
  projectId,
  projectTitle,
  variant,
  part,
  last,
  transform,
  open,
  onToggle,
  moveStep,
  onMoveStep,
  onMove,
  onScale,
  onReset,
  status,
}: {
  projectId: string;
  projectTitle: string;
  variant: ArtworkVariant;
  part: ArtworkPart;
  /** 인쇄되는 마지막 영역인지 (뒤에 빈 페이지가 생기지 않게) */
  last: boolean;
  transform: PartTransform;
  open: boolean;
  onToggle: () => void;
  moveStep: MoveStep;
  onMoveStep: (step: MoveStep) => void;
  onMove: (dxMm: number, dyMm: number) => void;
  onScale: (delta: number) => void;
  onReset: () => void;
  status: React.ReactNode;
}) {
  const filename = variant.files[part];
  const label = PART_LABELS[part];
  const isLabel = part === "label";
  const hasFoldLines = part === "back" || part === "back-inner";
  const adjusted = !isIdentity(transform);

  return (
    <div
      className={`${styles.sheetBlock} ${filename ? "" : styles.emptyBlock} ${
        last ? styles.lastBlock : ""
      }`}
    >
      {filename && (
        <div className={`${styles.controlBar} ${styles.screenOnly}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-semibold text-fg">{label}</span>
            <span className="font-mono text-[11px] text-fg-dim">
              {partNote(part)}
            </span>
            <button
              type="button"
              aria-expanded={open}
              onClick={onToggle}
              className={`rounded-md border px-3 py-1.5 text-[11px] transition ${
                open
                  ? "border-amber/70 bg-amber/15 text-amber-bright"
                  : "border-line text-fg-muted hover:bg-panel-2 hover:text-fg"
              }`}
            >
              {open ? "조정 닫기" : "조정"}
            </button>
            <span
              className={`font-mono text-[11px] ${
                adjusted ? "text-amber" : "text-fg-dim"
              }`}
            >
              {formatTransform(transform)}
            </span>
            {status}
          </div>
          {open && (
            <AdjustControls
              transform={transform}
              moveStep={moveStep}
              onMoveStep={onMoveStep}
              onMove={onMove}
              onScale={onScale}
              onReset={onReset}
            />
          )}
        </div>
      )}

      <section
        className={`${styles.sheet} ${filename ? "" : styles.emptySheet}`}
        aria-label={`${label} 인쇄 페이지`}
      >
        <span className={`${styles.partName} ${styles.screenOnly}`}>{label}</span>
        <div
          className={`${styles.part} ${isLabel ? styles.label : ""} ${
            filename ? "" : styles.emptyPart
          }`}
          style={partStyle(part)}
        >
          {filename ? (
            <>
              <CropMarks />
              <div
                className={`${styles.artworkClip} ${isLabel ? styles.labelClip : ""}`}
              >
                <ArtworkFrame
                  projectId={projectId}
                  filename={filename}
                  title={`${projectTitle} ${label}`}
                  transform={transform}
                />
              </div>
              {hasFoldLines && (
                <>
                  <span
                    className={`${styles.foldLine} ${styles.foldLeft}`}
                    aria-hidden="true"
                  />
                  <span
                    className={`${styles.foldLine} ${styles.foldRight}`}
                    aria-hidden="true"
                  />
                </>
              )}
              {isLabel && <span className={styles.labelHole} aria-hidden="true" />}
            </>
          ) : (
            <p className={styles.emptyMessage}>이 영역은 비어 있음 (인쇄 제외)</p>
          )}
        </div>
      </section>
    </div>
  );
}

export default function PrintClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [transforms, setTransforms] = useState<PartTransforms>({});
  const [openParts, setOpenParts] = useState<Partial<Record<ArtworkPart, boolean>>>({});
  const [moveStep, setMoveStep] = useState<MoveStep>(MOVE_STEPS[0]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [editedPart, setEditedPart] = useState<ArtworkPart | null>(null);

  /** 저장 payload 의 단일 진실 — 디바운스 타이머가 실행 시점에 읽는다 */
  const transformsRef = useRef<PartTransforms>({});
  /** PATCH 직렬화 (동시 저장으로 인한 역전 방지) */
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveTimerRef = useRef<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;

    fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("프로젝트를 불러오지 못했습니다.");
        return (await response.json()) as AlbumProject;
      })
      .then((data) => {
        if (!active) return;
        setProject(data);
        const saved = readTransforms(data.artwork);
        transformsRef.current = saved;
        setTransforms(saved);
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

  /**
   * 최신 project 를 다시 읽어 artwork 의 다른 필드(variants/selected/partModes/partPhotos)를
   * 보존한 채 partTransforms 만 병합 저장한다.
   */
  const persist = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const payload = transformsRef.current;
      setSaveState("saving");
      try {
        const latestRes = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}`,
          { cache: "no-store" },
        );
        if (!latestRes.ok) {
          throw new Error(`앨범을 불러오지 못했습니다 (${latestRes.status})`);
        }
        const latest = (await latestRes.json()) as AlbumProject;
        const artwork: ArtworkState = {
          ...(latest.artwork ?? { variants: [] }),
          partTransforms: payload,
        };
        if (Object.keys(payload).length === 0) delete artwork.partTransforms;

        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artwork }),
        });
        const data = (await res.json().catch(() => null)) as
          | (AlbumProject & { error?: string })
          | { error?: string }
          | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `미세조정 저장 실패 (${res.status})`);
        }
        setProject(data as AlbumProject);
        setSaveError("");
        setSaveState("saved");
        if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => {
          savedTimerRef.current = null;
          setSaveState((cur) => (cur === "saved" ? "idle" : cur));
        }, 1500);
        return true;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
        setSaveState("error");
        return false;
      }
    };
    const next = saveChainRef.current.then(run, run);
    saveChainRef.current = next;
    return next;
  }, [projectId]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persist();
    }, SAVE_DEBOUNCE_MS);
  }, [persist]);

  // 언마운트 시 대기 중인 변경을 즉시 저장
  useEffect(
    () => () => {
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void persist();
      }
    },
    [persist],
  );

  const updateTransform = useCallback(
    (part: ArtworkPart, patch: (current: PartTransform) => PartTransform) => {
      setTransforms((cur) => {
        const current = cur[part] ?? IDENTITY;
        const raw = patch(current);
        const next: PartTransform = {
          offsetXMm: roundMm(clamp(raw.offsetXMm, OFFSET_MIN_MM, OFFSET_MAX_MM)),
          offsetYMm: roundMm(clamp(raw.offsetYMm, OFFSET_MIN_MM, OFFSET_MAX_MM)),
          scale: roundScale(clamp(raw.scale, SCALE_MIN, SCALE_MAX)),
        };
        if (
          next.offsetXMm === current.offsetXMm &&
          next.offsetYMm === current.offsetYMm &&
          next.scale === current.scale
        ) {
          return cur;
        }
        const updated: PartTransforms = { ...cur };
        if (isIdentity(next)) delete updated[part];
        else updated[part] = next;
        transformsRef.current = updated;
        return updated;
      });
      setEditedPart(part);
      scheduleSave();
    },
    [scheduleSave],
  );

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

  const printableParts = ARTWORK_PARTS.filter((part) => selectedVariant?.files[part]);
  const hasPrintablePart = printableParts.length > 0;
  const lastPrintablePart = printableParts[printableParts.length - 1];

  if (!selectedVariant || !hasPrintablePart) {
    return (
      <section className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center shadow-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-amber">
          5단계 · 실치수 인쇄
        </p>
        <h2 className="mt-3 text-xl font-semibold text-fg">
          먼저 디자인 단계에서 아트워크를 생성·선택하세요
        </h2>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          인쇄할 아트워크 영역이 준비되면 실물 크기로 미리 보고 인쇄할 수 있습니다.
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

  const statusNode = (part: ArtworkPart): React.ReactNode => {
    if (editedPart !== part) return null;
    if (saveState === "saving") return <span className="text-[11px] text-fg-dim">저장 중…</span>;
    if (saveState === "saved") return <span className="text-[11px] text-teal">저장됨</span>;
    if (saveState === "error") {
      return (
        <span className="flex items-center gap-2 text-[11px] text-rose">
          {saveError || "저장 실패"}
          <button
            type="button"
            onClick={() => void persist()}
            className="rounded-md border border-rose/50 px-2 py-1 text-[11px] text-rose transition hover:bg-rose/10"
          >
            재시도
          </button>
        </span>
      );
    }
    return null;
  };

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
          <p className="mt-1 text-xs text-fg-dim">
            사진 크롭 위치나 프린터 오차는 각 영역의 &ldquo;조정&rdquo;에서 맞추세요. 조정값은
            미리보기와 실제 인쇄에 똑같이 적용되고 자동 저장됩니다.
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
        {ARTWORK_PARTS.map((part) => (
          <ArtworkPage
            key={part}
            projectId={projectId}
            projectTitle={project.title}
            variant={selectedVariant}
            part={part}
            last={part === lastPrintablePart}
            transform={transforms[part] ?? IDENTITY}
            open={Boolean(openParts[part])}
            onToggle={() =>
              setOpenParts((cur) => ({ ...cur, [part]: !cur[part] }))
            }
            moveStep={moveStep}
            onMoveStep={setMoveStep}
            onMove={(dxMm, dyMm) =>
              updateTransform(part, (t) => ({
                ...t,
                offsetXMm: t.offsetXMm + dxMm,
                offsetYMm: t.offsetYMm + dyMm,
              }))
            }
            onScale={(delta) =>
              updateTransform(part, (t) => ({ ...t, scale: t.scale + delta }))
            }
            onReset={() => updateTransform(part, () => IDENTITY)}
            status={statusNode(part)}
          />
        ))}
      </div>
    </div>
  );
}
