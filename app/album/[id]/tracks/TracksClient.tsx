"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AlbumProject,
  ExtractEvent,
  ProbeItem,
  ProbeResult,
  Track,
} from "@/lib/types";
import {
  DEFAULT_BURN_PREGAP_SEC,
  discOccupancySec,
  MAX_AUDIO_MINUTES,
  MAX_BURN_TRACKS,
  formatDuration,
  totalDurationSec,
} from "@/lib/types";
import {
  initialExtractSelection,
  MAX_EXTRACT_ITEMS,
} from "@/lib/extract-contract";

const WARN_SECONDS = 74 * 60; // 74분 경고
const MAX_SECONDS = MAX_AUDIO_MINUTES * 60; // 79분 초과 차단

/** 서버가 플레이리스트 항목 상한으로 잘라냈는지 알려주는 확장 필드 (lib/audio.ts) */
type ProbeResultView = ProbeResult & { truncated?: boolean; totalItems?: number };

interface InProgress {
  trackId: string;
  title: string;
  phase: "download" | "convert";
  percent: number;
  retry?: { attempt: number; maxAttempts: number };
  error?: string;
}

export default function TracksClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResultView | null>(null);
  const [selected, setSelected] = useState<boolean[]>([]);

  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState<InProgress[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingTracks, setPendingTracks] = useState<Track[] | null>(null);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    trackId: string;
    position: "before" | "after";
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const dragIntentRef = useRef<string | null>(null);

  // ── 프로젝트 로드 ─────────────────────────────────────────
  // (setState 는 콜백 안에서만 호출 — 이펙트 본문 동기 setState 경고 회피)
  const loadProject = useCallback(
    () =>
      fetch(`/api/projects/${projectId}`, { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error(`프로젝트 로드 실패 (${res.status})`);
          return res.json() as Promise<AlbumProject>;
        })
        .then((data) => {
          setProject(data);
          setTracks([...data.tracks].sort((a, b) => a.order - b.order));
          setLoadError(null);
          return true;
        })
        .catch((err: unknown) => {
          setLoadError(err instanceof Error ? err.message : String(err));
          return false;
        }),
    [projectId],
  );

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  // 언마운트 시 추출 스트림 중단
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // ── 메타 조회 ─────────────────────────────────────────────
  async function handleProbe() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setProbing(true);
    setProbeError(null);
    setExtractError(null);
    setProbeResult(null);
    try {
      const res = await fetch("/api/extract/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `조회 실패 (${res.status})`);
      const result = data as ProbeResultView;
      setProbeResult(result);
      setSelected(initialExtractSelection(result.items.length));
      if (result.items.length > MAX_EXTRACT_ITEMS) {
        setExtractError(
          `한 번에 최대 ${MAX_EXTRACT_ITEMS}곡까지 추출할 수 있어 앞의 ${MAX_EXTRACT_ITEMS}곡만 선택했습니다.`,
        );
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }

  function toggleSelect(idx: number) {
    if (!selected[idx] && selected.filter(Boolean).length >= MAX_EXTRACT_ITEMS) {
      setExtractError(`한 번에 최대 ${MAX_EXTRACT_ITEMS}곡까지 선택할 수 있습니다.`);
      return;
    }
    setExtractError(null);
    setSelected((prev) => prev.map((v, i) => (i === idx ? !v : v)));
  }
  function setAllSelected(value: boolean) {
    setSelected((prev) =>
      prev.map((_, index) => value && index < MAX_EXTRACT_ITEMS),
    );
    setExtractError(
      value && (probeResult?.items.length ?? 0) > MAX_EXTRACT_ITEMS
        ? `한 번에 최대 ${MAX_EXTRACT_ITEMS}곡까지만 선택했습니다.`
        : null,
    );
  }

  // ── 추출 시작 (SSE) ───────────────────────────────────────
  async function handleExtract() {
    if (!probeResult) return;
    const items: ProbeItem[] = probeResult.items.filter((_, i) => selected[i]);
    if (items.length === 0) {
      setExtractError("선택된 곡이 없습니다");
      return;
    }
    if (items.length > MAX_EXTRACT_ITEMS) {
      setExtractError(`한 번에 최대 ${MAX_EXTRACT_ITEMS}곡까지 추출할 수 있습니다.`);
      return;
    }
    if (saving || editingTrackId) {
      setExtractError("트랙 변경 저장을 마친 뒤 추출을 시작해 주세요.");
      return;
    }
    setExtracting(true);
    setExtractError(null);
    setInProgress([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, items }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => "");
        let msg = "";
        try {
          const parsed = JSON.parse(raw) as { error?: unknown };
          if (typeof parsed?.error === "string") msg = parsed.error;
        } catch {
          msg = raw;
        }
        throw new Error(msg || `추출 요청 실패 (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(5).trim()) as ExtractEvent;
            handleEvent(event);
          } catch {
            /* 부분 프레임 무시 */
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // 사용자 중단 — 조용히 종료
      } else {
        setExtractError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setExtracting(false);
      abortRef.current = null;
      // 서버 최종 상태와 동기화
      void loadProject();
    }
  }

  function handleEvent(event: ExtractEvent) {
    switch (event.type) {
      case "track-start":
        setInProgress((prev) => [
          ...prev.filter((p) => p.trackId !== event.trackId),
          {
            trackId: event.trackId,
            title: event.title,
            phase: "download",
            percent: 0,
          },
        ]);
        break;
      case "progress":
        setInProgress((prev) =>
          prev.map((p) =>
            p.trackId === event.trackId
              ? { ...p, phase: event.phase, percent: event.percent, retry: undefined }
              : p,
          ),
        );
        break;
      case "track-retry":
        setInProgress((prev) =>
          prev.map((p) =>
            p.trackId === event.trackId
              ? {
                  ...p,
                  phase: "download",
                  percent: 0,
                  retry: { attempt: event.attempt, maxAttempts: event.maxAttempts },
                  error: undefined,
                }
              : p,
          ),
        );
        break;
      case "track-done":
        setInProgress((prev) => prev.filter((p) => p.trackId !== event.trackId));
        setTracks((prev) =>
          [...prev.filter((t) => t.id !== event.track.id), event.track].sort(
            (a, b) => a.order - b.order,
          ),
        );
        break;
      case "track-error":
        setInProgress((prev) =>
          prev.map((p) =>
            p.trackId === event.trackId
              ? { ...p, retry: undefined, error: event.message }
              : p,
          ),
        );
        break;
      case "done":
        setProject(event.project);
        setTracks([...event.project.tracks].sort((a, b) => a.order - b.order));
        break;
      case "error":
        setExtractError(event.message);
        break;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setInProgress([]);
    setExtractError("추출을 중단했습니다.");
  }

  // ── 트랙 편집 (이름/순서/삭제) ───────────────────────────
  /** 저장 실패 시 이전 상태로 롤백하고 한국어 오류를 표시한다 (재시도 가능) */
  async function persistTracks(next: Track[]) {
    if (saving || extracting) return;
    const previous = tracks;
    const expectedUpdatedAt = project?.updatedAt;
    if (!expectedUpdatedAt) {
      setSaveError("프로젝트 최신 버전을 확인할 수 없어 변경을 저장하지 않았습니다.");
      void loadProject();
      return;
    }
    // order 필드만 재부여 (파일명 NN prefix 는 굽기 시점 기준이므로 유지)
    const renumbered = next.map((t, i) => ({ ...t, order: i + 1 }));
    setTracks(renumbered);
    setPendingTracks(renumbered);
    setSaveError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CDstudio-Updated-At": expectedUpdatedAt,
        },
        body: JSON.stringify({ tracks: renumbered }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const detail =
          data && typeof data === "object" && "error" in data
            ? String((data as { error: unknown }).error)
            : `HTTP ${res.status}`;
        if (res.status === 409 || res.status === 428) {
          setPendingTracks(null);
          setTracks(previous);
          const refreshed = await loadProject();
          setSaveError(
            refreshed
              ? `다른 작업으로 트랙 목록이 변경되어 최신 목록을 다시 불러왔습니다: ${detail}`
              : `다른 작업으로 트랙 목록이 변경되었지만 최신 목록을 불러오지 못했습니다: ${detail}`,
          );
          return;
        }
        throw new Error(detail);
      }
      const saved = data as AlbumProject;
      setProject(saved);
      setTracks([...saved.tracks].sort((a, b) => a.order - b.order));
      setPendingTracks(null);
    } catch (err) {
      // 서버에 반영되지 않았으므로 화면을 이전 상태로 되돌린다
      setTracks(previous);
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(`트랙 변경을 저장하지 못했습니다: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  /** 마지막으로 실패한 변경을 다시 시도 */
  function retrySave() {
    if (!pendingTracks || extracting) return;
    const next = pendingTracks;
    setPendingTracks(null);
    void persistTracks(next);
  }

  function moveTrack(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= tracks.length) return;
    const next = [...tracks];
    [next[index], next[target]] = [next[target], next[index]];
    void persistTracks(next);
  }

  function deleteTrack(index: number) {
    const next = tracks.filter((_, i) => i !== index);
    void persistTracks(next);
  }

  function startTitleEdit(track: Track) {
    if (saving || extracting) return;
    setEditingTrackId(track.id);
    setTitleDraft(track.title);
    setTitleError(null);
  }

  function cancelTitleEdit() {
    setEditingTrackId(null);
    setTitleDraft("");
    setTitleError(null);
  }

  function saveTitle(trackId: string) {
    if (saving || extracting || editingTrackId !== trackId) return;
    const title = titleDraft.trim();
    if (!title) {
      setTitleError("트랙 제목을 입력해 주세요.");
      return;
    }
    if (title.length > 500) {
      setTitleError("트랙 제목은 500자 이하로 입력해 주세요.");
      return;
    }
    const current = tracks.find((track) => track.id === trackId);
    if (!current || current.title === title) {
      cancelTitleEdit();
      return;
    }
    const next = tracks.map((track) =>
      track.id === trackId ? { ...track, title } : track,
    );
    cancelTitleEdit();
    void persistTracks(next);
  }

  function handleDragStart(
    event: React.DragEvent<HTMLLIElement>,
    trackId: string,
  ) {
    if (saving || extracting || editingTrackId || dragIntentRef.current !== trackId) {
      event.preventDefault();
      return;
    }
    dragIntentRef.current = null;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", trackId);
    setDraggedTrackId(trackId);
  }

  function handleDragOver(
    event: React.DragEvent<HTMLLIElement>,
    trackId: string,
  ) {
    if (!draggedTrackId || draggedTrackId === trackId || saving || extracting) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropTarget((current) =>
      current?.trackId === trackId && current.position === position
        ? current
        : { trackId, position },
    );
  }

  function resetDragState() {
    dragIntentRef.current = null;
    setDraggedTrackId(null);
    setDropTarget(null);
  }

  function handleDrop(
    event: React.DragEvent<HTMLLIElement>,
    targetTrackId: string,
  ) {
    event.preventDefault();
    const sourceTrackId =
      draggedTrackId || event.dataTransfer.getData("text/plain");
    const position =
      dropTarget?.trackId === targetTrackId ? dropTarget.position : "before";
    resetDragState();
    if (!sourceTrackId || sourceTrackId === targetTrackId || saving || extracting) return;

    const source = tracks.find((track) => track.id === sourceTrackId);
    if (!source) return;
    const remaining = tracks.filter((track) => track.id !== sourceTrackId);
    const targetIndex = remaining.findIndex((track) => track.id === targetTrackId);
    if (targetIndex < 0) return;
    const insertIndex = targetIndex + (position === "after" ? 1 : 0);
    const next = [...remaining];
    next.splice(insertIndex, 0, source);
    if (next.every((track, index) => track.id === tracks[index]?.id)) return;
    void persistTracks(next);
  }

  // ── 총 러닝타임 상태 ──────────────────────────────────────
  const audioTotal = totalDurationSec(tracks);
  const savedPregapSec = project?.burnSettings?.pregapSec;
  const pregapSec =
    typeof savedPregapSec === "number" &&
    Number.isFinite(savedPregapSec) &&
    savedPregapSec >= 0 &&
    savedPregapSec <= 5
      ? savedPregapSec
      : DEFAULT_BURN_PREGAP_SEC;
  const discTotal = discOccupancySec(audioTotal, tracks.length, pregapSec);
  const overDurationLimit = discTotal > MAX_SECONDS;
  const overTrackLimit = tracks.length > MAX_BURN_TRACKS;
  const warnLimit = discTotal > WARN_SECONDS && !overDurationLimit;
  const discTotalClass = overDurationLimit || overTrackLimit
    ? "text-red-600 dark:text-red-400"
    : warnLimit
      ? "text-amber-600 dark:text-amber-400"
      : "text-zinc-700 dark:text-zinc-300";

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">트랙 추출 · 편집</h1>
        {project && (
          <p className="mt-1 text-sm text-zinc-500">
            {project.title} — {project.artist}
          </p>
        )}
      </header>

      {/* 음질 상한 고지 (상시) */}
      <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
        원본이 스트리밍 음원(최대 ~160kbps)이므로 CD 음질 상한이 있습니다.
      </div>

      {loadError && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {loadError}
        </div>
      )}

      {/* URL 입력 → 메타 조회 */}
      <section className="mb-8">
        <label className="mb-2 block text-sm font-medium">
          YouTube / SoundCloud URL (곡 또는 플레이리스트)
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setProbeResult(null);
              setSelected([]);
              setProbeError(null);
              setExtractError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && handleProbe()}
            placeholder="https://www.youtube.com/watch?v=..."
            disabled={probing || extracting}
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            onClick={handleProbe}
            disabled={probing || extracting || !url.trim()}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {probing ? "조회 중..." : "메타 조회"}
          </button>
        </div>
        {probeError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{probeError}</p>
        )}
      </section>

      {/* 조회 결과 → 선택 → 추출 시작 */}
      {probeResult && (
        <section className="mb-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm">
              {probeResult.kind === "playlist" ? (
                <span className="font-medium">
                  플레이리스트{probeResult.playlistTitle ? `: ${probeResult.playlistTitle}` : ""} ·{" "}
                  {probeResult.items.length}곡
                </span>
              ) : (
                <span className="font-medium">단일 곡</span>
              )}
            </div>
            {probeResult.kind === "playlist" && (
              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => setAllSelected(true)}
                  disabled={extracting}
                  className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  최대 {MAX_EXTRACT_ITEMS}곡 선택
                </button>
                <button
                  onClick={() => setAllSelected(false)}
                  disabled={extracting}
                  className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  전체 해제
                </button>
              </div>
            )}
          </div>

          {probeResult.truncated && (
            <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
              플레이리스트 항목이 많아 앞의 {probeResult.items.length}곡만 표시합니다
              {typeof probeResult.totalItems === "number"
                ? ` (전체 ${probeResult.totalItems}곡)`
                : ""}
              .
            </p>
          )}

          {probeResult.items.length > MAX_EXTRACT_ITEMS && (
            <p className="mb-3 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-300">
              한 번에 최대 {MAX_EXTRACT_ITEMS}곡까지 추출할 수 있습니다. 현재 최대
              수량만 선택했으며, 완료 후 선택을 바꿔 나머지 곡을 이어서 추출할 수
              있습니다.
            </p>
          )}

          <ul className="mb-4 max-h-64 space-y-1 overflow-y-auto">
            {probeResult.items.map((item, idx) => (
              <li key={`${item.sourceUrl}-${idx}`}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <input
                    type="checkbox"
                    checked={selected[idx] ?? false}
                    onChange={() => toggleSelect(idx)}
                    disabled={extracting}
                    className="h-4 w-4"
                  />
                  <span className="flex-1 truncate">{item.title}</span>
                  {item.artist && (
                    <span className="shrink-0 text-xs text-zinc-500">{item.artist}</span>
                  )}
                  {typeof item.durationSec === "number" && (
                    <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                      {formatDuration(item.durationSec)}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3">
            <button
              onClick={handleExtract}
              disabled={
                extracting ||
                saving ||
                Boolean(editingTrackId) ||
                selected.every((s) => !s)
              }
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              추출 시작 ({selected.filter(Boolean).length}곡)
            </button>
            {extracting && (
              <button
                onClick={handleStop}
                className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
              >
                중단
              </button>
            )}
          </div>
          {extractError && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{extractError}</p>
          )}
        </section>
      )}

      {/* 진행 중 곡 진행률 */}
      {inProgress.length > 0 && (
        <section className="mb-8 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">
            진행 중
          </h2>
          {inProgress.map((p) => (
            <div key={p.trackId} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="truncate pr-2">{p.title}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {p.error
                    ? "오류"
                    : p.retry
                      ? "재연결 중"
                    : p.phase === "download"
                      ? "다운로드"
                      : "변환"}{" "}
                  {p.error || p.retry ? "" : `${Math.round(p.percent)}%`}
                </span>
              </div>
              {p.error ? (
                <p className="text-xs text-red-600 dark:text-red-400">{p.error}</p>
              ) : (
                <>
                  {p.retry && (
                    <p role="status" className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                      연결이 일시적으로 거부되어 다시 연결 중{" "}
                      ({p.retry.attempt}/{p.retry.maxAttempts})
                    </p>
                  )}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className={`h-full rounded-full transition-all ${
                        p.phase === "download" ? "bg-sky-500" : "bg-emerald-500"
                      }`}
                      style={{ width: `${p.retry ? 0 : Math.max(2, Math.min(100, p.percent))}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {/* 완료 트랙 리스트 */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">트랙 ({tracks.length})</h2>
          <div className="text-right text-sm">
            <div>
              <span className="text-zinc-500">오디오 합계 </span>
              <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
                {formatDuration(audioTotal)}
              </span>
            </div>
            <div>
              <span className="text-zinc-500">디스크 점유 예상 </span>
              <span className={`font-semibold tabular-nums ${discTotalClass}`}>
                {formatDuration(discTotal)} / {MAX_AUDIO_MINUTES}:00
              </span>
            </div>
            {tracks.length > 0 && (
              <div className="text-xs text-zinc-500">
                첫 곡 앞 2초 + 트랙 사이 {pregapSec}초 포함
              </div>
            )}
            {warnLimit && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                디스크 점유 74분 근접 — 곧 CD 용량 한계입니다
              </div>
            )}
            {overDurationLimit && (
              <div className="text-xs font-semibold text-red-600 dark:text-red-400">
                디스크 점유 79분 초과 — 굽기 불가
              </div>
            )}
            {overTrackLimit && (
              <div className="text-xs font-semibold text-red-600 dark:text-red-400">
                최대 {MAX_BURN_TRACKS}트랙 초과 — 굽기 불가
              </div>
            )}
          </div>
        </div>

        {saveError && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <span>
              {saveError} — 변경 내용을 되돌렸습니다. 다시 시도해 주세요.
            </span>
            {pendingTracks && (
              <button
                onClick={retrySave}
                disabled={saving}
                className="shrink-0 rounded border border-red-400 px-2 py-1 text-xs font-medium hover:bg-red-100 disabled:opacity-40 dark:border-red-700 dark:hover:bg-red-900/40"
              >
                재시도
              </button>
            )}
          </div>
        )}

        {tracks.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400 dark:border-zinc-700">
            아직 트랙이 없습니다. 위에서 URL을 조회해 추출하세요.
          </p>
        ) : (
          <ul className="space-y-2">
            {tracks.map((track, idx) => (
              <li
                key={track.id}
                draggable={!saving && !extracting && !editingTrackId}
                onDragStart={(event) => handleDragStart(event, track.id)}
                onDragOver={(event) => handleDragOver(event, track.id)}
                onDrop={(event) => handleDrop(event, track.id)}
                onDragEnd={resetDragState}
                className={`relative rounded-md border border-zinc-200 p-3 transition-opacity dark:border-zinc-800 ${
                  draggedTrackId === track.id ? "opacity-40" : ""
                } ${
                  dropTarget?.trackId === track.id
                    ? dropTarget.position === "before"
                      ? "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:bg-sky-500"
                      : "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:bg-sky-500"
                    : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    onMouseDown={() => {
                      dragIntentRef.current = track.id;
                      window.addEventListener(
                        "mouseup",
                        () => {
                          dragIntentRef.current = null;
                        },
                        { once: true },
                      );
                    }}
                    className={`shrink-0 select-none text-zinc-400 ${
                      saving || extracting || editingTrackId
                        ? "cursor-not-allowed opacity-30"
                        : "cursor-grab active:cursor-grabbing"
                    }`}
                    title="드래그하여 순서 변경"
                  >
                    ⠿
                  </span>
                  <span className="w-6 shrink-0 text-center text-sm font-semibold tabular-nums text-zinc-400">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {editingTrackId === track.id ? (
                      <div>
                        <input
                          type="text"
                          value={titleDraft}
                          onChange={(event) => {
                            setTitleDraft(event.target.value);
                            if (titleError) setTitleError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelTitleEdit();
                            }
                          }}
                          onBlur={() => saveTitle(track.id)}
                          maxLength={500}
                          disabled={saving || extracting}
                          autoFocus
                          aria-label={`${idx + 1}번 트랙 제목`}
                          aria-invalid={Boolean(titleError)}
                          aria-describedby={
                            titleError ? `track-title-error-${track.id}` : undefined
                          }
                          className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm font-medium outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
                        />
                        {titleError && (
                          <p
                            id={`track-title-error-${track.id}`}
                            role="alert"
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                          >
                            {titleError}
                          </p>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startTitleEdit(track)}
                        disabled={saving || extracting}
                        title="트랙 제목 수정"
                        className="flex max-w-full items-center gap-1 text-left text-sm font-medium hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-sky-400"
                      >
                        <span className="truncate">{track.title}</span>
                        <span aria-hidden="true" className="shrink-0 text-xs text-zinc-400">
                          ✎
                        </span>
                      </button>
                    )}
                    <div className="text-xs text-zinc-500">
                      {track.artist ? `${track.artist} · ` : ""}
                      {formatDuration(track.durationSec)}
                      {track.status === "error" && (
                        <span className="ml-2 text-red-500">오류</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => moveTrack(idx, -1)}
                      disabled={idx === 0 || saving || extracting}
                      aria-label={`${idx + 1}번 ${track.title} 위로`}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveTrack(idx, 1)}
                      disabled={idx === tracks.length - 1 || saving || extracting}
                      aria-label={`${idx + 1}번 ${track.title} 아래로`}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => deleteTrack(idx)}
                      disabled={saving || extracting}
                      aria-label={`${idx + 1}번 ${track.title} 삭제`}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-30 dark:border-red-800 dark:hover:bg-red-950/40"
                    >
                      삭제
                    </button>
                  </div>
                </div>
                <audio
                  controls
                  preload="none"
                  className="mt-2 h-8 w-full"
                  src={`/api/projects/${projectId}/file?type=track&name=${encodeURIComponent(
                    track.filename,
                  )}`}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
