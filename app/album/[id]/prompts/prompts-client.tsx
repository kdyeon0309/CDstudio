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
  const [selectedParts, setSelectedParts] = useState<ArtworkPart[]>([...ARTWORK_PARTS]);
  const [feeling, setFeeling] = useState("");
  const [latestGeneratedParts, setLatestGeneratedParts] = useState<ArtworkPart[] | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const requestedPartsRef = useRef<ArtworkPart[]>([]);

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
        setLatestGeneratedParts(requestedPartsRef.current);
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
    if (running || selectedParts.length === 0) return;
    const requestedParts = [...selectedParts];
    requestedPartsRef.current = requestedParts;
    setRunning(true);
    setRunError(null);
    setLogs([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/design/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, parts: requestedParts, feeling }),
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

  function togglePart(part: ArtworkPart) {
    if (running) return;
    setSelectedParts((current) =>
      current.includes(part)
        ? current.filter((selected) => selected !== part)
        : ARTWORK_PARTS.filter((candidate) => candidate === part || current.includes(candidate)),
    );
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
  const visibleParts = ARTWORK_PARTS.filter((part) => prompts[part]);
  const hasSelection = selectedParts.length > 0;
  const concept = project.concept?.trim();
  const designHref = `/album/${encodeURIComponent(projectId)}/design`;

  return (
    <div className="space-y-6">
      <div className="min-w-0">
        <Link
          href={designHref}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim transition hover:text-fg-muted"
        >
          ← 디자인 화면으로
        </Link>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-fg">이미지 프롬프트</h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          만들 영역과 원하는 느낌을 고르면 ChatGPT 이미지 생성 프롬프트를 만듭니다. 글자는
          앱이 나중에 얹으므로 프롬프트는 배경 그림만 요청합니다.
        </p>
      </div>

      <section className="space-y-5 rounded-xl border border-line bg-panel/60 p-5">
        <fieldset disabled={running}>
          <legend className="text-sm font-semibold text-fg">1. 영역 선택</legend>
          <p className="mt-1 text-xs text-fg-dim">프롬프트를 새로 만들 영역을 하나 이상 고르세요.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {ARTWORK_PARTS.map((part) => {
              const checked = selectedParts.includes(part);
              return (
                <label
                  key={part}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition ${
                    checked
                      ? "border-amber/70 bg-amber/10 text-amber"
                      : "border-line text-fg-muted hover:bg-panel-2 hover:text-fg"
                  } ${running ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePart(part)}
                    className="accent-amber"
                  />
                  {PART_LABELS[part]}
                </label>
              );
            })}
          </div>
          {!hasSelection && (
            <p className="mt-2 text-xs text-rose">생성할 영역을 최소 1개 선택하세요.</p>
          )}
        </fieldset>

        <div>
          <label htmlFor="prompt-feeling" className="text-sm font-semibold text-fg">
            2. 원하는 느낌
          </label>
          <p className="mt-1 text-xs text-fg-dim">
            선택 입력입니다. 비우면 저장된 앨범 컨셉만 사용합니다.
          </p>
          <textarea
            id="prompt-feeling"
            value={feeling}
            onChange={(event) => setFeeling(event.target.value)}
            maxLength={2000}
            disabled={running}
            rows={4}
            placeholder="예: 새벽 감성, 필름 사진 질감, 보라색 네온"
            className="mt-3 w-full resize-y rounded-lg border border-line bg-ink/50 px-3 py-2.5 text-sm leading-6 text-fg outline-none transition placeholder:text-fg-dim focus:border-amber/60 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="mt-1 text-right font-mono text-[10px] text-fg-dim">
            {feeling.length.toLocaleString()} / 2,000
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={running || !hasSelection}
            className="rounded-xl bg-amber px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "생성 중…" : "프롬프트 생성"}
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
          {!running && hasSelection && (
            <span className="text-xs text-fg-dim">선택한 {selectedParts.length}개 영역을 생성합니다.</span>
          )}
        </div>
      </section>

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
          {visibleParts.map((part) => {
            const text = prompts[part] as string;
            const isPrevious =
              latestGeneratedParts === null || !latestGeneratedParts.includes(part);
            return (
              <article
                key={part}
                className="flex flex-col rounded-xl border border-line bg-panel/60 p-4"
              >
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-fg">{PART_LABELS[part]}</h3>
                      {isPrevious && (
                        <span className="rounded-full border border-line bg-ink/50 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
                          이전 생성
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-fg-dim">{ASPECT_NOTE[part]}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(part)}
                    className={`rounded-lg border px-3 py-1.5 text-xs transition disabled:opacity-30 ${
                      copied === part
                        ? "border-teal/60 bg-teal/10 text-teal"
                        : "border-line text-fg-muted hover:bg-panel-2 hover:text-fg"
                    }`}
                  >
                    {copied === part ? "복사됨 ✓" : "복사"}
                  </button>
                </header>
                <p className="mt-3 flex-1 select-text whitespace-pre-wrap rounded-lg border border-line/70 bg-ink/50 px-3 py-2.5 text-[13px] leading-6 text-fg">
                  {text}
                </p>
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
