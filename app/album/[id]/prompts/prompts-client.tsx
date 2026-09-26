"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AlbumProject, ArtworkPart, DesignEvent } from "@/lib/types";
import { ARTWORK_PARTS, PART_LABELS, PRINT_SPECS } from "@/lib/types";
import { readDesignStream } from "../design/read-design-stream";

type ImagePrompts = Partial<Record<ArtworkPart, string>>;

/** 영역별 비율 안내 (서버 프롬프트 규칙과 동일한 기준) */
const ASPECT_NOTE: Record<ArtworkPart, string> = {
  front: `정사각형 (1:1) · 인쇄 ${PRINT_SPECS.front.widthMm}×${PRINT_SPECS.front.heightMm}mm`,
  "front-inner": `정사각형 (1:1) · 인쇄 ${PRINT_SPECS["front-inner"].widthMm}×${PRINT_SPECS["front-inner"].heightMm}mm`,
  label: `정사각형 (1:1) · 원형 Ø${PRINT_SPECS.label.outerDiameterMm}mm로 잘림`,
  back: `가로형 (약 5:4) · 인쇄 ${PRINT_SPECS.back.widthMm}×${PRINT_SPECS.back.heightMm}mm · 좌우 ${PRINT_SPECS.back.spineMm}mm 접힘`,
  "back-inner": `가로형 (약 5:4) · 인쇄 ${PRINT_SPECS["back-inner"].widthMm}×${PRINT_SPECS["back-inner"].heightMm}mm · 좌우 ${PRINT_SPECS["back-inner"].spineMm}mm 접힘`,
};

