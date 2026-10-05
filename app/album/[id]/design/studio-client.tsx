"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArtworkSheetPreview from "@/components/ArtworkSheetPreview";
import DesignPresetPicker, {
  applyPresetToDrafts,
  requestPresetApplication,
  resolvePresetApplication,
  type PendingPresetApplication,
} from "./DesignPresetPicker";
import type {
  AlbumProject,
  StudioArtworkPart,
  StudioCandidate,
  StudioImageEvent,
  StudioPresentation,
} from "@/lib/types";
import { STUDIO_ARTWORK_PARTS, STUDIO_PART_LABELS, PRINT_SPECS } from "@/lib/types";
import { buildPresetPrompt } from "@/lib/design-presets";
import {
  beginStudioGeneration,
  hasRunningStudioGeneration,
  mergeStudioGenerationProject,
  mergeStudioPartProject,
  studioGenerationElapsed,
  updateStudioGeneration,
  type StudioGenerationJobs,
} from "@/lib/studio-generation";
import type { BackgroundJob } from "@/lib/background-job-types";
import {
  cancelBackgroundJob,
  listBackgroundJobs,
  newestUpdatedProject,
  startBackgroundJobIfActive,
  watchBackgroundJob,
  type BackgroundJobObserver,
} from "@/lib/background-job-client";
import {
  DEFAULT_PRESENTATION,
  selectedStudioCandidate,
  selectedStudioParts,
  studioBackMayCropLegacyCandidate,
  studioPart,
  studioPrintResolution,
  studioSpineNeedsBack,
} from "@/lib/studio-view";

interface Draft { prompt: string; referenceFiles: string[]; referenceLabels?: Record<string, string> }
type Drafts = Partial<Record<StudioArtworkPart, Draft>>;
type Presentations = Partial<Record<StudioArtworkPart, StudioPresentation>>;
type Dirty = Partial<Record<StudioArtworkPart, boolean>>;
type Connection = { connected: boolean; available: boolean; message: string };
interface DraftCache { drafts?: Drafts; presentations?: Presentations }
interface GenerationReservation { token: string; jobId?: string; observer?: BackgroundJobObserver }

const MAX_REFERENCE_LABEL = 40;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_STUDIO_BODY_BYTES = 1024 * 1024;
const VARIATION_SEPARATOR = "\n수정 요청: ";

const PRESENTATION_LIMITS = {
  offsetXMm: { min: -60, max: 60 },
  offsetYMm: { min: -60, max: 60 },
  scale: { min: 0.5, max: 3 },
  fontSizeMm: { min: 2, max: 20 },
} as const;

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function jsonRequestBody(value: Record<string, unknown>) {
  const body = JSON.stringify(value);
  if (utf8Bytes(body) > MAX_STUDIO_BODY_BYTES) {
    throw new Error("요청 전체가 UTF-8 기준 1MiB를 넘습니다. 프롬프트나 참고 이미지 이름을 줄여 주세요.");
  }
  return body;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validPresentation(value: unknown): value is StudioPresentation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as StudioPresentation;
  return (candidate.fit === "cover" || candidate.fit === "contain") &&
    Boolean(candidate.transform) &&
    inRange(candidate.transform.offsetXMm, PRESENTATION_LIMITS.offsetXMm.min, PRESENTATION_LIMITS.offsetXMm.max) &&
    inRange(candidate.transform.offsetYMm, PRESENTATION_LIMITS.offsetYMm.min, PRESENTATION_LIMITS.offsetYMm.max) &&
    inRange(candidate.transform.scale, PRESENTATION_LIMITS.scale.min, PRESENTATION_LIMITS.scale.max) &&
    Boolean(candidate.overlay) && typeof candidate.overlay.enabled === "boolean" &&
    /^#[0-9a-fA-F]{6}$/.test(candidate.overlay.color) &&
    (candidate.overlay.position === "top" || candidate.overlay.position === "bottom") &&
    inRange(candidate.overlay.fontSizeMm, PRESENTATION_LIMITS.fontSizeMm.min, PRESENTATION_LIMITS.fontSizeMm.max);
}

function cacheKey(projectId: string) {
  return `cdstudio:studio-draft:${projectId}`;
}

function referenceName(source: Pick<Draft, "referenceLabels">, filename: string, index: number) {
  return source.referenceLabels?.[filename]?.trim() || `이미지 ${index + 1}`;
}

function normalizedReferenceLabels(source: Pick<Draft, "referenceFiles" | "referenceLabels">) {
  const labels: Record<string, string> = {};
  for (const filename of source.referenceFiles) {
    const label = source.referenceLabels?.[filename]?.trim();
    if (label) labels[filename] = label;
  }
  return labels;
}

function referenceLabelError(draft: Draft) {
  const seen = new Set<string>();
  for (const [index, filename] of draft.referenceFiles.entries()) {
    const label = draft.referenceLabels?.[filename] ?? "";
    if (label.length > MAX_REFERENCE_LABEL || [...label].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    })) {
      return `참고 이미지 이름은 제어 문자 없이 ${MAX_REFERENCE_LABEL}자 이하로 입력하세요.`;
    }
    const effective = referenceName(draft, filename, index);
    const ordinal = /^이미지 ([1-9]\d*)$/.exec(effective);
    if (ordinal && Number(ordinal[1]) !== index + 1) {
      return "‘이미지 N’의 숫자는 참고 이미지의 선택 순서와 같아야 합니다.";
    }
    if (effective.toLocaleLowerCase() === "변형 원본") {
      return "‘변형 원본’은 변형할 후보에 사용되는 이름입니다. 다른 이름을 지정하세요.";
    }
    const key = effective.toLocaleLowerCase();
    if (seen.has(key)) return `‘${effective}’ 이름이 겹칩니다. 각 참고 이미지에 다른 이름을 지정하세요.`;
    seen.add(key);
  }
  return "";
}

