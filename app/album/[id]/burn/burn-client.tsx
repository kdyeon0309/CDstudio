"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlbumProject, BurnEvent, BurnSettings, DriveStatus } from "@/lib/types";
import {
  BURN_SPEEDS,
  DEFAULT_BURN_PREGAP_SEC,
  MAX_BURN_TRACKS,
  discOccupancySecFromTracks,
  formatDuration,
  isAudioCdMediaType,
  MAX_AUDIO_MINUTES,
  PREGAP_CHOICES,
  totalDurationSec,
} from "@/lib/types";

const EMPTY_DRIVE: DriveStatus = {
  connected: false,
  mediaPresent: false,
  blank: false,
  erasable: false,
  raw: "",
};

/** 배속 select의 "최대 속도" 항목 값 (speed 미지정) */
const MAX_SPEED = "max";
/** 트랙 간격 기본값 (drutil 기본과 동일한 2초) */
const DEFAULT_PREGAP_SEC = DEFAULT_BURN_PREGAP_SEC;

export default function BurnClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [drive, setDrive] = useState<DriveStatus>(EMPTY_DRIVE);
  const [loading, setLoading] = useState(true);
  const [projectError, setProjectError] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [burning, setBurning] = useState(false);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  // 굽기 설정 — 초기값은 project.burnSettings (없으면 최대 속도 · 2초)
  const [speed, setSpeed] = useState<string>(MAX_SPEED);
  const [pregapSec, setPregapSec] = useState<number>(DEFAULT_PREGAP_SEC);
  const logEnd = useRef<HTMLDivElement>(null);
  const burnButtonRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (showConfirm) cancelRef.current?.focus();
  }, [showConfirm]);

  function closeConfirm() {
    setShowConfirm(false);
    requestAnimationFrame(() => burnButtonRef.current?.focus());
  }

  function handleConfirmKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirm();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = confirmRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (!buttons?.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

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
        const saved = data.burnSettings;
        if (saved?.speed !== undefined && BURN_SPEEDS.includes(saved.speed)) {
          setSpeed(String(saved.speed));
        }
        if (saved?.pregapSec !== undefined && PREGAP_CHOICES.includes(saved.pregapSec)) {
          setPregapSec(saved.pregapSec);
        }
      })
      .catch((error: Error) => {
        if (active) setProjectError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch("/api/drive", { cache: "no-store", signal: controller.signal });
        if (response.ok && active) setDrive((await response.json()) as DriveStatus);
      } catch {
        if (active) setDrive(EMPTY_DRIVE);
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const total = useMemo(() => totalDurationSec(project?.tracks ?? []), [project]);
  const trackCount = project?.tracks.length ?? 0;
  const discSeconds = discOccupancySecFromTracks(project?.tracks.map((track) => track.durationSec) ?? [], pregapSec);
  const tooLong = discSeconds > MAX_AUDIO_MINUTES * 60;
  const tooManyTracks = trackCount > MAX_BURN_TRACKS;
  const mediaSeconds = typeof drive.writableMinutes === "number" && Number.isFinite(drive.writableMinutes)
    && drive.writableMinutes >= 0 ? drive.writableMinutes * 60 : null;
  const overMediaCapacity = mediaSeconds !== null && discSeconds > mediaSeconds;
  const tracksReady = !!project?.tracks.length && project.status !== "extracting"
    && project.tracks.every((track) => track.status === "done");
  const discReady = drive.connected && drive.mediaPresent && isAudioCdMediaType(drive.mediaType)
    && drive.blank;
  const canBurn = discReady && tracksReady && !tooLong && !tooManyTracks && !overMediaCapacity && !burning && !complete;

  const startBurn = useCallback(async () => {
    setShowConfirm(false);
    setBurning(true);
    setComplete(false);
    setProgress(null);
    setLogs([]);
    try {
      if (!project?.updatedAt) throw new Error("앨범 정보를 다시 불러온 뒤 굽기를 시작해 주세요.");
      // speed 미지정 = 드라이브 최대 속도
      const settings: BurnSettings = { pregapSec };
      if (speed !== MAX_SPEED) settings.speed = Number(speed);

      const response = await fetch("/api/burn", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CDstudio-Updated-At": project.updatedAt },
        body: JSON.stringify({ projectId, settings }),
      });
      if (!response.ok) {
        if (response.status === 409 || response.status === 428) {
          const latest = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
          if (latest.ok) setProject((await latest.json()) as AlbumProject);
        }
        const fallback =
          response.status === 409
            ? "이미 다른 굽기 작업이 진행 중입니다. 완료된 뒤 다시 시도해 주세요."
            : response.status === 403
              ? "동일 출처 요청만 허용됩니다."
              : "굽기 요청을 시작하지 못했습니다.";
        let message = fallback;
        try {
          const detail = (await response.json()) as { error?: unknown };
          if (typeof detail.error === "string" && detail.error) message = detail.error;
        } catch {
          // 본문 없음 → fallback 사용
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("굽기 요청을 시작하지 못했습니다.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const message of messages) {
          const data = message
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (!data) continue;
          const event = JSON.parse(data) as BurnEvent;
          if (event.type === "validating" || event.type === "log") {
            setLogs((current) => [...current, event.message]);
          } else if (event.type === "progress") {
            setProgress(event.percent);
          } else if (event.type === "done") {
            setProgress(100);
            setComplete(true);
          } else if (event.type === "error") {
            setLogs((current) => [...current, `오류: ${event.message}`]);
          }
        }
        if (done) break;
      }
    } catch (error) {
      setLogs((current) => [
        ...current,
        `오류: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      ]);
    } finally {
      setBurning(false);
    }
  }, [project, projectId, speed, pregapSec]);

  if (loading) return <div role="status" className="mx-auto max-w-5xl py-12 text-sm text-fg-muted">앨범을 불러오는 중…</div>;
  if (projectError || !project) {
    return <div role="alert" className="mx-auto max-w-5xl rounded-xl border border-rose/40 bg-rose/10 p-5 text-sm text-rose">{projectError || "프로젝트가 없습니다."}</div>;
  }

  const driveView = !drive.connected
    ? { title: "드라이브 미연결", text: "Mac에 USB 광학 드라이브를 연결해 주세요.", color: "border-line-strong bg-panel", accent: "text-fg-muted" }
    : !drive.mediaPresent
      ? { title: "디스크를 넣어주세요", text: "드라이브에 공 CD-R 또는 비어 있는 CD-RW를 넣어 주세요.", color: "border-amber/40 bg-amber/5", accent: "text-amber" }
      : !isAudioCdMediaType(drive.mediaType)
        ? { title: "오디오 CD용 미디어가 아닙니다", text: "DVD/BD가 아닌 공 CD-R 또는 지울 수 있는 CD-RW로 교체해 주세요.", color: "border-rose/40 bg-rose/5", accent: "text-rose" }
      : drive.blank
        ? { title: "공 CD 준비됨 ✓", text: [drive.vendor, drive.product].filter(Boolean).join(" ") || "굽기를 시작할 수 있습니다.", color: "border-teal/40 bg-teal/5", accent: "text-teal" }
        : { title: "비어 있는 CD가 아닙니다", text: "새 CD-R 또는 미리 지워 둔 공 CD-RW로 교체해 주세요. 앱은 기존 내용을 자동 삭제하지 않습니다.", color: "border-rose/40 bg-rose/5", accent: "text-rose" };

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-6 text-fg">
        <header>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-amber">④ 오디오 CD 굽기</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">굽기 준비</h2>
          <p className="mt-1 text-sm text-fg-muted">트랙 순서와 디스크 용량을 확인한 뒤 진행하세요. 실물 CD 굽기는 되돌릴 수 없습니다.</p>
        </header>

        <section aria-live="polite" className={`rounded-2xl border p-5 ${driveView.color}`}>
          <h3 className={`text-base font-semibold ${driveView.accent}`}>{driveView.title}</h3>
          <p className="mt-1 text-sm text-fg-muted">{driveView.text}</p>
          {drive.writableMinutes !== undefined && (
            <p className="mt-2 font-mono text-xs text-fg-muted">디스크 여유: 약 {formatDuration(Math.floor(drive.writableMinutes * 60))}</p>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-5">
            <h3 className="text-base font-semibold">트랙리스트 최종 확인</h3>
            <span className={`font-mono text-xs font-semibold ${tooLong || overMediaCapacity ? "text-rose" : "text-fg-muted"}`}>
              디스크 점유 예상 {formatDuration(Math.ceil(discSeconds))} / {MAX_AUDIO_MINUTES}:00
            </span>
          </div>
          <ol className="max-h-80 divide-y divide-line overflow-y-auto">
            {[...project.tracks].sort((a, b) => a.order - b.order).map((track) => (
              <li key={track.id} className="flex items-center gap-3 px-5 py-3">
                <span className="w-7 font-mono text-xs text-fg-dim">{String(track.order).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{track.title}</span>
                <span className="font-mono text-xs text-fg-muted">{formatDuration(track.durationSec)}</span>
              </li>
            ))}
          </ol>
          <p className="border-t border-line px-5 py-3 text-xs text-fg-dim">
            오디오 {formatDuration(total)} + 첫 곡 앞 2초 + 곡 사이 {pregapSec}초 × {Math.max(0, trackCount - 1)}회. 실제 굽기 전 WAV 길이로 다시 확인합니다.
          </p>
          {tooLong && (
            <p role="alert" className="border-t border-rose/30 bg-rose/10 px-5 py-3 text-sm font-semibold text-rose">
              트랙 간격을 포함한 디스크 점유 시간이 79분을 초과해 굽기를 진행할 수 없습니다.
            </p>
          )}
          {tooManyTracks && (
            <p role="alert" className="border-t border-rose/30 bg-rose/10 px-5 py-3 text-sm font-semibold text-rose">
              오디오 CD는 최대 {MAX_BURN_TRACKS}곡까지만 구울 수 있습니다. 현재 {trackCount}곡입니다.
            </p>
          )}
          {overMediaCapacity && mediaSeconds !== null && (
            <p role="alert" className="border-t border-rose/30 bg-rose/10 px-5 py-3 text-sm font-semibold text-rose">
              삽입된 디스크의 남은 용량(약 {formatDuration(Math.floor(mediaSeconds))})보다 필요한 시간이 깁니다.
            </p>
          )}
          {!tracksReady && (
            <p className="border-t border-amber/30 bg-amber/10 px-5 py-3 text-sm font-semibold text-amber">
              {project.status === "extracting" ? "트랙 추출이 진행 중입니다. 완료 후 목록을 다시 확인해 주세요." : "모든 트랙의 추출이 완료되어야 굽기를 진행할 수 있습니다."}
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-panel p-5">
          <h3 className="text-base font-semibold">굽기 설정</h3>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="burn-speed" className="block text-sm font-medium text-fg-muted">
                굽기 배속
              </label>
              <select
                id="burn-speed"
                value={speed}
                disabled={burning}
                onChange={(event) => setSpeed(event.target.value)}
                className="mt-2 w-full rounded-lg border border-line-strong bg-ink px-3 py-2 text-sm text-fg outline-none focus:border-amber focus:ring-1 focus:ring-amber/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value={MAX_SPEED}>최대 속도 (기본)</option>
                {BURN_SPEEDS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}배속
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-fg-dim">
                배속이 낮을수록 굽기는 오래 걸리지만 더 안정적입니다.
              </p>
            </div>

            <div>
              <label htmlFor="burn-pregap" className="block text-sm font-medium text-fg-muted">
                트랙 간격
              </label>
              <select
                id="burn-pregap"
                value={String(pregapSec)}
                disabled={burning}
                onChange={(event) => setPregapSec(Number(event.target.value))}
                className="mt-2 w-full rounded-lg border border-line-strong bg-ink px-3 py-2 text-sm text-fg outline-none focus:border-amber focus:ring-1 focus:ring-amber/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {PREGAP_CHOICES.map((value) => (
                  <option key={value} value={String(value)}>
                    {value === 0 ? "0초 (끊김 없이)" : `${value}초`}
                    {value === DEFAULT_PREGAP_SEC ? " (기본)" : ""}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-fg-dim">
                곡과 곡 사이 무음 길이입니다. 첫 곡 앞 2초는 CD 규격상 고정입니다.
              </p>
            </div>
          </div>
        </section>

        {(burning || logs.length > 0 || complete) && (
          <section role="status" aria-live="polite" className="rounded-2xl border border-line bg-panel p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">{complete ? "굽기 완료 🎉" : burning ? "CD 굽는 중…" : "굽기 로그"}</h2>
              {progress !== null && <span className="font-mono text-sm">{Math.round(progress)}%</span>}
            </div>
            {progress !== null && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-line-strong">
                <div className="h-full bg-teal transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}
            <div className="mt-4 max-h-52 overflow-y-auto rounded-lg bg-ink p-3 font-mono text-xs leading-5 text-teal">
              {logs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
              <div ref={logEnd} />
            </div>
          </section>
        )}

        <button
          ref={burnButtonRef}
          type="button"
          disabled={!canBurn}
          onClick={() => setShowConfirm(true)}
          className="w-full rounded-xl bg-amber px-5 py-4 font-semibold text-ink transition hover:bg-amber-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber disabled:cursor-not-allowed disabled:opacity-40"
        >
          {burning ? "굽는 중…" : complete ? "굽기 완료" : "오디오 CD 굽기"}
        </button>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeConfirm(); }}>
          <div ref={confirmRef} onKeyDown={handleConfirmKeyDown} tabIndex={-1} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-panel p-6 text-fg shadow-2xl focus:outline-none" role="dialog" aria-modal="true" aria-labelledby="burn-confirm-title" aria-describedby="burn-confirm-detail">
            <h2 id="burn-confirm-title" className="text-xl font-semibold">정말 굽겠습니까?</h2>
            <p id="burn-confirm-detail" className="mt-3 text-sm text-fg-muted">실물 CD 굽기는 되돌릴 수 없습니다. 디스크와 설정을 마지막으로 확인하세요.</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line bg-ink p-4 text-xs">
              <dt className="text-fg-dim">앨범</dt><dd className="truncate text-right text-fg" title={project.title}>{project.title}</dd>
              <dt className="text-fg-dim">트랙</dt><dd className="text-right text-fg">{trackCount}곡</dd>
              <dt className="text-fg-dim">디스크 점유 예상</dt><dd className="text-right text-fg">{formatDuration(Math.ceil(discSeconds))}</dd>
              <dt className="text-fg-dim">설정</dt><dd className="text-right text-fg">{speed === MAX_SPEED ? "최대 배속" : `${speed}배속`} · 간격 {pregapSec}초</dd>
            </dl>
            <div className="mt-6 flex justify-end gap-3">
              <button ref={cancelRef} type="button" onClick={closeConfirm} className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-fg-muted hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-amber">
                취소
              </button>
              <button type="button" disabled={!canBurn} onClick={() => void startBurn()} className="rounded-lg bg-rose px-4 py-2 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-rose disabled:opacity-40">
                굽기 시작
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
