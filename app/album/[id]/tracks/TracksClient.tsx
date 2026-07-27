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
  MAX_AUDIO_MINUTES,
  formatDuration,
  totalDurationSec,
} from "@/lib/types";

const WARN_SECONDS = 74 * 60; // 74분 경고
const MAX_SECONDS = MAX_AUDIO_MINUTES * 60; // 79분 초과 차단

interface InProgress {
  trackId: string;
  title: string;
  phase: "download" | "convert";
  percent: number;
  error?: string;
}

export default function TracksClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [selected, setSelected] = useState<boolean[]>([]);

  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState<InProgress[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  // ── 프로젝트 로드 ─────────────────────────────────────────
  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`프로젝트 로드 실패 (${res.status})`);
      const data = (await res.json()) as AlbumProject;
      setProject(data);
      setTracks([...data.tracks].sort((a, b) => a.order - b.order));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    loadProject();
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
    setProbeResult(null);
    try {
      const res = await fetch("/api/extract/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `조회 실패 (${res.status})`);
      const result = data as ProbeResult;
      setProbeResult(result);
      setSelected(result.items.map(() => true)); // 기본 전체 선택
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }

  function toggleSelect(idx: number) {
    setSelected((prev) => prev.map((v, i) => (i === idx ? !v : v)));
  }
  function setAllSelected(value: boolean) {
    setSelected((prev) => prev.map(() => value));
  }

  // ── 추출 시작 (SSE) ───────────────────────────────────────
  async function handleExtract() {
    if (!probeResult) return;
    const items: ProbeItem[] = probeResult.items.filter((_, i) => selected[i]);
    if (items.length === 0) {
      setExtractError("선택된 곡이 없습니다");
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
        const msg = await res.text().catch(() => "");
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
      loadProject();
    }
  }

  function handleEvent(event: ExtractEvent) {
    switch (event.type) {
      case "track-start":
        setInProgress((prev) => [
          ...prev.filter((p) => p.trackId !== event.trackId),
          { trackId: event.trackId, title: event.title, phase: "download", percent: 0 },
        ]);
        break;
      case "progress":
        setInProgress((prev) =>
          prev.map((p) =>
            p.trackId === event.trackId
              ? { ...p, phase: event.phase, percent: event.percent }
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
            p.trackId === event.trackId ? { ...p, error: event.message } : p,
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
  }

  // ── 트랙 편집 (순서/삭제) ─────────────────────────────────
  async function persistTracks(next: Track[]) {
    // order 필드만 재부여 (파일명 NN prefix 는 굽기 시점 기준이므로 유지)
    const renumbered = next.map((t, i) => ({ ...t, order: i + 1 }));
    setTracks(renumbered);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: renumbered }),
      });
      if (res.ok) {
        const data = (await res.json()) as AlbumProject;
        setProject(data);
      }
    } catch {
      /* 로컬 상태는 이미 갱신됨 */
    }
  }

  function moveTrack(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= tracks.length) return;
    const next = [...tracks];
    [next[index], next[target]] = [next[target], next[index]];
    persistTracks(next);
  }

  function deleteTrack(index: number) {
    const next = tracks.filter((_, i) => i !== index);
    persistTracks(next);
  }

  // ── 총 러닝타임 상태 ──────────────────────────────────────
  const total = totalDurationSec(tracks);
  const overLimit = total > MAX_SECONDS;
  const warnLimit = total > WARN_SECONDS && !overLimit;
  const totalClass = overLimit
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
            onChange={(e) => setUrl(e.target.value)}
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
                  className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  전체 선택
                </button>
                <button
                  onClick={() => setAllSelected(false)}
                  className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  전체 해제
                </button>
              </div>
            )}
          </div>

          <ul className="mb-4 max-h-64 space-y-1 overflow-y-auto">
            {probeResult.items.map((item, idx) => (
              <li key={`${item.sourceUrl}-${idx}`}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <input
                    type="checkbox"
                    checked={selected[idx] ?? false}
                    onChange={() => toggleSelect(idx)}
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
              disabled={extracting || selected.every((s) => !s)}
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
                    : p.phase === "download"
                      ? "다운로드"
                      : "변환"}{" "}
                  {p.error ? "" : `${Math.round(p.percent)}%`}
                </span>
              </div>
              {p.error ? (
                <p className="text-xs text-red-600 dark:text-red-400">{p.error}</p>
              ) : (
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className={`h-full rounded-full transition-all ${
                      p.phase === "download" ? "bg-sky-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.max(2, Math.min(100, p.percent))}%` }}
                  />
                </div>
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
            <span className="text-zinc-500">총 </span>
            <span className={`font-semibold tabular-nums ${totalClass}`}>
              {formatDuration(total)}
            </span>
            {warnLimit && (
              <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                74분 근접 — 곧 CD 용량 한계입니다
              </span>
            )}
            {overLimit && (
              <span className="ml-2 text-xs font-semibold text-red-600 dark:text-red-400">
                79분 초과 — 굽기 불가
              </span>
            )}
          </div>
        </div>

        {tracks.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400 dark:border-zinc-700">
            아직 트랙이 없습니다. 위에서 URL을 조회해 추출하세요.
          </p>
        ) : (
          <ul className="space-y-2">
            {tracks.map((track, idx) => (
              <li
                key={track.id}
                className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="flex items-center gap-3">
                  <span className="w-6 shrink-0 text-center text-sm font-semibold tabular-nums text-zinc-400">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{track.title}</div>
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
                      disabled={idx === 0}
                      aria-label="위로"
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveTrack(idx, 1)}
                      disabled={idx === tracks.length - 1}
                      aria-label="아래로"
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => deleteTrack(idx)}
                      aria-label="삭제"
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
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