function readDraftCache(projectId: string): DraftCache {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(cacheKey(projectId)) ?? "{}") as DraftCache;
    if (!parsed || typeof parsed !== "object") return {};
    const result: DraftCache = { drafts: {}, presentations: {} };
    for (const part of STUDIO_ARTWORK_PARTS) {
      const draft = parsed.drafts?.[part];
      if (draft && typeof draft.prompt === "string" &&
        Array.isArray(draft.referenceFiles) &&
        draft.referenceFiles.every((name) => typeof name === "string") &&
        (draft.referenceLabels === undefined || (
          draft.referenceLabels !== null && typeof draft.referenceLabels === "object" &&
          !Array.isArray(draft.referenceLabels) &&
          Object.entries(draft.referenceLabels).every(([filename, label]) =>
            draft.referenceFiles.includes(filename) && typeof label === "string" &&
            label.length <= MAX_REFERENCE_LABEL &&
            ![...label].some((char) => {
              const code = char.charCodeAt(0);
              return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
            }))
        ))) {
        result.drafts![part] = draft;
      }
      const value = parsed.presentations?.[part];
      if (validPresentation(value)) {
        result.presentations![part] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function updateDraftCache(projectId: string, apply: (cache: DraftCache) => void) {
  try {
    const cache = readDraftCache(projectId);
    apply(cache);
    if (Object.keys(cache.drafts ?? {}).length === 0 && Object.keys(cache.presentations ?? {}).length === 0) {
      sessionStorage.removeItem(cacheKey(projectId));
    } else {
      sessionStorage.setItem(cacheKey(projectId), JSON.stringify(cache));
    }
  } catch {
    // 브라우저가 저장소를 제한해도 편집은 계속 가능하다.
  }
}

function projectUrl(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function assetUrl(projectId: string, filename: string) {
  return `${projectUrl(projectId)}/file?type=asset&name=${encodeURIComponent(filename)}`;
}

function assetPreviewUrl(projectId: string, filename: string) {
  return `${projectUrl(projectId)}/preview/${encodeURIComponent(filename)}`;
}

function AssetThumbnail({ projectId, filename, alt, sizes, className }: {
  projectId: string;
  filename: string;
  alt: string;
  sizes: string;
  className: string;
}) {
  return (
    <Image
      src={assetPreviewUrl(projectId, filename)}
      alt={alt}
      fill
      sizes={sizes}
      loading="lazy"
      decoding="async"
      className={className}
    />
  );
}

function partDimensions(part: StudioArtworkPart) {
  if (part === "label") return { width: 116, height: 116 };
  if (part === "back-spine") return { width: 6.5, height: 118 };
  const spec = PRINT_SPECS[part];
  return { width: spec.widthMm, height: spec.heightMm };
}

function freshDraft(project: AlbumProject, part: StudioArtworkPart): Draft {
  const current = studioPart(project, part);
  return {
    prompt: current.prompt,
    referenceFiles: [...current.referenceFiles],
    referenceLabels: { ...current.referenceLabels },
  };
}

function freshPresentation(project: AlbumProject, part: StudioArtworkPart): StudioPresentation {
  const saved = studioPart(project, part).presentation;
  return {
    fit: saved.fit,
    transform: { ...saved.transform },
    overlay: { ...saved.overlay },
  };
}

function variationSeed(candidate: StudioCandidate) {
  return candidate.prompt || (candidate.source === "upload"
    ? "업로드한 이미지의 구도와 분위기를 유지해 주세요."
    : "");
}

function SpineOriginalPreview({ projectId, candidate, label }: {
  projectId: string;
  candidate: StudioCandidate;
  label: string;
}) {
  const src = assetUrl(projectId, candidate.filename);
  return (
    <figure className="mb-4 flex w-full flex-col items-center gap-2">
      <figcaption className="text-center text-xs font-semibold text-fg-muted">{label} · 원본 이미지 전체</figcaption>
      <a href={src} target="_blank" rel="noopener noreferrer" className="flex h-[28rem] w-80 max-w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-panel-2 p-2" aria-label={`${label} 원본 이미지 새 창에서 보기`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`${label} 원본 이미지`} className="h-full w-full object-contain" />
      </a>
      <span className="text-[11px] text-fg-dim">이미지를 누르면 원본 크기로 볼 수 있습니다.</span>
    </figure>
  );
}

async function responseError(response: Response, fallback: string) {
  const value = (await response.json().catch(() => null)) as { error?: string } | null;
  return value?.error ?? `${fallback} (${response.status})`;
}

export default function StudioClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [assets, setAssets] = useState<string[]>([]);
  const [activePart, setActivePart] = useState<StudioArtworkPart>("front");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [draftDirty, setDraftDirty] = useState<Dirty>({});
  const [presentations, setPresentations] = useState<Presentations>({});
  const [presentationDirty, setPresentationDirty] = useState<Dirty>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [variationText, setVariationText] = useState("");
  const [variationBase, setVariationBase] = useState("");
  const [snapshotName, setSnapshotName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [generationJobs, setGenerationJobs] = useState<StudioGenerationJobs>({});
  const [jobsReady, setJobsReady] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [generationNow, setGenerationNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewOverflow, setPreviewOverflow] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<PendingPresetApplication | null>(null);
  const activePartRef = useRef<StudioArtworkPart>("front");
  const generationControllersRef = useRef<Map<StudioArtworkPart, GenerationReservation>>(new Map());
  const busyRef = useRef(false);
  const suppressBeforeUnloadRef = useRef(false);
  const mountedRef = useRef(true);
  const recoveryStartedRef = useRef(false);
  const restoredGenerationPartsRef = useRef<Set<StudioArtworkPart>>(new Set());
  const projectReady = project !== null;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/design/studio?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "앨범을 불러오지 못했습니다."));
      const value = (await response.json()) as AlbumProject;
      setProject(value);
      const initialDrafts: Drafts = {};
      const initialPresentations: Presentations = {};
      for (const part of STUDIO_ARTWORK_PARTS) {
        initialDrafts[part] = freshDraft(value, part);
        initialPresentations[part] = freshPresentation(value, part);
      }
      const cache = readDraftCache(projectId);
      const restoredDraftDirty: Dirty = {};
      const restoredPresentationDirty: Dirty = {};
      for (const part of STUDIO_ARTWORK_PARTS) {
        const cachedDraft = cache.drafts?.[part];
        if (cachedDraft && JSON.stringify(cachedDraft) !== JSON.stringify(initialDrafts[part])) {
          initialDrafts[part] = cachedDraft;
          restoredDraftDirty[part] = true;
        }
        const cachedPresentation = cache.presentations?.[part];
        if (cachedPresentation && JSON.stringify(cachedPresentation) !== JSON.stringify(initialPresentations[part])) {
          initialPresentations[part] = cachedPresentation;
          restoredPresentationDirty[part] = true;
        }
      }
      setDrafts(initialDrafts);
      setPresentations(initialPresentations);
      setDraftDirty(restoredDraftDirty);
      setPresentationDirty(restoredPresentationDirty);
      const initial = studioPart(value, "front");
      const initialCandidate = initial.candidates.find((candidate) => candidate.id === initial.selectedCandidateId) ?? initial.candidates.at(-1);
      setPreviewId(initialCandidate?.id ?? null);
      setVariationBase(initialCandidate ? variationSeed(initialCandidate) : "");
      setLoadError("");
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "앨범을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadAssets = useCallback(async () => {
    try {
      const response = await fetch(`${projectUrl(projectId)}/assets`, { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as { filenames?: string[] };
        setAssets(Array.isArray(data.filenames) ? data.filenames : []);
      }
    } catch {
      // 이미지 생성과 후보 조회는 업로드 목록 없이도 계속 사용할 수 있다.
    }
  }, [projectId]);

  /** Terminal recovery refreshes persisted output without resetting local drafts or preview context. */
  const refreshStoredStudioProject = useCallback(async () => {
    try {
      const response = await fetch(`/api/design/studio?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "완료된 작업 결과를 불러오지 못했습니다."));
      const value = (await response.json()) as AlbumProject;
      if (mountedRef.current) setProject((current) => current ? newestUpdatedProject(current, value) : value);
    } catch (reason) {
      if (mountedRef.current) setNotice(reason instanceof Error ? reason.message : "완료된 작업 결과를 불러오지 못했습니다.");
    }
  }, [projectId]);

  useEffect(() => {
    const generationControllers = generationControllersRef.current;
    queueMicrotask(() => {
      void load();
      void loadAssets();
    });
    fetch("/api/design/image", { cache: "no-store" })
      .then(async (response) => response.ok ? (await response.json()) as Connection : null)
      .then(setConnection)
      .catch(() => setConnection({ connected: false, available: false, message: "Codex 연결 상태를 확인하지 못했습니다." }));
    return () => { for (const reservation of generationControllers.values()) reservation.observer?.stop(); };
  }, [load, loadAssets]);

  useEffect(() => {
    if (!projectReady || recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    setRecoveryFailed(false);
    const recovery = new AbortController();
    listBackgroundJobs(projectId, recovery.signal).then(async (jobs) => {
      for (const job of jobs) {
        if (job.endpoint !== "/api/design/image" || !job.part || recovery.signal.aborted) continue;
        const part = job.part as StudioArtworkPart;
        if (!STUDIO_ARTWORK_PARTS.includes(part) || generationControllersRef.current.has(part)) continue;
        restoredGenerationPartsRef.current.add(part);
        if (job.status === "running") attachGeneration(job, part, true);
        else setGenerationJobs((current) => ({ ...current, [part]: {
          token: job.id,
          part,
          prompt: "복구된 생성 작업",
          referenceFiles: [],
          referenceNames: [],
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          phase: job.status === "success" ? "완료" : job.status === "cancelled" ? "중단됨" : "실패",
          status: job.status,
          error: job.error,
        } }));
      }
      if (jobs.some((job) => job.endpoint === "/api/design/image" && job.status !== "running")) {
        await refreshStoredStudioProject();
      }
      if (!recovery.signal.aborted) setJobsReady(true);
    }).catch((reason: unknown) => {
      if (!recovery.signal.aborted) {
        recoveryStartedRef.current = false;
        setRecoveryFailed(true);
        setNotice(reason instanceof Error ? `${reason.message} ‘작업 다시 확인’을 눌러 주세요.` : "진행 중인 작업을 확인하지 못했습니다.");
      }
    });
    return () => recovery.abort();
  // attachGeneration intentionally reads current refs/state while recovering once per project.
  }, [projectId, projectReady, refreshStoredStudioProject, recoveryAttempt]);

  useEffect(() => {
    if (!hasRunningStudioGeneration(generationJobs)) return;
    const tick = () => setGenerationNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [generationJobs]);

  useEffect(() => {
    const hasDirtyPart = STUDIO_ARTWORK_PARTS.some((part) => draftDirty[part] || presentationDirty[part]);
    if (!hasDirtyPart) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (suppressBeforeUnloadRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const interceptLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!anchor || anchor.hasAttribute("download") || anchor.getAttribute("target") === "_blank") return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
      event.preventDefault();
      if (busyRef.current) {
        setNotice("현재 저장 작업을 마치는 중입니다. 완료 후 다시 이동해 주세요.");
        return;
      }
      busyRef.current = true;
      setBusy("save");
      void (async () => {
        try {
          if (!(await persistDirtyStateForNavigation())) return;
          suppressBeforeUnloadRef.current = true;
          window.location.href = destination.href;
        } finally {
          busyRef.current = false;
          setBusy(null);
        }
      })();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", interceptLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", interceptLink, true);
    };
  });

  const partState = project ? studioPart(project, activePart) : null;
  const draft = drafts[activePart] ?? (project ? freshDraft(project, activePart) : { prompt: "", referenceFiles: [] });
  const presentation = presentations[activePart] ?? DEFAULT_PRESENTATION;
  const currentGeneration = generationJobs[activePart];
  const currentGenerationRunning = currentGeneration?.status === "running";
  const anyGenerationRunning = hasRunningStudioGeneration(generationJobs);
  const areaBusy = Boolean(busy) || currentGenerationRunning;
  const preview = partState?.candidates.find((candidate) => candidate.id === previewId) ?? partState?.candidates.at(-1);
  const compared = partState?.candidates.find((candidate) => candidate.id === compareId);
  const selected = project ? selectedStudioCandidate(project, activePart) : undefined;
  const candidates = [...(partState?.candidates ?? [])].reverse();
  const candidateName = useMemo(() => {
    const names = new Map<string, string>();
    if (!project?.studio) return names;
    for (const part of STUDIO_ARTWORK_PARTS) {
      for (const [index, candidate] of (project.studio.parts[part]?.candidates ?? []).entries()) {
        names.set(candidate.filename, `${STUDIO_PART_LABELS[part]} 후보 ${index + 1}`);
      }
    }
    return names;
  }, [project]);

  async function patchStudio(action: string, payload: Record<string, unknown>) {
    const body = jsonRequestBody({ projectId, action, ...payload });
    const response = await fetch("/api/design/studio", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) throw new Error(await responseError(response, "저장하지 못했습니다."));
    const updated = (await response.json()) as AlbumProject;
    const part = typeof payload.part === "string" && STUDIO_ARTWORK_PARTS.includes(payload.part as StudioArtworkPart)
      ? payload.part as StudioArtworkPart : null;
    if (part) {
      const includePrintSource = action === "select" || action === "clear" || action === "import";
      const includeStatus = action === "select" || action === "import";
      setProject((current) => current
        ? mergeStudioPartProject(current, updated, part, { includePrintSource, includeStatus })
        : updated);
    } else {
      setProject(updated);
    }
    return updated;
  }

  async function persistDraft(
    part: StudioArtworkPart,
    reportError: (message: string) => void = setError,
  ): Promise<boolean> {
    if (!draftDirty[part]) return true;
    const current = drafts[part];
    if (!current) return true;
    const labelError = referenceLabelError(current);
    if (labelError) {
      reportError(labelError);
      return false;
    }
    try {
      const updated = await patchStudio("draft", {
        part,
        prompt: current.prompt,
        referenceFiles: current.referenceFiles,
        referenceLabels: normalizedReferenceLabels(current),
      });
      setDrafts((state) => ({ ...state, [part]: freshDraft(updated, part) }));
      updateDraftCache(projectId, (cache) => { delete cache.drafts?.[part]; });
      setDraftDirty((state) => ({ ...state, [part]: false }));
      return true;
    } catch (reason) {
      reportError(reason instanceof Error ? reason.message : "프롬프트 저장 실패");
      return false;
    }
  }

  async function persistDraftIfValid(part: StudioArtworkPart): Promise<boolean> {
    const current = drafts[part];
    if (draftDirty[part] && current && referenceLabelError(current)) {
      setNotice("참고 이미지 이름은 이 화면에 임시 보관했습니다. 돌아와서 수정한 뒤 저장할 수 있습니다.");
      return true;
    }
    return persistDraft(part);
  }

  async function persistPresentation(
    part: StudioArtworkPart,
    reportError: (message: string) => void = setError,
  ): Promise<boolean> {
    if (!presentationDirty[part]) return true;
    const current = presentations[part];
    if (!current) return true;
    try {
      await patchStudio("presentation", { part, presentation: current });
      updateDraftCache(projectId, (cache) => { delete cache.presentations?.[part]; });
      setPresentationDirty((state) => ({ ...state, [part]: false }));
      return true;
    } catch (reason) {
      reportError(reason instanceof Error ? reason.message : "인쇄 설정 저장 실패");
      return false;
    }
  }

  async function persistDirtyPresentations(): Promise<boolean> {
    const dirtyParts = STUDIO_ARTWORK_PARTS.filter((part) =>
      presentationDirty[part] && !generationControllersRef.current.has(part));
    for (const part of dirtyParts) {
      if (!(await persistPresentation(part))) return false;
    }
    return true;
  }

  async function persistDirtyStateForNavigation(): Promise<boolean> {
    const dirtyDraftParts = STUDIO_ARTWORK_PARTS.filter((part) =>
      draftDirty[part] && !generationControllersRef.current.has(part));
    for (const part of dirtyDraftParts) {
      if (!(await persistDraftIfValid(part))) return false;
    }
    const dirtyPresentationParts = STUDIO_ARTWORK_PARTS.filter((part) =>
      presentationDirty[part] && !generationControllersRef.current.has(part));
    for (const part of dirtyPresentationParts) {
      if (!(await persistPresentation(part))) return false;
    }
    return true;
  }

  async function switchPart(part: StudioArtworkPart) {
    if (part === activePart || busyRef.current) return;
    setPendingPreset(null);
    busyRef.current = true;
    setBusy("save");
    setError("");
    try {
      const departingPartIsGenerating = generationControllersRef.current.has(activePart);
      if (!departingPartIsGenerating && !(await persistDraftIfValid(activePart))) return;
      if (!departingPartIsGenerating && !(await persistPresentation(activePart))) return;
      activePartRef.current = part;
      setActivePart(part);
      const target = project ? studioPart(project, part) : null;
      const nextCandidate = target?.candidates.find((candidate) => candidate.id === target.selectedCandidateId) ?? target?.candidates.at(-1);
      setPreviewId(nextCandidate?.id ?? null);
      setVariationBase(nextCandidate ? variationSeed(nextCandidate) : "");
      setCompareId(null);
      setVariationText("");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function editDraft(next: Draft) {
    if (generationControllersRef.current.has(activePart)) return;
    setDrafts((current) => ({ ...current, [activePart]: next }));
    setDraftDirty((current) => ({ ...current, [activePart]: true }));
    updateDraftCache(projectId, (cache) => { cache.drafts ??= {}; cache.drafts[activePart] = next; });
  }

  function presetPrompt(
    part: StudioArtworkPart,
    presetId: string,
    current: Draft,
    includeMetadata: boolean,
  ) {
    if (!project) return "";
    return buildPresetPrompt(part, presetId, {
      title: project.title,
      artist: project.artist,
      tracks: project.tracks.map((track) => ({ order: track.order, title: track.title })),
      referenceNames: current.referenceFiles.map((filename, index) => referenceName(current, filename, index)),
      includeMetadata,
    });
  }

  function requestPreset(presetId: string) {
    if (busyRef.current || areaBusy || !project) return;
    const result = requestPresetApplication(activePart, presetId, draft.prompt, areaBusy);
    if (result.kind === "blocked") return;
    if (result.kind === "confirm") {
      setPendingPreset(result.pending);
      return;
    }
    const prompt = presetPrompt(result.pending.part, result.pending.presetId, draft, true);
    editDraft({ ...draft, prompt });
    setPendingPreset(null);
    setNotice("추천 프롬프트를 초안에 넣었습니다. 내용을 편집한 뒤 생성 버튼을 눌러 주세요.");
  }

  function resolvePreset(choice: "append" | "replace" | "cancel") {
    if (busyRef.current || areaBusy || !project) return;
    const result = resolvePresetApplication(pendingPreset, activePart, choice, areaBusy);
    if (result.kind === "unchanged") {
      if (choice === "cancel") setPendingPreset(null);
      return;
    }
    if (!pendingPreset) return;
    const current = drafts[pendingPreset.part] ?? freshDraft(project, pendingPreset.part);
    const generated = presetPrompt(
      pendingPreset.part,
      pendingPreset.presetId,
      current,
      result.mode === "replace",
    );
    const applied = applyPresetToDrafts(drafts, pendingPreset, activePart, choice, generated, areaBusy);
    const next = applied.drafts[pendingPreset.part];
    if (!applied.applied || !next) return;
    editDraft(next);
    setPendingPreset(null);
    setNotice("추천 프롬프트를 초안에 반영했습니다. 원하는 대로 더 편집한 뒤 생성 버튼을 눌러 주세요.");
  }

  async function saveDraft() {
    if (busyRef.current || generationControllersRef.current.has(activePart)) return;
    busyRef.current = true;
    setBusy("save");
    setError("");
    try {
      if (await persistDraft(activePart)) setNotice("프롬프트와 참고 이미지를 저장했습니다.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function editPresentation(next: StudioPresentation) {
    if (generationControllersRef.current.has(activePart)) return;
    setPresentations((current) => ({ ...current, [activePart]: next }));
    setPresentationDirty((current) => ({ ...current, [activePart]: true }));
    updateDraftCache(projectId, (cache) => { cache.presentations ??= {}; cache.presentations[activePart] = next; });
  }

  function editTransformNumber(
    key: "offsetXMm" | "offsetYMm" | "scale",
    value: number,
  ) {
    const limits = PRESENTATION_LIMITS[key];
    if (!inRange(value, limits.min, limits.max)) return false;
    editPresentation({ ...presentation, transform: { ...presentation.transform, [key]: value } });
    return true;
  }

  function editFontSize(value: number) {
    const limits = PRESENTATION_LIMITS.fontSizeMm;
    if (!inRange(value, limits.min, limits.max)) return false;
    editPresentation({ ...presentation, overlay: { ...presentation.overlay, fontSizeMm: value } });
    return true;
  }

  async function importArtwork(filename?: string, file?: File) {
    if (busyRef.current || generationControllersRef.current.has(activePart) || (!filename && !file)) return;
    if (file && file.size > MAX_UPLOAD_BYTES) {
      setError("이미지는 파일당 20MB 이하만 업로드할 수 있습니다.");
      return;
    }
    busyRef.current = true;
    setBusy("import");
    setError("");
    setNotice("");
    let uploadedFilename: string | undefined;
    try {
      if (!(await persistPresentation(activePart))) return;
      let assetFilename = filename;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch(`${projectUrl(projectId)}/assets`, { method: "POST", body: form });
        if (!response.ok) throw new Error(await responseError(response, "이미지 업로드 실패"));
        const data = (await response.json()) as { filename?: string };
        if (!data.filename) throw new Error("업로드된 이미지의 파일명을 받지 못했습니다.");
        assetFilename = data.filename;
        uploadedFilename = data.filename;
        setAssets((current) => current.includes(data.filename!) ? current : [data.filename!, ...current]);
      }
      if (!assetFilename) throw new Error("배치할 이미지를 선택하세요.");
      const updated = await patchStudio("import", { part: activePart, filename: assetFilename });
      const imported = studioPart(updated, activePart);
      const chosen = imported.candidates.find((candidate) => candidate.id === imported.selectedCandidateId);
      setPreviewId(chosen?.id ?? null);
      setCompareId(null);
      setVariationBase(chosen ? variationSeed(chosen) : "");
      setVariationText("");
      setPresentations((current) => ({ ...current, [activePart]: freshPresentation(updated, activePart) }));
      setPresentationDirty((current) => ({ ...current, [activePart]: false }));
      updateDraftCache(projectId, (cache) => { delete cache.presentations?.[activePart]; });
      setNotice("이미지를 배치했습니다. A4 미리보기에서 잘림과 위치를 조정할 수 있습니다.");
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "이미지를 배치하지 못했습니다.";
      setError(uploadedFilename
        ? `${detail} 업로드한 파일은 아래 목록에 남아 있으므로 다시 배치할 수 있습니다.`
        : detail);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function uploadReference(file: File | undefined) {
    if (!file || busyRef.current || generationControllersRef.current.has(activePart)) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("참고 이미지는 파일당 20MB 이하만 업로드할 수 있습니다.");
      return;
    }
    busyRef.current = true;
    setBusy("upload");
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${projectUrl(projectId)}/assets`, { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseError(response, "이미지 업로드 실패"));
      const data = (await response.json()) as { filename?: string };
      if (!data.filename) throw new Error("업로드된 이미지의 파일명을 받지 못했습니다.");
      setAssets((current) => current.includes(data.filename!) ? current : [...current, data.filename!]);
      editDraft({ ...draft, referenceFiles: [...draft.referenceFiles, data.filename] });
      setNotice("참고 이미지를 추가했습니다. 아래에서 이름을 붙이면 프롬프트에서 해당 이미지를 정확히 지칭할 수 있습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "이미지를 업로드하지 못했습니다.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function toggleReference(filename: string) {
    if (generationControllersRef.current.has(activePart)) return;
    const has = draft.referenceFiles.includes(filename);
    const nextLabels = { ...draft.referenceLabels };
    if (has) delete nextLabels[filename];
    editDraft({
      ...draft,
      referenceFiles: has ? draft.referenceFiles.filter((file) => file !== filename) : [...draft.referenceFiles, filename],
      referenceLabels: nextLabels,
    });
    setError("");
  }

  function editReferenceLabel(filename: string, value: string) {
    if (generationControllersRef.current.has(activePart)) return;
    const nextLabels = { ...draft.referenceLabels };
    if (value.trim()) nextLabels[filename] = value;
    else delete nextLabels[filename];
    editDraft({ ...draft, referenceLabels: nextLabels });
    setError("");
  }

  function attachGeneration(
    job: BackgroundJob,
    part: StudioArtworkPart,
    restored: boolean,
    descriptor?: Pick<import("@/lib/studio-generation").StudioGenerationJob, "prompt" | "referenceFiles" | "referenceNames" | "parentCandidateId">,
  ) {
    if (!mountedRef.current) return;
    const token = job.id;
    const existing = generationControllersRef.current.get(part);
    existing?.observer?.stop();
    setGenerationJobs((current) => ({ ...current, [part]: {
      token,
      part,
      prompt: descriptor?.prompt ?? "복구된 생성 작업",
      referenceFiles: descriptor?.referenceFiles ?? [],
      referenceNames: descriptor?.referenceNames ?? [],
      parentCandidateId: descriptor?.parentCandidateId,
      startedAt: job.startedAt,
      phase: restored ? "진행 중인 작업을 복구했습니다…" : "서버에서 생성 중…",
      status: "running",
    } }));
    const observer = watchBackgroundJob(job, {
      onEvent: (rawEvent) => {
        const event = rawEvent as StudioImageEvent;
        if (event.type === "status") {
          setGenerationJobs((current) => updateStudioGeneration(current, part, token, { phase: event.message }));
        } else if (event.type === "done") {
          setProject((current) => current
            ? mergeStudioGenerationProject(current, event.project, part, event.candidate)
            : event.project);
          // 복구한 비활성 영역은 사용자가 보고 있던 후보를 바꾸지 않는다.
          if ((!restored || activePartRef.current === part) && activePartRef.current === part) {
            setPreviewId(event.candidate.id);
            setVariationBase(event.candidate.prompt);
            setCompareId(null);
          }
          setAssets((current) => current.includes(event.candidate.filename) ? current : [...current, event.candidate.filename]);
          setGenerationJobs((current) => updateStudioGeneration(current, part, token, { phase: "새 후보를 저장했습니다." }));
        } else if (event.type === "error" && activePartRef.current === part) {
          setError(event.message);
        }
      },
      onReconnect: () => setGenerationJobs((current) => updateStudioGeneration(current, part, token, {
        phase: "서버 작업에 다시 연결하는 중입니다…",
      })),
    });
    generationControllersRef.current.set(part, { token, jobId: job.id, observer });
    void observer.finished.then((terminal) => {
      if (!terminal) return;
      const current = generationControllersRef.current.get(part);
      if (current?.token === token) generationControllersRef.current.delete(part);
      const finishedAt = terminal.finishedAt ?? Date.now();
      setGenerationJobs((jobs) => updateStudioGeneration(jobs, part, token, {
        status: terminal.status,
        error: terminal.error,
        finishedAt,
        phase: terminal.status === "success" ? "완료" : terminal.status === "cancelled" ? "중단됨" : "실패",
        cancelRequested: false,
        ...(terminal.status === "success" ? { notice: "새 후보가 저장됐습니다. 미리본 다음 ‘이 후보 사용’을 눌러 인쇄에 적용하세요." } : {}),
      }));
      setGenerationNow(finishedAt);
    });
  }

  async function generate(parent?: StudioCandidate) {
    if (!project || !jobsReady) return;
    const part = activePart;
    if (generationControllersRef.current.has(part)) return;
    const instruction = variationText.trim();
    const prompt = parent ? `${variationBase.trim()}${VARIATION_SEPARATOR}${instruction}` : draft.prompt.trim();
    if (parent && !instruction) {
      setError("현재 후보에서 바꾸고 싶은 내용을 입력하세요.");
      return;
    }
    if (!prompt) {
      setError("프롬프트를 입력하세요.");
      return;
    }
    const effectiveReferences = parent ?? draft;
    const labelError = referenceLabelError(effectiveReferences);
    if (labelError) {
      setError(labelError);
      return;
    }
    setError("");
    setNotice("");
    const referenceSource = parent ?? draft;
    const parentAlreadyAttached = Boolean(parent && referenceSource.referenceFiles.includes(parent.filename));
    const referenceNames = [
      ...referenceSource.referenceFiles.map((filename, index) => filename === parent?.filename
        ? `${referenceName(referenceSource, filename, index)} (변형 원본)`
        : referenceName(referenceSource, filename, index)),
      ...(parent && !parentAlreadyAttached ? ["변형 원본"] : []),
    ];
    const clientJobId = crypto.randomUUID();
    const token = clientJobId;
    const startedAt = Date.now();
    generationControllersRef.current.set(part, { token });
    setGenerationJobs((current) => beginStudioGeneration(current, {
      token,
      part,
      prompt,
      referenceFiles: [...referenceSource.referenceFiles],
      referenceNames,
      parentCandidateId: parent?.id,
      startedAt,
      phase: "요청을 준비하고 있습니다…",
      status: "running",
    }).jobs);
    setGenerationNow(startedAt);
    try {
      if (busyRef.current) throw new Error("다른 저장 작업이 끝난 뒤 다시 시도해 주세요.");
      busyRef.current = true;
      setBusy("save");
      let preparationError = "";
      const capturePreparationError = (message: string) => { preparationError = message; };
      try {
        if (!parent && !(await persistDraft(part, capturePreparationError))) {
          throw new Error(preparationError || "프롬프트를 저장하지 못했습니다.");
        }
        if (!(await persistPresentation(part, capturePreparationError))) {
          throw new Error(preparationError || "인쇄 설정을 저장하지 못했습니다.");
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
      setGenerationJobs((current) => updateStudioGeneration(current, part, token, {
        phase: "이미지 생성 요청을 보내고 있습니다…",
      }));
      const imageRequest = {
        projectId,
        part,
        prompt,
        referenceFiles: [...referenceSource.referenceFiles],
        referenceLabels: normalizedReferenceLabels(referenceSource),
        ...(parent ? { parentCandidateId: parent.id } : {}),
      };
      // jsonRequestBody keeps the existing 1 MiB validation before starting a server job.
      JSON.parse(jsonRequestBody(imageRequest));
      const job = await startBackgroundJobIfActive("/api/design/image", imageRequest, () => mountedRef.current, clientJobId);
      if (!job) return;
      attachGeneration(job, part, false, {
        prompt,
        referenceFiles: [...referenceSource.referenceFiles],
        referenceNames,
        parentCandidateId: parent?.id,
      });
    } catch (reason) {
      const reservation = generationControllersRef.current.get(part);
      if (reservation?.token === token) generationControllersRef.current.delete(part);
      const finishedAt = Date.now();
      setGenerationJobs((current) => updateStudioGeneration(current, part, token, {
        status: "error",
        error: reason instanceof Error ? reason.message : "이미지 생성 실패",
        finishedAt,
        phase: "실패",
        cancelRequested: false,
      }));
      setGenerationNow(finishedAt);
    }
  }

  async function runAction(
    label: string,
    action: string,
    payload: Record<string, unknown>,
    after?: (updated: AlbumProject) => void,
  ) {
    const actionPart = typeof payload.part === "string" ? payload.part as StudioArtworkPart : null;
    if (busyRef.current || (actionPart
      ? generationControllersRef.current.has(actionPart)
      : generationControllersRef.current.size > 0)) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      if (!(await persistPresentation(activePart))) return;
      const updated = await patchStudio(action, payload);
      after?.(updated);
      setNotice("저장됐습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "작업을 완료하지 못했습니다.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function pickCandidate(candidate: StudioCandidate) {
    if (generationControllersRef.current.has(activePart)) return;
    setPreviewId(candidate.id);
    setVariationBase(variationSeed(candidate));
    setVariationText("");
    setCompareId((current) => current === candidate.id ? null : current);
  }

  function selectCandidate(candidate: StudioCandidate) {
    void runAction("select", "select", { part: activePart, candidateId: candidate.id }, () => setPreviewId(candidate.id));
  }

  function deleteCandidate(candidate: StudioCandidate) {
    if (!window.confirm("이 후보를 기록에서 제거할까요? 원본 이미지 파일은 보존됩니다.")) return;
    void runAction("delete", "delete", { part: activePart, candidateId: candidate.id }, (updated) => {
      const remaining = studioPart(updated, activePart).candidates;
      setPreviewId((current) => current === candidate.id ? remaining.at(-1)?.id ?? null : current);
      if (previewId === candidate.id) setVariationBase(remaining.at(-1) ? variationSeed(remaining.at(-1)!) : "");
      setCompareId((current) => current === candidate.id ? null : current);
    });
  }

  function saveSnapshot() {
    const name = snapshotName.trim() || `디자인 세트 ${(project?.studio?.snapshots.length ?? 0) + 1}`;
    void runAction("snapshot", "snapshot", { name }, () => setSnapshotName(""));
  }

  function restoreSnapshot(id: string) {
    if (!window.confirm("저장된 세트의 후보와 인쇄 설정을 적용할까요? 현재 후보 선택은 세트 내용으로 바뀝니다.")) return;
    void runAction("restore", "restore", { snapshotId: id }, (updated) => {
      const next = studioPart(updated, activePart);
      setPreviewId(next.selectedCandidateId ?? next.candidates.at(-1)?.id ?? null);
      const chosen = next.candidates.find((candidate) => candidate.id === next.selectedCandidateId) ?? next.candidates.at(-1);
      setVariationBase(chosen ? variationSeed(chosen) : "");
      setCompareId(null);
      const nextPresentations: Presentations = {};
      for (const part of STUDIO_ARTWORK_PARTS) nextPresentations[part] = freshPresentation(updated, part);
      setPresentations(nextPresentations);
      setPresentationDirty({});
      updateDraftCache(projectId, (cache) => { cache.presentations = {}; });
    });
  }

  async function cancelGeneration(part: StudioArtworkPart) {
    const reservation = generationControllersRef.current.get(part);
    if (!reservation?.jobId) return;
    setGenerationJobs((current) => updateStudioGeneration(current, part, reservation.token, {
      cancelRequested: true,
      phase: "생성 중단을 요청했습니다…",
    }));
    try {
      await cancelBackgroundJob(projectId, reservation.jobId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "이미지 생성 중단 요청에 실패했습니다.");
    }
  }

  async function openPrint() {
    if (busyRef.current) return;
    if (project && studioSpineNeedsBack(project)) {
      setError("스파인을 인쇄하려면 뒷표지 중앙 이미지도 확정해 주세요.");
      return;
    }
    busyRef.current = true;
    setBusy("print");
    setError("");
    try {
      if (!(await persistDirtyPresentations())) return;
      suppressBeforeUnloadRef.current = true;
      window.location.href = `/album/${encodeURIComponent(projectId)}/print`;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  if (loading) return <p className="py-16 text-center text-sm text-fg-muted">디자인 스튜디오를 불러오는 중…</p>;
  if (loadError || !project) return <p role="alert" className="rounded-xl border border-rose/40 bg-rose/10 p-6 text-sm text-rose">{loadError || "앨범을 찾을 수 없습니다."}</p>;

  const allSelected = selectedStudioParts(project);
  const selectedSpine = selectedStudioCandidate(project, "back-spine");
  const selectedBack = selectedStudioCandidate(project, "back");
  const previewBack = activePart === "back-spine" ? selectedBack : undefined;
  const previewSpine = activePart === "back-spine" ? preview : activePart === "back" ? selectedSpine : undefined;
  const previewSpinePresentation = activePart === "back-spine" ? presentation : studioPart(project, "back-spine").presentation;
  const legacyAvailable = project.artwork.variants.some((variant) => Object.keys(variant.files).length > 0);
  const printSource = project.studio?.printSource ?? "legacy";
  const resolution = preview ? studioPrintResolution(preview, activePart, presentation) : null;
  const comparedResolution = compared ? studioPrintResolution(compared, activePart, presentation) : null;
  const selectedSpineResolution = activePart === "back" && selectedSpine
    ? studioPrintResolution(selectedSpine, "back-spine", studioPart(project, "back-spine").presentation) : null;
  const backMayCropLegacyCandidate = activePart === "back" && preview !== undefined
    && studioBackMayCropLegacyCandidate(preview, presentation);
  const draftLabelError = referenceLabelError(draft);
  const elapsedTime = currentGeneration ? studioGenerationElapsed(currentGeneration, generationNow) : "00:00";
  const generationJobList = STUDIO_ARTWORK_PARTS.flatMap((part) => generationJobs[part] ? [generationJobs[part]!] : []);
  const variationPrompt = `${variationBase.trim()}${VARIATION_SEPARATOR}${variationText.trim()}`;
  const pendingPresetAppendPreview = pendingPreset?.part === activePart
    ? presetPrompt(activePart, pendingPreset.presetId, draft, false)
    : "";
  const pendingPresetReplacePreview = pendingPreset?.part === activePart
    ? presetPrompt(activePart, pendingPreset.presetId, draft, true)
    : "";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-amber">② 디자인 스튜디오</p>
          <h1 className="mt-2 text-2xl font-semibold text-fg">{project.title}</h1>
          <p className="mt-1 text-sm text-fg-muted">이미지를 업로드하거나 생성하고, 영역별로 잘라 배치한 결과를 실제 A4 인쇄 크기로 확인하세요.</p>
        </div>
        <div className="flex gap-2">
          {legacyAvailable && <Link href={`/album/${encodeURIComponent(projectId)}/design/legacy`} className="rounded-lg border border-line px-3 py-2 text-xs text-fg-muted hover:text-fg">기존 3안 보기</Link>}
          <Link href={`/album/${encodeURIComponent(projectId)}/preview`} className="rounded-lg border border-line px-3 py-2 text-xs text-fg-muted hover:text-fg">완성 모습 3D</Link>
          <button type="button" disabled={Boolean(busy)} onClick={() => void openPrint()} className="rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">인쇄 미리보기 →</button>
        </div>
      </header>

      {(error || notice) && <div role={error ? "alert" : "status"} className={`sticky top-2 z-30 rounded-lg border p-3 text-xs shadow-lg backdrop-blur ${error ? "border-rose/50 bg-ink/95 text-rose" : "border-teal/40 bg-ink/95 text-teal"}`}>{error || notice}</div>}
      {!jobsReady && recoveryFailed && <button type="button" onClick={() => setRecoveryAttempt((value) => value + 1)} className="rounded-lg border border-amber/50 px-3 py-2 text-xs text-amber">작업 다시 확인</button>}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/60 p-3 text-xs">
        <span className="text-fg-muted">업로드 이미지와 AI 생성 이미지를 영역마다 함께 사용할 수 있습니다.</span>
        <span className="text-fg-dim">다른 화면으로 이동해도 서버에서 계속 진행됩니다.</span>
        <span className="ml-auto text-fg-dim">인쇄물 {allSelected.length}/5 · 스파인 {selectedSpine ? "확정" : "미선택"}</span>
      </div>

      {generationJobList.length > 0 && <section aria-label="영역별 이미지 생성 작업" aria-live="polite" className="rounded-xl border border-line bg-panel/60 p-3">
        <h2 className="text-xs font-semibold text-fg">이미지 생성 작업</h2>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {generationJobList.map((job) => <li key={job.token} className="flex items-start justify-between gap-2 rounded-lg border border-line bg-ink/40 p-2 text-[11px]">
            <span className="min-w-0">
              <span className="block font-semibold text-fg">{STUDIO_PART_LABELS[job.part]} · {job.status === "running" ? "생성 중" : job.status === "success" ? "완료" : job.status === "cancelled" ? "중단됨" : "실패"}</span>
              <span className={`mt-0.5 block leading-4 ${job.status === "error" || job.status === "cancelled" ? "text-rose" : job.status === "success" ? "text-teal" : "text-fg-dim"}`}>{job.error || job.notice || job.phase}</span>
              <span aria-hidden="true" className="mt-0.5 block font-mono text-fg-dim">{studioGenerationElapsed(job, generationNow)} 경과</span>
            </span>
            {job.status === "running" && <button type="button" disabled={job.cancelRequested} onClick={() => cancelGeneration(job.part)} className="shrink-0 text-rose disabled:opacity-40">{job.cancelRequested ? "중단 중…" : "중단"}</button>}
          </li>)}
        </ul>
      </section>}

      {legacyAvailable && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel/60 p-3 text-xs">
          <span className="text-fg-muted">인쇄할 디자인</span>
          <button type="button" aria-pressed={printSource === "studio"} disabled={Boolean(busy) || anyGenerationRunning || allSelected.length === 0} onClick={() => void runAction("source", "print-source", { printSource: "studio" })} className={`rounded-md border px-3 py-1.5 ${printSource === "studio" ? "border-amber text-amber" : "border-line text-fg-muted"}`}>영역별 스튜디오</button>
          <button type="button" aria-pressed={printSource === "legacy"} disabled={Boolean(busy) || anyGenerationRunning} onClick={() => void runAction("source", "print-source", { printSource: "legacy" })} className={`rounded-md border px-3 py-1.5 ${printSource === "legacy" ? "border-amber text-amber" : "border-line text-fg-muted"}`}>기존 3안</button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[180px_minmax(0,1fr)_275px]">
        <nav aria-label="아트워크 영역" className="space-y-2 lg:sticky lg:top-6 lg:self-start">
          {STUDIO_ARTWORK_PARTS.map((part) => {
            const current = studioPart(project, part);
            const chosen = selectedStudioCandidate(project, part);
            const job = generationJobs[part];
            return (
              <button key={part} type="button" disabled={Boolean(busy)} onClick={() => void switchPart(part)} aria-current={part === activePart ? "true" : undefined} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${part === activePart ? "border-amber/70 bg-amber/10" : "border-line bg-panel/60 hover:border-line-strong"}`}>
                <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-panel-2">
                  {chosen && (
                    <AssetThumbnail projectId={projectId} filename={chosen.filename} alt="" sizes="40px" className="object-cover" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-fg">{STUDIO_PART_LABELS[part]}</span>
                  <span className={`block text-[10px] ${job?.status === "error" || job?.status === "cancelled" ? "text-rose" : job?.status === "running" ? "text-amber" : job?.status === "success" || chosen ? "text-teal" : "text-fg-dim"}`}>{job?.status === "running" ? (job.cancelRequested ? "중단 요청 중" : "생성 중") : job?.status === "error" ? "생성 실패" : job?.status === "cancelled" ? "생성 중단" : job?.status === "success" ? "생성 완료" : chosen ? "확정" : `${current.candidates.length}개 후보`}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <main className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1 xl:col-start-2 xl:row-start-1">
          <section className="rounded-xl border border-line bg-panel/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-fg">{STUDIO_PART_LABELS[activePart]}</h2>
                <p className="text-xs text-fg-dim">{activePart === "label" ? "Ø116mm · 중앙 홀 Ø23mm" : activePart === "back" ? "137×118mm · 스파인 제외 중앙 영역" : `${partDimensions(activePart).width}×${partDimensions(activePart).height}mm`}{activePart === "back-spine" ? " · 같은 이미지를 좌우에 적용" : ""}</p>
              </div>
              {resolution && <span className={`text-xs ${resolution.grade === "target" ? "text-fg-dim" : "text-amber"}`}>인쇄 이미지 {resolution.widthPx}×{resolution.heightPx}px · {resolution.widthMm}×{resolution.heightMm}mm · 약 {resolution.ppi}PPI{resolution.grade !== "target" ? ` · 300PPI 목표 미달${resolution.grade === "low" ? " (저해상도)" : ""}` : " · 목표 충족"}</span>}
            </div>
            {selectedSpineResolution && <p className={`mt-2 text-xs ${selectedSpineResolution.grade === "target" ? "text-fg-dim" : "text-amber"}`}>선택한 스파인 인쇄 이미지 {selectedSpineResolution.widthPx}×{selectedSpineResolution.heightPx}px · 6.5×118mm · 약 {selectedSpineResolution.ppi}PPI{selectedSpineResolution.grade !== "target" ? ` · 300PPI 목표 미달${selectedSpineResolution.grade === "low" ? " (저해상도)" : ""}` : " · 목표 충족"}</p>}
            {resolution && !resolution.fullBleed && <p role="alert" className="mt-2 text-xs text-amber">여백 가능: 현재 축소·이동 설정으로 이미지가 인쇄 영역을 끝까지 채우지 못할 수 있습니다.</p>}
            {selectedSpineResolution && !selectedSpineResolution.fullBleed && <p role="alert" className="mt-2 text-xs text-amber">선택한 스파인 여백 가능: 스파인 배치를 확인하세요.</p>}
            {backMayCropLegacyCandidate && <p role="alert" className="mt-2 text-xs text-amber">기존 풀폭 뒷표지 이미지는 137mm 중앙 영역에 맞출 때 양옆이 잘릴 수 있습니다. ‘이미지 전체 보기’로 전환하거나 새 규격으로 다시 생성하세요.</p>}
            {resolution && <p className="mt-2 text-[11px] text-fg-dim">PPI는 현재 배율의 인쇄 픽셀 밀도 추정치입니다. ‘이미지 전체 보기’는 흐린 배경까지 고려한 보수적 값입니다. 의도한 소프트포커스 연출이나 AI가 그린 세부묘사의 정확도와는 별개입니다.</p>}
            {preview ? (
              <div className="mt-4 flex flex-wrap justify-center gap-3 overflow-x-auto rounded-lg bg-ink/70 p-4">
                <div>
                  <p className="mb-2 text-center text-[11px] text-fg-dim">{preview.id === selected?.id ? "현재 인쇄에 사용" : "미리보는 후보"}</p>
                  {activePart === "back-spine" && <SpineOriginalPreview projectId={projectId} candidate={preview} label="미리보는 스파인 후보" />}
                  <ArtworkSheetPreview project={project} part={previewBack ? "back" : activePart} candidate={previewBack ?? preview} presentation={previewBack ? studioPart(project, "back").presentation : presentation} spineCandidate={previewSpine} spinePresentation={previewSpine ? previewSpinePresentation : undefined} guides screenScale={compared ? 0.31 : 0.43} onOverflow={setPreviewOverflow} />
                </div>
                {compared && <div>
                  <p className="mb-2 text-center text-[11px] text-fg-dim">비교 후보</p>
                  {comparedResolution && <p className={`mb-2 text-center text-[11px] ${comparedResolution.grade === "target" ? "text-fg-dim" : "text-amber"}`}>{compared.width}×{compared.height}px · 약 {comparedResolution.ppi}PPI{comparedResolution.grade !== "target" ? " · 300PPI 목표 미달" : ""}</p>}
                  {comparedResolution && !comparedResolution.fullBleed && <p className="mb-2 text-center text-[11px] text-amber">비교 후보 여백 가능</p>}
                  {activePart === "back-spine" && <SpineOriginalPreview projectId={projectId} candidate={compared} label="비교 스파인 후보" />}
                  <ArtworkSheetPreview project={project} part={previewBack ? "back" : activePart} candidate={previewBack ?? compared} presentation={previewBack ? studioPart(project, "back").presentation : presentation} spineCandidate={activePart === "back-spine" ? compared : previewSpine} spinePresentation={previewSpinePresentation} guides screenScale={0.31} />
                </div>}
              </div>
            ) : <div className="mt-4 rounded-lg border border-dashed border-line px-4 py-28 text-center text-sm text-fg-dim">이 영역에 사용할 이미지를 업로드하거나 생성해 보세요.</div>}
            {activePart === "back-spine" && preview && !selectedBack && <p className="mt-2 text-center text-xs text-amber">뒷표지 중앙 후보를 확정하면 150×118mm 트레이카드 합성 미리보기가 표시됩니다.</p>}
            {preview && <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={areaBusy || preview.id === selected?.id} onClick={() => selectCandidate(preview)} className="rounded-lg bg-amber px-4 py-2 text-xs font-semibold text-ink disabled:opacity-40">이 후보 사용</button>
              {selected && <button type="button" disabled={areaBusy} onClick={() => void runAction("clear", "clear", { part: activePart })} className="rounded-lg border border-line px-3 py-2 text-xs text-fg-muted disabled:opacity-40">선택 해제</button>}
              {compared && <button type="button" disabled={areaBusy} onClick={() => setCompareId(null)} className="rounded-lg border border-line px-3 py-2 text-xs text-fg-muted disabled:opacity-40">비교 닫기</button>}
            </div>}
            {previewOverflow && <p role="alert" className="mt-3 text-xs text-rose">글자가 재단 영역을 벗어납니다. 인쇄 배치에서 글자 크기를 줄이거나 글자를 끄세요.</p>}
          </section>

          <section className="rounded-xl border border-line bg-panel/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-fg">이미지 후보 <span className="text-fg-dim">{candidates.length}</span></h3>
              <p className="text-[11px] text-fg-dim">업로드는 즉시 적용되고, AI 생성 후보는 선택 후 적용됩니다.</p>
            </div>
            {candidates.length === 0 ? <p className="mt-4 text-xs text-fg-dim">아직 후보가 없습니다.</p> : (
              <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
                {candidates.map((candidate, index) => {
                  const candidateNumber = candidates.length - index;
                  const candidateSource = candidate.source === "upload" ? "내 이미지" : "AI 생성";
                  return (
                  <div key={candidate.id} className={`w-28 shrink-0 rounded-lg border p-1.5 ${candidate.id === preview?.id ? "border-amber" : "border-line"}`}>
                    <button type="button" disabled={areaBusy} onClick={() => pickCandidate(candidate)} className="relative block h-24 w-full overflow-hidden rounded bg-ink disabled:cursor-not-allowed disabled:opacity-40" aria-label={`${STUDIO_PART_LABELS[activePart]} 후보 ${candidateNumber}, ${candidateSource} 미리보기`} title={`${candidate.prompt}${candidate.referenceFiles.length ? `\n참고: ${candidate.referenceFiles.map((filename, referenceIndex) => `[${referenceName(candidate, filename, referenceIndex)}]`).join(", ")}` : ""}`}>
                      <AssetThumbnail projectId={projectId} filename={candidate.filename} alt="" sizes="112px" className="object-cover" />
                    </button>
                    <div className="mt-1 flex items-center justify-between gap-1 text-[10px]">
                      <span className={candidate.id === selected?.id ? "text-teal" : "text-fg-dim"}>{candidate.id === selected?.id ? "사용 중" : new Date(candidate.createdAt).toLocaleDateString("ko-KR")}</span>
                      <button type="button" disabled={areaBusy} aria-pressed={Boolean(candidate.favorite)} aria-label={`후보 ${candidateNumber}, ${candidateSource} ${candidate.favorite ? "즐겨찾기 해제" : "즐겨찾기"}`} onClick={() => void runAction("favorite", "favorite", { part: activePart, candidateId: candidate.id, favorite: !candidate.favorite })} className={`flex min-h-7 min-w-7 items-center justify-center text-sm ${candidate.favorite ? "text-amber" : "text-fg-dim"}`}>★</button>
                    </div>
                    <span className="mt-0.5 block text-[10px] text-fg-dim">후보 {candidateNumber} · {candidateSource}</span>
                    {candidate.referenceFiles.length > 0 && <span className="mt-0.5 block truncate text-[10px] text-fg-dim" title={candidate.referenceFiles.map((filename, index) => `[${referenceName(candidate, filename, index)}]`).join(", ")}>참고 {candidate.referenceFiles.map((filename, index) => `[${referenceName(candidate, filename, index)}]`).join(", ")}</span>}
                    <div className="mt-1 flex justify-between text-[10px] text-fg-muted">
                      <button type="button" disabled={areaBusy || candidate.id === preview?.id} onClick={() => setCompareId(candidate.id)} aria-label={`후보 ${candidateNumber}, ${candidateSource} 비교`} className="min-h-7 min-w-7 px-1">비교</button>
                      <button type="button" disabled={areaBusy} onClick={() => deleteCandidate(candidate)} aria-label={`후보 ${candidateNumber}, ${candidateSource} 삭제`} className="min-h-7 min-w-7 px-1 hover:text-rose">삭제</button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </section>
        </main>

        <aside className="space-y-4 lg:col-start-2 lg:row-start-2 xl:sticky xl:top-6 xl:col-start-3 xl:row-start-1 xl:self-start">
          <section className="rounded-xl border border-line bg-panel/60 p-4">
            <h3 className="text-sm font-semibold text-fg">내 이미지로 제작</h3>
            <p className="mt-1 text-[11px] leading-5 text-fg-dim">{STUDIO_PART_LABELS[activePart]}에 이미지를 바로 배치합니다. 업로드와 인쇄에는 Codex 연결이 필요하지 않습니다.</p>
            <label className={`mt-3 block rounded-lg bg-amber px-3 py-2.5 text-center text-xs font-semibold text-ink ${areaBusy ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}>
              {busy === "import" ? "이미지 배치 중…" : "이미지 업로드하여 바로 배치"}
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={areaBusy} className="sr-only" onChange={(event) => { void importArtwork(undefined, event.target.files?.[0]); event.target.value = ""; }} />
            </label>
            <p className="mt-2 text-[11px] text-fg-dim">PNG · JPEG · WebP, 파일당 최대 20MB(요청당 총 20MB). 원본은 보존되며 잘림과 위치는 아래 ‘인쇄 배치’에서 조정합니다.</p>
            {assets.length > 0 && <div className="mt-3 border-t border-line pt-3">
              <p className="mb-2 text-[11px] text-fg-muted">이미 업로드한 이미지 다시 배치</p>
              <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto">
                {assets.map((filename) => <button key={filename} type="button" disabled={areaBusy} onClick={() => void importArtwork(filename)} title={candidateName.get(filename) ?? filename} className="group relative h-16 w-16 overflow-hidden rounded-md border border-line bg-ink disabled:opacity-40" aria-label={`${candidateName.get(filename) ?? filename} 배치`}>
                  <AssetThumbnail projectId={projectId} filename={filename} alt="" sizes="64px" className="object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-ink/85 px-1 py-0.5 text-[9px] text-white group-hover:text-amber">배치</span>
                </button>)}
              </div>
            </div>}
          </section>

          <section className="rounded-xl border border-line bg-panel/60 p-4">
            <h3 className="text-sm font-semibold text-fg">AI 이미지 생성</h3>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-dim"><span className={`h-2 w-2 rounded-full ${connection?.available ? "bg-teal" : "bg-rose"}`} /><span>{connection?.message ?? "Codex 연결 상태 확인 중…"}</span></div>
            <DesignPresetPicker
              part={activePart}
              disabled={areaBusy}
              pendingPresetId={pendingPreset?.part === activePart ? pendingPreset.presetId : null}
              appendPreviewPrompt={pendingPresetAppendPreview}
              replacePreviewPrompt={pendingPresetReplacePreview}
              onRequest={requestPreset}
              onResolve={resolvePreset}
            />
            <label htmlFor="studio-prompt" className="mt-3 block text-xs text-fg-muted">{STUDIO_PART_LABELS[activePart]} 프롬프트</label>
            <textarea id="studio-prompt" value={draft.prompt} disabled={areaBusy} onChange={(event) => editDraft({ ...draft, prompt: event.target.value })} rows={5} placeholder="예: [인물]을 왼쪽에, [배경]을 뒤에 배치해 주세요." className="mt-1 w-full resize-y rounded-lg border border-line bg-ink/80 p-2.5 text-xs leading-5 text-fg outline-none focus:border-amber/60" />
            <p className="mt-1 text-[11px] leading-5 text-fg-dim">이미지에 넣을 제목·아티스트·트랙리스트도 프롬프트에 적을 수 있습니다. 생성 후 글자와 순서를 꼭 확인하세요.</p>
            <p className="mt-1 text-right font-mono text-[10px] text-fg-dim">{draft.prompt.length}자 · UTF-8 {utf8Bytes(draft.prompt).toLocaleString("ko-KR")}바이트</p>
            <p className="mt-1 text-[10px] leading-4 text-fg-dim">프롬프트 글자 수 제한은 없습니다. 참고 이미지 이름 등을 포함한 요청 전체가 UTF-8 기준 1MiB를 넘으면 전송 전에 알려드립니다.</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-xs text-fg-muted">AI 생성용 참고 이미지 · {draft.referenceFiles.length}장 선택</span>
              <label className={`cursor-pointer text-xs text-amber ${areaBusy ? "opacity-40" : ""}`}>
                업로드
                <input type="file" accept="image/png,image/jpeg,image/webp" disabled={areaBusy} className="sr-only" onChange={(event) => { void uploadReference(event.target.files?.[0]); event.target.value = ""; }} />
              </label>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-fg-dim">참고 이미지 장수 제한은 없습니다. 이미지가 많으면 업로드와 생성 준비에 더 오래 걸릴 수 있습니다.</p>
            <div className="mt-2 flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {assets.length === 0 && <span className="text-[11px] text-fg-dim">업로드하면 여기에서 선택할 수 있습니다.</span>}
              {assets.map((filename) => <button key={filename} type="button" disabled={areaBusy} onClick={() => toggleReference(filename)} aria-pressed={draft.referenceFiles.includes(filename)} title={filename} className={`relative h-14 w-14 overflow-hidden rounded-md border ${draft.referenceFiles.includes(filename) ? "border-amber ring-1 ring-amber" : "border-line"}`}>
                <AssetThumbnail projectId={projectId} filename={filename} alt={candidateName.get(filename) ?? filename} sizes="56px" className="object-cover" />
                {candidateName.has(filename) && <span className="absolute inset-x-0 bottom-0 truncate bg-ink/80 px-1 text-[8px] text-white">{candidateName.get(filename)}</span>}
              </button>)}
            </div>
            {draft.referenceFiles.length > 0 && <div className="mt-3 space-y-2">
              <p className="text-[11px] leading-5 text-fg-dim">각 이미지에 임시 이름을 붙이고 프롬프트에서 <span className="font-mono text-amber">[인물]</span>처럼 적으세요. 이름을 비우면 선택 순서에 따라 <span className="font-mono text-amber">[이미지 1]</span>처럼 사용할 수 있습니다.</p>
              {draft.referenceFiles.map((filename, index) => <div key={filename} className="flex items-center gap-2 rounded-lg border border-line bg-ink/50 p-2">
                <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded"><AssetThumbnail projectId={projectId} filename={filename} alt="" sizes="48px" className="object-cover" /></span>
                <label className="min-w-0 flex-1 text-[10px] text-fg-dim">참고 이미지 {index + 1} · 프롬프트 이름
                  <input type="text" value={draft.referenceLabels?.[filename] ?? ""} maxLength={MAX_REFERENCE_LABEL} disabled={areaBusy} onChange={(event) => editReferenceLabel(filename, event.target.value)} placeholder={`이미지 ${index + 1}`} aria-label={`참고 이미지 ${index + 1}의 임시 이름`} className="mt-1 block w-full rounded border border-line bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-amber/60" />
                </label>
                <button type="button" disabled={areaBusy} onClick={() => toggleReference(filename)} aria-label={`참고 이미지 ${index + 1} 선택 해제`} className="shrink-0 text-xs text-fg-muted hover:text-rose disabled:opacity-40">제외</button>
              </div>)}
              {draftLabelError && <p role="alert" className="text-[11px] text-rose">{draftLabelError}</p>}
            </div>}
            <button type="button" disabled={areaBusy || !draftDirty[activePart] || Boolean(draftLabelError)} onClick={() => void saveDraft()} className="mt-2 text-[11px] text-amber disabled:opacity-40">프롬프트·참고 이미지 저장</button>
            <button type="button" disabled={areaBusy || !connection?.available || !draft.prompt.trim() || Boolean(draftLabelError)} onClick={() => void generate()} className="mt-4 w-full rounded-lg bg-amber px-3 py-2.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40">{currentGenerationRunning ? "생성 중…" : "새 후보 생성 / 같은 조건 재시도"}</button>
            {preview && <div className="mt-4 border-t border-line pt-4">
              <p className="mb-2 text-[11px] leading-5 text-fg-dim">변형할 이미지는 <span className="font-mono text-amber">[변형 원본]</span>입니다.{preview.referenceFiles.length > 0 ? ` 기존 참고 이미지: ${preview.referenceFiles.map((filename, index) => `[${referenceName(preview, filename, index)}]`).join(", ")}` : ""}</p>
              <label htmlFor="variation-base" className="text-xs text-fg-muted">변형 기준 프롬프트</label>
              <textarea id="variation-base" value={variationBase} disabled={areaBusy} onChange={(event) => setVariationBase(event.target.value)} rows={3} className="mt-1 w-full resize-y rounded-lg border border-line bg-ink/80 p-2 text-xs text-fg outline-none focus:border-amber/60" />
              <label htmlFor="variation-instruction" className="mt-2 block text-xs text-fg-muted">미리보는 후보에서 바꿀 점</label>
              <textarea id="variation-instruction" value={variationText} disabled={areaBusy} onChange={(event) => setVariationText(event.target.value)} rows={2} placeholder="예: 붉은색을 줄이고 인물을 작게" className="mt-1 w-full resize-y rounded-lg border border-line bg-ink/80 p-2 text-xs text-fg outline-none focus:border-amber/60" />
              <p className="mt-1 text-right font-mono text-[10px] text-fg-dim">{variationPrompt.length}자 · UTF-8 {utf8Bytes(variationPrompt).toLocaleString("ko-KR")}바이트</p>
              <button type="button" disabled={areaBusy || !connection?.available || !variationBase.trim() || !variationText.trim()} onClick={() => void generate(preview)} className="mt-2 w-full rounded-lg border border-amber/50 px-3 py-2 text-xs text-amber disabled:opacity-40">이 후보에서 변형</button>
            </div>}
            {currentGeneration && <div className={`mt-3 rounded-lg border p-3 ${currentGeneration.status === "error" || currentGeneration.status === "cancelled" ? "border-rose/40 bg-rose/5" : currentGeneration.status === "success" ? "border-teal/40 bg-teal/5" : "border-amber/40 bg-amber/5"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p role={currentGeneration.status === "error" ? "alert" : "status"} className="min-w-0 flex-1 text-xs font-semibold leading-5 text-fg">{currentGeneration.error || currentGeneration.notice || currentGeneration.phase}</p>
                <span aria-hidden="true" className="shrink-0 font-mono text-xs text-amber">{elapsedTime} 경과</span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-fg-dim">이미지 생성에는 몇 분 걸릴 수 있습니다. 가능한 높은 원본 해상도를 요청하며, 완료 후 실제 픽셀 수와 인쇄 PPI를 확인할 수 있습니다.</p>
                  <p className="mt-1 text-[11px] leading-5 text-fg-dim">{restoredGenerationPartsRef.current.has(activePart) && currentGeneration.referenceNames.length === 0 ? "복구된 작업 · 참고 이미지 정보는 이 화면에서 확인할 수 없습니다." : currentGeneration.referenceNames.length > 0 ? `참고: ${currentGeneration.referenceNames.map((name) => `[${name}]`).join(" · ")}` : "참고 이미지: 없음"}</p>
              {currentGeneration.status === "running" && <button type="button" disabled={currentGeneration.cancelRequested} onClick={() => cancelGeneration(activePart)} className="mt-3 rounded-md border border-rose/50 px-3 py-1.5 text-xs text-rose disabled:opacity-40">{currentGeneration.cancelRequested ? "중단 요청 중…" : "생성 중단"}</button>}
            </div>}
          </section>

          <section className="rounded-xl border border-line bg-panel/60 p-4">
            <h3 className="text-sm font-semibold text-fg">인쇄 배치</h3>
            <p className="mt-1 text-[11px] text-fg-dim">이미지를 잘라 영역에 맞추고 A4 미리보기와 출력에 같이 적용합니다. 원본 파일은 보존됩니다.</p>
            <div className="mt-3 flex gap-1">
              {(["cover", "contain"] as const).map((fit) => <button key={fit} type="button" aria-pressed={presentation.fit === fit} disabled={areaBusy} onClick={() => editPresentation({ ...presentation, fit })} className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] ${presentation.fit === fit ? "border-amber text-amber" : "border-line text-fg-muted"}`}>{fit === "cover" ? "규격에 맞춰 자르기" : "이미지 전체 보기"}</button>)}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              {(["offsetXMm", "offsetYMm", "scale"] as const).map((key) => <label key={key} className="text-fg-dim">{key === "offsetXMm" ? "좌우 mm" : key === "offsetYMm" ? "상하 mm" : "확대 배율"}<input type="number" step={key === "scale" ? 0.05 : 0.5} min={PRESENTATION_LIMITS[key].min} max={PRESENTATION_LIMITS[key].max} value={presentation.transform[key]} disabled={areaBusy} onChange={(event) => { if (!editTransformNumber(key, event.currentTarget.valueAsNumber)) event.currentTarget.value = String(presentation.transform[key]); }} className="mt-1 w-full rounded border border-line bg-ink/80 px-1.5 py-1 text-xs text-fg" /></label>)}
            </div>
            <button type="button" disabled={areaBusy || (presentation.fit === "cover" && presentation.transform.offsetXMm === 0 && presentation.transform.offsetYMm === 0 && presentation.transform.scale === 1)} onClick={() => editPresentation({ ...presentation, fit: "cover", transform: { offsetXMm: 0, offsetYMm: 0, scale: 1 } })} className="mt-2 text-[11px] text-amber disabled:opacity-40">잘림·위치 초기화</button>
            <label className="mt-4 flex items-center gap-2 text-xs text-fg-muted"><input type="checkbox" checked={presentation.overlay.enabled} disabled={areaBusy} onChange={(event) => editPresentation({ ...presentation, overlay: { ...presentation.overlay, enabled: event.target.checked } })} /> {activePart === "back" || activePart === "back-inner" ? "앨범명·아티스트·트랙리스트 추가 표시" : "앨범명·아티스트 글자 표시"}</label>
            {(activePart === "back" || activePart === "back-inner") && <p className="mt-1 text-[11px] leading-5 text-fg-dim">켜면 앨범에 등록된 오디오 트랙명을 이미지 위에 추가해 A4 미리보기·인쇄에 표시합니다. 프롬프트에 적은 세트리스트를 옮기는 기능은 아닙니다. 생성 이미지에 이미 같은 목록이 있으면 중복될 수 있습니다.</p>}
            {presentation.overlay.enabled && <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <label className="text-fg-dim">글자색<input type="color" value={presentation.overlay.color} disabled={areaBusy} onChange={(event) => editPresentation({ ...presentation, overlay: { ...presentation.overlay, color: event.target.value } })} className="mt-1 block h-8 w-full rounded border border-line bg-ink" /></label>
              <label className="text-fg-dim">위치<select value={presentation.overlay.position} disabled={areaBusy} onChange={(event) => editPresentation({ ...presentation, overlay: { ...presentation.overlay, position: event.target.value as "top" | "bottom" } })} className="mt-1 block h-8 w-full rounded border border-line bg-ink px-1 text-xs text-fg"><option value="top">위</option><option value="bottom">아래</option></select></label>
              <label className="text-fg-dim">글자 mm<input type="number" min={PRESENTATION_LIMITS.fontSizeMm.min} max={PRESENTATION_LIMITS.fontSizeMm.max} step={0.5} value={presentation.overlay.fontSizeMm} disabled={areaBusy} onChange={(event) => { if (!editFontSize(event.currentTarget.valueAsNumber)) event.currentTarget.value = String(presentation.overlay.fontSizeMm); }} className="mt-1 h-8 w-full rounded border border-line bg-ink px-1 text-xs text-fg" /></label>
            </div>}
            {presentation.overlay.enabled && activePart === "label" && project.title.length > 45 && <p className="mt-2 text-[11px] text-amber">제목이 길어 라벨의 글자가 잘릴 수 있습니다. 미리보기를 확인하세요.</p>}
            {presentation.overlay.enabled && (activePart === "back" || activePart === "back-inner") && project.tracks.length > 60 && <p className="mt-2 text-[11px] text-amber">트랙이 많아 인쇄 글자가 매우 작아질 수 있습니다. PDF에서 읽기성을 확인하세요.</p>}
            <button type="button" disabled={areaBusy || !presentationDirty[activePart]} onClick={() => void runAction("presentation", "presentation", { part: activePart, presentation })} className="mt-3 w-full rounded-lg border border-line px-3 py-2 text-xs text-fg-muted disabled:opacity-40">인쇄 설정 저장</button>
          </section>
        </aside>
      </div>

      <section className="rounded-xl border border-line bg-panel/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="text-sm font-semibold text-fg">디자인 세트</h2><p className="mt-1 text-[11px] text-fg-dim">현재 확정한 영역과 인쇄 배치를 한 묶음으로 저장합니다.</p></div>
          <div className="flex gap-2"><input value={snapshotName} disabled={Boolean(busy) || anyGenerationRunning} onChange={(event) => setSnapshotName(event.target.value)} maxLength={80} placeholder="세트 이름" aria-label="세트 이름" className="w-36 rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-fg" /><button type="button" disabled={Boolean(busy) || anyGenerationRunning || allSelected.length === 0} onClick={saveSnapshot} className="rounded-md border border-amber/50 px-3 py-1.5 text-xs text-amber disabled:opacity-40">현재 조합 저장</button></div>
        </div>
        {(project.studio?.snapshots.length ?? 0) > 0 && <div className="mt-3 flex flex-wrap gap-2">{project.studio!.snapshots.map((snapshot) => <div key={snapshot.id} className="flex items-center gap-2 rounded-lg border border-line bg-ink/50 px-3 py-2 text-xs"><span className="text-fg">{snapshot.name}</span><span className="text-fg-dim">{Object.keys(snapshot.parts).length}영역</span><button type="button" disabled={Boolean(busy) || anyGenerationRunning} onClick={() => restoreSnapshot(snapshot.id)} className="text-amber disabled:opacity-40">복원</button><button type="button" disabled={Boolean(busy) || anyGenerationRunning} onClick={() => { if (window.confirm("이 디자인 세트를 삭제할까요?")) void runAction("delete-snapshot", "delete-snapshot", { snapshotId: snapshot.id }); }} className="text-rose disabled:opacity-40">삭제</button></div>)}</div>}
      </section>
    </div>
  );
}
