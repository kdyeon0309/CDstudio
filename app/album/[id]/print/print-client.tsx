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
import ArtworkSheetPreview from "@/components/ArtworkSheetPreview";
import FoldedFrontSheet from "@/components/FoldedFrontSheet";
import FoldedBackSheet from "@/components/FoldedBackSheet";
import { canBackFold, canFrontFold, printPartsForTarget, type PrintTarget } from "@/lib/print-plan";
import { selectedStudioCandidate, selectedStudioParts, studioBackMayCropLegacyCandidate, studioPart, studioPrintEnabled, studioPrintResolution, studioSpineNeedsBack } from "@/lib/studio-view";
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
  if (part === "back") {
    return "150×118mm 트레이카드 · 중앙 아트 137×118mm · 좌우 스파인 각 6.5mm";
  }
  const spec = PRINT_SPECS[part];
  const spine = "spineMm" in spec ? ` · 스파인 ${spec.spineMm}mm · 점선은 미리보기용, 인쇄 시 위쪽 표식만 표시` : "";
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
  eager,
}: {
  projectId: string;
  filename: string;
  title: string;
  transform: PartTransform;
  eager: boolean;
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
      loading={eager ? "eager" : "lazy"}
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
  eager,
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
  eager: boolean;
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
                  eager={eager}
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

function PrintTargetSelector({
  target,
  onChange,
  frontFoldAvailable,
  backFoldAvailable,
  remainingAvailable,
}: {
  target: PrintTarget;
  onChange: (target: PrintTarget) => void;
  frontFoldAvailable: boolean;
  backFoldAvailable: boolean;
  remainingAvailable: boolean;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-xs font-semibold text-fg">인쇄 대상</legend>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-fg-muted">
        <label className="flex items-center gap-1.5">
          <input type="radio" name="print-target" value="all" checked={target === "all"} onChange={() => onChange("all")} />
          전체 영역
        </label>
        <label className={`flex items-center gap-1.5 ${frontFoldAvailable ? "" : "opacity-50"}`}>
          <input type="radio" name="print-target" value="front-fold" checked={target === "front-fold"} disabled={!frontFoldAvailable} onChange={() => onChange("front-fold")} />
          앞표지 접기 (1페이지)
        </label>
        <label className={`flex items-center gap-1.5 ${backFoldAvailable ? "" : "opacity-50"}`}>
          <input type="radio" name="print-target" value="back-fold" checked={target === "back-fold"} disabled={!backFoldAvailable} onChange={() => onChange("back-fold")} />
          뒷표지 접기 (1페이지)
        </label>
        <label className={`flex items-center gap-1.5 ${remainingAvailable ? "" : "opacity-50"}`}>
          <input type="radio" name="print-target" value="remaining" checked={target === "remaining"} disabled={!remainingAvailable} onChange={() => onChange("remaining")} />
          나머지 영역
        </label>
      </div>
      {!frontFoldAvailable && (
        <p className="mt-2 text-xs text-amber">앞표지와 앞표지 내부가 모두 준비되어야 접기용 한 페이지를 인쇄할 수 있습니다.</p>
      )}
      {!backFoldAvailable && <p className="mt-1 text-xs text-amber">뒷표지와 뒷표지 내부가 모두 준비되어야 접기용 한 페이지를 인쇄할 수 있습니다.</p>}
      {!remainingAvailable && (
        <p className="mt-1 text-xs text-amber">앞표지 외에 인쇄할 나머지 영역이 없습니다.</p>
      )}
      {target === "front-fold" && (
        <p className="mt-2 max-w-3xl text-xs leading-5 text-fg-muted">
          A4 가로·단면·배율 100%·여백 0으로 인쇄하고 머리글·바닥글은 끄고 배경 그래픽은 켜세요. 왼쪽은 앞표지 내부, 오른쪽은 앞표지입니다. 바깥 네 모서리 표식에 맞춰 외곽 사각형만 자르고, 중앙 위·아래 짧은 표식은 자르지 말고 접는 위치로 사용하세요. 인쇄되지 않은 뒷면끼리 맞닿도록 접으면 인쇄면이 바깥으로 나오며 완성 크기는 120×120mm입니다. 이미지 배치는 디자인 스튜디오에서, 기존 디자인의 조정값은 ‘전체 영역’의 ‘조정’에서 변경하세요.
        </p>
      )}
      {target === "back-fold" && <p className="mt-2 max-w-3xl text-xs leading-5 text-fg-muted">A4 세로·단면·배율 100%·여백 0으로 인쇄하고 머리글·바닥글은 끄고 배경 그래픽은 켜세요. 위는 바깥 뒷표지, 아래는 180도 회전한 안쪽 뒷표지입니다. 바깥 네 모서리만 자르고 가운데 좌우 짧은 표식은 접는 위치로 사용하세요. 위·아래 스파인 표식은 6.5mm 접힘 위치입니다. 인쇄되지 않은 뒷면끼리 맞닿도록 접으면 완성 크기는 150×118mm입니다.</p>}
      {target === "remaining" && (
        <p className="mt-2 max-w-3xl text-xs leading-5 text-fg-muted">앞표지 접기와 분리된 A4 세로 단면 작업입니다. 나머지 영역을 기존 크기와 순서로 인쇄하세요.</p>
      )}
      {target === "all" && (
        <p className="mt-2 max-w-3xl text-xs leading-5 text-fg-muted">전체 영역은 기존처럼 각 영역을 A4 세로 한 장씩 단면으로 인쇄합니다. 접는 앞표지가 필요하면 ‘앞표지 접기’를 별도로 인쇄한 뒤 ‘나머지 영역’을 인쇄하세요.</p>
      )}
    </fieldset>
  );
}

function StudioPrint({ project }: { project: AlbumProject }) {
  const printableParts = selectedStudioParts(project);
  const spineCandidate = selectedStudioCandidate(project, "back-spine");
  const [printTarget, setPrintTarget] = useState<PrintTarget>("all");
  const [overflowByPart, setOverflowByPart] = useState<Partial<Record<ArtworkPart, boolean>>>({});
  const plannedParts = printPartsForTarget(printableParts, printTarget);
  const frontFoldAvailable = canFrontFold(printableParts);
  const backFoldAvailable = canBackFold(printableParts);
  const remainingAvailable = printPartsForTarget(printableParts, "remaining").length > 0;
  const blockedByOrphanSpine = printTarget !== "front-fold" && studioSpineNeedsBack(project);
  // 직접 Ctrl+P를 눌러도 단독 스파인이 있는 전체/나머지 계획은 부분 인쇄하지 않는다.
  const renderedParts = blockedByOrphanSpine ? [] : plannedParts;
  const unverifiedOverlay = renderedParts.some((part) =>
    (studioPart(project, part).presentation.overlay.enabled ||
      (part === "back" && spineCandidate && studioPart(project, "back-spine").presentation.overlay.enabled)) &&
    overflowByPart[part] === undefined,
  );
  const overflowingParts = renderedParts.filter((part) => overflowByPart[part]);
  if (printableParts.length === 0) {
    if (studioSpineNeedsBack(project)) {
      return (
        <section className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center">
          <h2 className="text-xl font-semibold text-fg">뒷표지 중앙 이미지가 필요합니다</h2>
          <p className="mt-2 text-sm text-fg-muted">선택한 스파인은 뒷표지 중앙과 함께 한 장의 트레이카드로 인쇄됩니다. 디자인 스튜디오에서 뒷표지 후보를 확정해 주세요.</p>
          <Link href={`/album/${encodeURIComponent(project.id)}/design`} className="mt-5 inline-flex rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-ink">디자인 스튜디오로 이동</Link>
        </section>
      );
    }
    return (
      <section className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center">
        <h2 className="text-xl font-semibold text-fg">인쇄할 영역을 먼저 확정하세요</h2>
        <p className="mt-2 text-sm text-fg-muted">디자인 스튜디오에서 생성 후보를 확인하고 ‘이 후보 사용’을 누르세요.</p>
        <Link href={`/album/${encodeURIComponent(project.id)}/design`} className="mt-5 inline-flex rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-ink">디자인 스튜디오로 이동</Link>
      </section>
    );
  }

  return (
    <div className={styles.printRoot}>
      <header className={`${styles.screenOnly} mb-8 flex flex-wrap items-end justify-between gap-5`}>
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-amber">③ 실치수 인쇄</p>
          <h2 className="mt-2 text-2xl font-semibold text-fg">영역별 디자인 인쇄</h2>
          <p className="mt-1 text-sm text-fg-muted">{printTarget === "front-fold" ? "앞표지 두 면이 A4 가로 한 장에 배치됩니다." : printTarget === "back-fold" ? "뒷표지 바깥면과 안쪽면이 A4 세로 한 장에 배치됩니다." : `A4, 배율 100%로 인쇄하세요. 현재 대상 ${renderedParts.length}개 영역이 각각 한 장에 배치됩니다.`}</p>
          <PrintTargetSelector target={printTarget} onChange={setPrintTarget} frontFoldAvailable={frontFoldAvailable} backFoldAvailable={backFoldAvailable} remainingAvailable={remainingAvailable} />
          <Link href={`/album/${encodeURIComponent(project.id)}/design`} className="mt-2 inline-flex text-xs text-amber hover:underline">디자인 스튜디오에서 배치 조정 →</Link>
          <span className="mx-2 text-line-strong" aria-hidden="true">·</span>
          <Link href={`/album/${encodeURIComponent(project.id)}/preview`} className="inline-flex text-xs text-amber hover:underline">완성 모습 3D →</Link>
        </div>
        <button type="button" disabled={renderedParts.length === 0 || blockedByOrphanSpine || unverifiedOverlay || overflowingParts.length > 0} onClick={() => window.print()} className="rounded-xl bg-amber px-5 py-3 text-sm font-bold text-ink disabled:cursor-not-allowed disabled:opacity-40">인쇄 (PDF 저장)</button>
      </header>
      {blockedByOrphanSpine && <p role="alert" className={`${styles.screenOnly} mb-4 rounded-lg border border-amber/40 bg-amber/10 p-3 text-xs text-amber`}>선택한 스파인은 뒷표지 중앙과 함께 인쇄됩니다. 전체 또는 나머지 영역을 인쇄하려면 디자인 스튜디오에서 뒷표지 후보를 확정하세요. 앞표지 접기는 별도로 사용할 수 있습니다.</p>}
      {overflowingParts.length > 0 && <p role="alert" className={`${styles.screenOnly} mb-4 rounded-lg border border-rose/40 bg-rose/10 p-3 text-xs text-rose`}>{overflowingParts.map((part) => PART_LABELS[part]).join(", ")} 글자가 인쇄 영역을 벗어납니다. 디자인 스튜디오에서 글자 크기를 줄이거나 글자를 끄세요.</p>}
      <p className={`${styles.screenOnly} mb-3 text-xs text-fg-dim`}>PPI는 원본 픽셀과 인쇄 크기로 추정한 값입니다. 이미지 전체 보기는 흐린 배경도 고려합니다. 300PPI 미달 경고가 있어도 인쇄할 수 있습니다.</p>
      <div className={styles.preview}>
        {printTarget === "front-fold" && renderedParts.length === 2 ? (
          <FoldedFrontSheet
            left={<ArtworkSheetPreview project={project} part="front-inner" candidate={selectedStudioCandidate(project, "front-inner")!} presentation={studioPart(project, "front-inner").presentation} embedded onOverflow={(overflow) => setOverflowByPart((current) => current["front-inner"] === overflow ? current : { ...current, "front-inner": overflow })} />}
            right={<ArtworkSheetPreview project={project} part="front" candidate={selectedStudioCandidate(project, "front")!} presentation={studioPart(project, "front").presentation} embedded onOverflow={(overflow) => setOverflowByPart((current) => current.front === overflow ? current : { ...current, front: overflow })} />}
          />
        ) : printTarget === "back-fold" && renderedParts.length === 2 ? (
          <FoldedBackSheet
            outside={<ArtworkSheetPreview project={project} part="back" candidate={selectedStudioCandidate(project, "back")!} presentation={studioPart(project, "back").presentation} spineCandidate={spineCandidate} spinePresentation={spineCandidate ? studioPart(project, "back-spine").presentation : undefined} embedded onOverflow={(overflow) => setOverflowByPart((current) => current.back === overflow ? current : { ...current, back: overflow })} />}
            inside={<ArtworkSheetPreview project={project} part="back-inner" candidate={selectedStudioCandidate(project, "back-inner")!} presentation={studioPart(project, "back-inner").presentation} embedded onOverflow={(overflow) => setOverflowByPart((current) => current["back-inner"] === overflow ? current : { ...current, "back-inner": overflow })} />}
          />
        ) : renderedParts.map((part, index) => {
          const candidate = selectedStudioCandidate(project, part);
          if (!candidate) return null;
          const presentation = studioPart(project, part).presentation;
          const resolution = studioPrintResolution(candidate, part, presentation);
          const backMayCropLegacyCandidate = part === "back" && studioBackMayCropLegacyCandidate(candidate, presentation);
          const spineResolution = part === "back" && spineCandidate
            ? studioPrintResolution(spineCandidate, "back-spine", studioPart(project, "back-spine").presentation) : null;
          return (
            <div key={part} className={styles.sheetBlock}>
              <div className={`${styles.controlBar} ${styles.screenOnly}`}>
                <span className="text-sm font-semibold text-fg">{PART_LABELS[part]}</span>
                <span className="ml-3 font-mono text-xs text-fg-dim">{partNote(part)}</span>
                <span className={`ml-3 text-xs ${resolution.grade === "target" ? "text-fg-dim" : "text-amber"}`}>인쇄 이미지 {resolution.widthPx}×{resolution.heightPx}px · 약 {resolution.ppi}PPI{resolution.grade !== "target" ? ` · 300PPI 목표 미달${resolution.grade === "low" ? " (저해상도)" : ""}` : " · 목표 충족"}</span>
              </div>
              {backMayCropLegacyCandidate && <p role="alert" className={`${styles.screenOnly} mb-2 text-xs text-amber`}>기존 풀폭 뒷표지 이미지는 중앙 137mm에 맞출 때 양옆이 잘릴 수 있습니다. 디자인 스튜디오에서 ‘이미지 전체 보기’로 바꾸거나 새 규격으로 다시 생성하세요.</p>}
              {!resolution.fullBleed && <p role="alert" className={`${styles.screenOnly} mb-2 text-xs text-amber`}>여백 가능: 현재 축소·이동 설정으로 이미지가 인쇄 영역을 끝까지 채우지 못할 수 있습니다.</p>}
              {spineResolution && <p className={`${styles.screenOnly} mb-2 text-xs ${spineResolution.grade === "target" ? "text-fg-dim" : "text-amber"}`}>선택한 스파인 인쇄 이미지 {spineResolution.widthPx}×{spineResolution.heightPx}px · 6.5×118mm · 약 {spineResolution.ppi}PPI{spineResolution.grade !== "target" ? ` · 300PPI 목표 미달${spineResolution.grade === "low" ? " (저해상도)" : ""}` : " · 목표 충족"}</p>}
              {spineResolution && !spineResolution.fullBleed && <p role="alert" className={`${styles.screenOnly} mb-2 text-xs text-amber`}>선택한 스파인 여백 가능: 스파인 배치를 확인하세요.</p>}
              <div className={styles.scaledSheet}>
                <ArtworkSheetPreview project={project} part={part} candidate={candidate} presentation={studioPart(project, part).presentation} spineCandidate={part === "back" ? spineCandidate : undefined} spinePresentation={part === "back" && spineCandidate ? studioPart(project, "back-spine").presentation : undefined} last={index === renderedParts.length - 1} onOverflow={(overflow) => setOverflowByPart((current) => current[part] === overflow ? current : { ...current, [part]: overflow })} />
              </div>
            </div>
          );
        })}
      </div>
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
  const [printTarget, setPrintTarget] = useState<PrintTarget>("all");

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

  if (studioPrintEnabled(project)) return <StudioPrint project={project} />;

  const printableParts = ARTWORK_PARTS.filter((part) => selectedVariant?.files[part]);
  const hasPrintablePart = printableParts.length > 0;

  if (!selectedVariant || !hasPrintablePart) {
    return (
      <section className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center shadow-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-amber">
          ③ 실치수 인쇄
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

  const plannedParts = printPartsForTarget(printableParts, printTarget);
  const displayedParts = printTarget === "all" ? ARTWORK_PARTS : plannedParts;
  const lastPrintablePart = plannedParts[plannedParts.length - 1];
  const frontFoldAvailable = canFrontFold(printableParts);
  const backFoldAvailable = canBackFold(printableParts);
  const remainingAvailable = printPartsForTarget(printableParts, "remaining").length > 0;

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
            ③ 실치수 인쇄
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-fg">인쇄 미리보기</h2>
          <p className="mt-1 text-sm text-fg-muted">
            {selectedVariant.index}안 · {selectedVariant.name} — A4, 배율 100%로 인쇄하세요.
          </p>
          <PrintTargetSelector target={printTarget} onChange={setPrintTarget} frontFoldAvailable={frontFoldAvailable} backFoldAvailable={backFoldAvailable} remainingAvailable={remainingAvailable} />
          <p className="mt-1 text-xs text-fg-dim">
            사진 크롭 위치나 프린터 오차는 각 영역의 &ldquo;조정&rdquo;에서 맞추세요. 조정값은
            미리보기와 실제 인쇄에 똑같이 적용되고 자동 저장됩니다.
          </p>
          <Link href={`/album/${encodeURIComponent(projectId)}/preview`} className="mt-2 inline-flex text-xs text-amber hover:underline">완성 모습 3D →</Link>
        </div>
        <button
          type="button"
          disabled={plannedParts.length === 0}
          onClick={() => window.print()}
          className="rounded-xl bg-violet-700 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-violet-950/30 transition hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          인쇄 (PDF 저장)
        </button>
      </header>

      <div className={styles.preview}>
        {printTarget === "front-fold" && plannedParts.length === 2 ? (
          <FoldedFrontSheet
            left={<ArtworkFrame projectId={projectId} filename={selectedVariant.files["front-inner"]!} title={`${project.title} ${PART_LABELS["front-inner"]}`} transform={transforms["front-inner"] ?? IDENTITY} eager />}
            right={<ArtworkFrame projectId={projectId} filename={selectedVariant.files.front!} title={`${project.title} ${PART_LABELS.front}`} transform={transforms.front ?? IDENTITY} eager />}
          />
        ) : printTarget === "back-fold" && plannedParts.length === 2 ? (
          <FoldedBackSheet
            outside={<ArtworkFrame projectId={projectId} filename={selectedVariant.files.back!} title={`${project.title} ${PART_LABELS.back}`} transform={transforms.back ?? IDENTITY} eager />}
            inside={<ArtworkFrame projectId={projectId} filename={selectedVariant.files["back-inner"]!} title={`${project.title} ${PART_LABELS["back-inner"]}`} transform={transforms["back-inner"] ?? IDENTITY} eager />}
          />
        ) : displayedParts.map((part) => (
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
            eager={false}
          />
        ))}
      </div>
    </div>
  );
}