export default function PromptsClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<ImagePrompts>({});
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [copied, setCopied] = useState<ArtworkPart | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const loadProject = useCallback(
    () =>
      fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error(`앨범을 불러오지 못했습니다 (${res.status})`);
          return (await res.json()) as AlbumProject;
        })
        .then((data) => {
          setProject(data);
          setPrompts({ ...(data.artwork?.imagePrompts ?? {}) });
          setLoadError(null);
        })
        .catch((err: Error) => setLoadError(err.message)),
    [projectId],
  );

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const handleEvent = useCallback((event: DesignEvent) => {
    switch (event.type) {
      case "status":
        setLogs((cur) => [...cur, event.message]);
        break;
      case "done":
        setPrompts({ ...(event.artwork.imagePrompts ?? {}) });
        setProject((cur) => (cur ? { ...cur, artwork: event.artwork } : cur));
        setLogs((cur) => [...cur, "완료"]);
        break;
      case "error":
        setRunError(event.message);
        break;
      default:
        break;
    }
  }, []);

  async function handleGenerate() {
    if (running) return;
    setRunning(true);
    setRunError(null);
    setLogs([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/design/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `요청 실패 (${res.status})`);
      }
      await readDesignStream(res, handleEvent);
    } catch (err) {
      if (!controller.signal.aborted) {
        setRunError(err instanceof Error ? err.message : String(err));
      } else {
        setLogs((cur) => [...cur, "중단됨"]);
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  async function handleCopy(part: ArtworkPart) {
    const text = prompts[part];
    if (!text) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(part);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopyError("클립보드에 복사하지 못했습니다. 본문을 직접 선택해 복사하세요.");
    }
  }

  if (loadError) {
    return (
      <p className="rounded-lg border border-rose/40 bg-rose/10 px-4 py-3 text-sm text-rose">
        {loadError}
      </p>
    );
  }
  if (!project) {
    return <p className="text-sm text-fg-muted">앨범을 불러오는 중…</p>;
  }

  const hasPrompts = ARTWORK_PARTS.some((part) => prompts[part]);
  const concept = project.concept?.trim();
  const designHref = `/album/${encodeURIComponent(projectId)}/design`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href={designHref}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim transition hover:text-fg-muted"
          >
            ← 디자인 화면으로
          </Link>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-fg">이미지 프롬프트</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            앨범 정보와 컨셉으로 5개 영역 각각의 ChatGPT 이미지 생성 프롬프트를 만듭니다.
            글자는 앱이 나중에 얹으므로 프롬프트는 배경 그림만 요청합니다.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={running}
            className="rounded-xl bg-amber px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "생성 중…" : hasPrompts ? "프롬프트 다시 생성" : "프롬프트 생성"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-rose/50 px-3 py-1.5 text-xs text-rose transition hover:bg-rose/10"
            >
              중단
            </button>
          )}
        </div>
      </div>

      <section className="rounded-xl border border-line bg-panel/60 p-5 text-sm">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
          사용되는 정보
        </h3>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-fg-dim">앨범</dt>
          <dd className="truncate text-fg">
            {project.title} — {project.artist}
          </dd>
          <dt className="text-fg-dim">트랙</dt>
          <dd className="text-fg-muted">{project.tracks.length}곡</dd>
          <dt className="text-fg-dim">전체 컨셉</dt>
          <dd className={concept ? "whitespace-pre-wrap text-fg-muted" : "text-amber"}>
            {concept || "지정 없음 — 디자인 화면에서 컨셉을 적으면 더 정확해집니다"}
          </dd>
        </dl>
        <p className="mt-3 text-[11px] text-fg-dim">
          영역별 지시(디자인 화면의 &ldquo;AI 디자인&rdquo; 영역 입력칸)도 함께 반영됩니다.
          수정했다면 디자인 화면에서 입력칸 밖을 눌러 저장한 뒤 생성하세요.
        </p>
      </section>

      {(logs.length > 0 || runError) && (
        <section className="rounded-xl border border-line bg-ink/60 p-4">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
            진행 상황
          </h3>
          <div className="mt-2 max-h-40 overflow-y-auto font-mono text-[11px] leading-5 text-fg-muted">
            {logs.map((line, i) => (
              <div key={`${i}-${line}`}>{line}</div>
            ))}
          </div>
          {running && (
            <p className="mt-2 text-xs text-fg-dim">
              로컬 AI CLI 를 호출합니다. 1~2분 걸릴 수 있으니 이 탭을 열어 두세요.
            </p>
          )}
          {runError && <p className="mt-2 text-xs text-rose">{runError}</p>}
        </section>
      )}

      {copyError && <p className="text-xs text-rose">{copyError}</p>}

      {hasPrompts ? (
        <div className="grid gap-4 md:grid-cols-2">
          {ARTWORK_PARTS.map((part) => {
            const text = prompts[part];
            return (
              <article
                key={part}
                className="flex flex-col rounded-xl border border-line bg-panel/60 p-4"
              >
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-fg">{PART_LABELS[part]}</h3>
                    <p className="mt-0.5 text-[11px] text-fg-dim">{ASPECT_NOTE[part]}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(part)}
                    disabled={!text}
                    className={`rounded-lg border px-3 py-1.5 text-xs transition disabled:opacity-30 ${
                      copied === part
                        ? "border-teal/60 bg-teal/10 text-teal"
                        : "border-line text-fg-muted hover:bg-panel-2 hover:text-fg"
                    }`}
                  >
                    {copied === part ? "복사됨 ✓" : "복사"}
                  </button>
                </header>
                {text ? (
                  <p className="mt-3 flex-1 select-text whitespace-pre-wrap rounded-lg border border-line/70 bg-ink/50 px-3 py-2.5 text-[13px] leading-6 text-fg">
                    {text}
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-fg-dim">아직 프롬프트가 없습니다.</p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        !running && (
          <p className="rounded-xl border border-dashed border-line px-6 py-14 text-center text-sm text-fg-dim">
            아직 만든 프롬프트가 없습니다. &ldquo;프롬프트 생성&rdquo;을 누르세요.
          </p>
        )
      )}

      <section className="rounded-xl border border-teal/30 bg-teal/5 p-4 text-sm text-fg-muted">
        복사한 프롬프트를 ChatGPT에 붙여넣어 이미지를 만들고, 디자인 화면에서 업로드 →
        해당 영역을 &lsquo;내 사진&rsquo;으로 지정하세요.
        <div className="mt-3">
          <Link
            href={designHref}
            className="inline-flex items-center gap-1 rounded-lg border border-teal/50 px-3 py-1.5 text-xs text-teal transition hover:bg-teal/10"
          >
            디자인 화면으로 돌아가기 →
          </Link>
        </div>
      </section>
    </div>
  );
}
