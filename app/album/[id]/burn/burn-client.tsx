"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlbumProject, BurnEvent, BurnSettings, DriveStatus } from "@/lib/types";
import {
  BURN_SPEEDS,
  formatDuration,
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
const DEFAULT_PREGAP_SEC = 2;

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
    const poll = async () => {
      try {
        const response = await fetch("/api/drive", { cache: "no-store" });
        if (response.ok && active) setDrive((await response.json()) as DriveStatus);
      } catch {
        if (active) setDrive(EMPTY_DRIVE);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const total = useMemo(() => totalDurationSec(project?.tracks ?? []), [project]);
  const tooLong = total > MAX_AUDIO_MINUTES * 60;
  const tracksReady = !!project?.tracks.length && project.tracks.every((track) => track.status === "done");
  const discReady = drive.connected && drive.mediaPresent && (drive.blank || drive.erasable);
  const canBurn = discReady && tracksReady && !tooLong && !burning && !complete;

  const startBurn = useCallback(async () => {
    setShowConfirm(false);
    setBurning(true);
    setComplete(false);
    setProgress(null);
    setLogs([]);
    try {
      // speed 미지정 = 드라이브 최대 속도
      const settings: BurnSettings = { pregapSec };
      if (speed !== MAX_SPEED) settings.speed = Number(speed);

      const response = await fetch("/api/burn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, settings }),
      });
      if (!response.ok) {
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
  }, [projectId, speed, pregapSec]);

  if (loading) return <main className="mx-auto max-w-5xl p-8 text-zinc-600">앨범을 불러오는 중…</main>;
  if (projectError || !project) {
    return <main className="mx-auto max-w-5xl p-8 text-red-700">{projectError || "프로젝트가 없습니다."}</main>;
  }

  const driveView = !drive.connected
    ? { title: "드라이브 미연결", text: "Mac에 USB 광학 드라이브를 연결해 주세요.", color: "border-zinc-300 bg-zinc-50" }
    : !drive.mediaPresent
      ? { title: "디스크를 넣어주세요", text: "드라이브에 공 CD-R 또는 비어 있는 CD-RW를 넣어 주세요.", color: "border-amber-300 bg-amber-50" }
      : drive.blank || drive.erasable
        ? { title: "공 CD 준비됨 ✓", text: [drive.vendor, drive.product].filter(Boolean).join(" ") || "굽기를 시작할 수 있습니다.", color: "border-emerald-300 bg-emerald-50" }
        : { title: "기록 가능한 공 CD가 아닙니다", text: "새 CD-R 또는 지울 수 있는 CD-RW로 교체해 주세요.", color: "border-red-300 bg-red-50" };

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-10 text-zinc-950">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <p className="text-sm font-semibold text-violet-700">6단계 · CD 굽기</p>
          <h1 className="mt-1 text-3xl font-bold">{project.title}</h1>
          <p className="text-zinc-600">{project.artist}</p>
        </header>

        <section className={`rounded-2xl border p-5 ${driveView.color}`}>
          <h2 className="text-lg font-bold">{driveView.title}</h2>
          <p className="mt-1 text-sm text-zinc-700">{driveView.text}</p>
          {drive.writableMinutes !== undefined && (
            <p className="mt-2 text-sm">디스크 여유: 약 {Math.floor(drive.writableMinutes)}분</p>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 p-5">
            <h2 className="text-lg font-bold">트랙리스트 최종 확인</h2>
            <span className={`font-mono text-sm font-semibold ${tooLong ? "text-red-700" : "text-zinc-700"}`}>
              총 {formatDuration(total)} / {MAX_AUDIO_MINUTES}:00
            </span>
          </div>
          <ol className="divide-y divide-zinc-100">
            {[...project.tracks].sort((a, b) => a.order - b.order).map((track) => (
              <li key={track.id} className="flex items-center gap-4 px-5 py-3">
                <span className="w-7 font-mono text-sm text-zinc-400">{String(track.order).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{track.title}</span>
                <span className="font-mono text-sm text-zinc-500">{formatDuration(track.durationSec)}</span>
              </li>
            ))}
          </ol>
          {tooLong && (
            <p className="border-t border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">
              총 재생 시간이 79분을 초과해 굽기를 진행할 수 없습니다.
            </p>
          )}
          {!tracksReady && (
            <p className="border-t border-amber-200 bg-amber-50 px-5 py-3 text-sm font-semibold text-amber-800">
              모든 트랙의 추출이 완료되어야 굽기를 진행할 수 있습니다.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5">
          <h2 className="text-lg font-bold">굽기 설정</h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="burn-speed" className="block text-sm font-semibold text-zinc-800">
                굽기 배속
              </label>
              <select
                id="burn-speed"
                value={speed}
                disabled={burning}
                onChange={(event) => setSpeed(event.target.value)}
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
              >
                <option value={MAX_SPEED}>최대 속도 (기본)</option>
                {BURN_SPEEDS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}배속
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-zinc-600">
                배속이 낮을수록 굽기는 오래 걸리지만 더 안정적입니다.
              </p>
            </div>

            <div>
              <label htmlFor="burn-pregap" className="block text-sm font-semibold text-zinc-800">
                트랙 간격
              </label>
              <select
                id="burn-pregap"
                value={String(pregapSec)}
                disabled={burning}
                onChange={(event) => setPregapSec(Number(event.target.value))}
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
              >
                {PREGAP_CHOICES.map((value) => (
                  <option key={value} value={String(value)}>
                    {value === 0 ? "0초 (끊김 없이)" : `${value}초`}
                    {value === DEFAULT_PREGAP_SEC ? " (기본)" : ""}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-zinc-600">
                곡과 곡 사이 무음 길이입니다. 첫 곡 앞 2초는 CD 규격상 고정입니다.
              </p>
            </div>
          </div>
        </section>

        {(burning || logs.length > 0 || complete) && (
          <section className="rounded-2xl bg-zinc-950 p-5 text-zinc-100">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">{complete ? "굽기 완료 🎉" : burning ? "CD 굽는 중…" : "굽기 로그"}</h2>
              {progress !== null && <span className="font-mono text-sm">{Math.round(progress)}%</span>}
            </div>
            {progress !== null && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-700">
                <div className="h-full bg-violet-400 transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}
            <div className="mt-4 max-h-52 overflow-y-auto rounded-lg bg-black p-3 font-mono text-xs leading-5 text-emerald-300">
              {logs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
              <div ref={logEnd} />
            </div>
          </section>
        )}

        <button
          type="button"
          disabled={!canBurn}
          onClick={() => setShowConfirm(true)}
          className="w-full rounded-xl bg-violet-700 px-5 py-4 font-bold text-white transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500"
        >
          {burning ? "굽는 중…" : complete ? "굽기 완료" : "오디오 CD 굽기"}
        </button>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="burn-confirm-title">
            <h2 id="burn-confirm-title" className="text-xl font-bold">정말 굽겠습니까?</h2>
            <p className="mt-3 text-zinc-700">CD-R은 되돌릴 수 없습니다. 굽시겠습니까?</p>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setShowConfirm(false)} className="rounded-lg border border-zinc-300 px-4 py-2 font-semibold">
                취소
              </button>
              <button type="button" onClick={() => void startBurn()} className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800">
                굽기 시작
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
