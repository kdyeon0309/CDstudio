"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AlbumProject,
  ArtworkPart,
  ArtworkVariant,
  DesignEvent,
} from "@/lib/types";
import { PRINT_SPECS } from "@/lib/types";

const PX_PER_MM = 96 / 25.4;
const PREVIEW_SCALE = 0.34;

interface PartMeta {
  part: ArtworkPart;
  label: string;
  widthMm: number;
  heightMm: number;
  note: string;
}

const PARTS: PartMeta[] = [
  {
    part: "front",
    label: "앞커버",
    widthMm: PRINT_SPECS.front.widthMm,
    heightMm: PRINT_SPECS.front.heightMm,
    note: `${PRINT_SPECS.front.widthMm}×${PRINT_SPECS.front.heightMm}mm`,
  },
  {
    part: "back",
    label: "뒷커버",
    widthMm: PRINT_SPECS.back.widthMm,
    heightMm: PRINT_SPECS.back.heightMm,
    note: `${PRINT_SPECS.back.widthMm}×${PRINT_SPECS.back.heightMm}mm · 스파인 ${PRINT_SPECS.back.spineMm}mm`,
  },
  {
    part: "label",
    label: "CD 라벨",
    widthMm: PRINT_SPECS.label.outerDiameterMm,
    heightMm: PRINT_SPECS.label.outerDiameterMm,
    note: `Ø${PRINT_SPECS.label.outerDiameterMm}mm · 내경 Ø${PRINT_SPECS.label.innerDiameterMm}mm`,
  },
];

/** SSE 응답을 읽어 DesignEvent 로 콜백 */
async function readDesignStream(
  response: Response,
  onEvent: (event: DesignEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("응답 스트림이 없습니다");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue; // 하트비트 주석(: keep-alive) 등
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()) as DesignEvent);
      } catch {
        /* 부분 프레임 무시 */
      }
    }
  }
}

export default function DesignClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [concept, setConcept] = useState("");
  const [conceptSaved, setConceptSaved] = useState(false);

  const [uploads, setUploads] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<"generate" | "refine" | null>(null);
  const [refiningIndex, setRefiningIndex] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [rev, setRev] = useState<Record<number, number>>({});

  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // ── 로드 ──────────────────────────────────────────────────
  const loadProject = useCallback(
    () =>
      fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error(`앨범을 불러오지 못했습니다 (${res.status})`);
          return (await res.json()) as AlbumProject;
        })
        .then((data) => {
          setProject(data);
          setConcept((cur) => (cur ? cur : (data.concept ?? "")));
          setLoadError(null);
        })
        .catch((err: Error) => setLoadError(err.message)),
    [projectId],
  );

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [logs]);

  // ── 컨셉 저장 ─────────────────────────────────────────────
  const saveConcept = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept }),
      });
      const data = (await res.json().catch(() => null)) as
        | (AlbumProject & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `컨셉 저장 실패 (${res.status})`);
      }
      setProject(data as AlbumProject);
      setConceptSaved(true);
      window.setTimeout(() => setConceptSaved(false), 2000);
      return true;
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [concept, projectId]);

  // ── 사진 업로드 ───────────────────────────────────────────
  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/assets`,
          { method: "POST", body: form },
        );
        const data = (await res.json()) as { filename?: string; error?: string };
        if (!res.ok || !data.filename) {
          throw new Error(data.error ?? `업로드 실패 (${res.status})`);
        }
        setUploads((cur) => [...cur, data.filename as string]);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  // ── 3안 생성 ──────────────────────────────────────────────
  async function handleGenerate() {
    if (busy) return;
    setBusy("generate");
    setRunError(null);
    setLogs([]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const saved = await saveConcept(); // 서버가 project.concept 을 읽으므로 먼저 저장
      if (!saved) return;
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as { error?: string } | null)?.error ?? `생성 요청 실패 (${res.status})`,
        );
      }
      await readDesignStream(res, handleEvent);
    } catch (err) {
      if (!controller.signal.aborted) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
      void loadProject();
    }
  }

  // ── 피드백 반영(refine) ───────────────────────────────────
  async function handleRefine(index: number) {
    if (busy) return;
    const text = (feedback[index] ?? "").trim();
    if (!text) return;
    setBusy("refine");
    setRefiningIndex(index);
    setRunError(null);
    setLogs([]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/design/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, variant: index, feedback: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as { error?: string } | null)?.error ?? `수정 요청 실패 (${res.status})`,
        );
      }
      await readDesignStream(res, handleEvent);
      setFeedback((cur) => ({ ...cur, [index]: "" }));
    } catch (err) {
      if (!controller.signal.aborted) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
      setRefiningIndex(null);
      abortRef.current = null;
      void loadProject();
    }
  }

  function handleEvent(event: DesignEvent) {
    switch (event.type) {
      case "status":
        setLogs((cur) => [...cur, event.message]);
        break;
      case "variant-done":
        setLogs((cur) => [...cur, `${event.variant.index}안 저장 완료`]);
        setProject((cur) => (cur ? mergeVariant(cur, event.variant) : cur));
        // iframe 캐시 무효화
        setRev((cur) => ({ ...cur, [event.variant.index]: (cur[event.variant.index] ?? 0) + 1 }));
        break;
      case "done":
        setProject((cur) => (cur ? { ...cur, artwork: event.artwork } : cur));
        setLogs((cur) => [...cur, "완료"]);
        break;
      case "error":
        setRunError(event.message);
        break;
    }
  }

  // ── 안 선택 ───────────────────────────────────────────────
  async function handleSelect(index: number) {
    if (!project) return;
    const artwork = { ...project.artwork, selected: index };
    const patch: Record<string, unknown> = { artwork };
    if (project.status !== "burned") patch.status = "designed";
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) setProject((await res.json()) as AlbumProject);
  }

  // ── 렌더 ──────────────────────────────────────────────────
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

  const variants = [...(project.artwork?.variants ?? [])].sort((a, b) => a.index - b.index);
  const selected = project.artwork?.selected;
  const running = busy !== null;

  return (
    <div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* ── 좌: 입력 패널 ── */}
      <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
        <section className="rounded-xl border border-line bg-panel/60 p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
            앨범
          </h2>
          <p className="mt-2 truncate text-base font-semibold text-fg">{project.title}</p>
          <p className="truncate text-sm text-fg-muted">{project.artist}</p>
          <p className="mt-2 text-xs text-fg-dim">
            트랙 {project.tracks.length}곡 — 뒷커버 트랙리스트에 그대로 들어갑니다
          </p>
          {project.tracks.length === 0 && (
            <p className="mt-2 text-xs text-amber">
              트랙이 없습니다. 먼저 ① 트랙 단계에서 추출하세요.
            </p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel/60 p-5">
          <label
            htmlFor="concept"
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim"
          >
            컨셉 프롬프트
          </label>
          <textarea
            id="concept"
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            rows={5}
            disabled={running}
            placeholder="예: 새벽 도시의 네온, 필름 그레인, 차가운 청록과 자홍 대비. 손글씨 느낌 제목."
            className="mt-2 w-full resize-y rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-dim focus:border-amber/60 disabled:opacity-50"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void saveConcept()}
              disabled={running}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-panel-2 hover:text-fg disabled:opacity-40"
            >
              컨셉 저장
            </button>
            {conceptSaved && <span className="text-xs text-teal">저장됨</span>}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel/60 p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
            사진 (선택)
          </h2>
          <p className="mt-2 text-xs text-fg-dim">
            업로드한 사진은 base64 로 아트워크 HTML 안에 직접 삽입됩니다.
            최대 3장 · 개당 5MB 까지 사용합니다.
          </p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            disabled={uploading || running}
            onChange={(e) => {
              void handleUpload(e.target.files);
              e.target.value = "";
            }}
            className="mt-3 block w-full text-xs text-fg-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-panel-2 file:px-3 file:py-1.5 file:text-xs file:text-fg-muted hover:file:text-fg"
          />
          {uploading && <p className="mt-2 text-xs text-fg-muted">업로드 중…</p>}
          {uploadError && <p className="mt-2 text-xs text-rose">{uploadError}</p>}
          {uploads.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2">
              {uploads.map((name) => (
                <li key={name} className="overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/projects/${encodeURIComponent(projectId)}/file?type=asset&name=${encodeURIComponent(name)}`}
                    alt={name}
                    className="h-16 w-full object-cover"
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={running}
            className="w-full rounded-xl bg-amber px-4 py-3 text-sm font-semibold text-ink transition hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "generate" ? "생성 중…" : "3안 생성"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="w-full rounded-xl border border-rose/50 px-4 py-2 text-sm text-rose transition hover:bg-rose/10"
            >
              중단
            </button>
          )}
          <p className="text-xs text-fg-dim">
            로컬 Claude CLI 를 호출합니다. 안당 수 분 걸릴 수 있으니 이 탭을 열어 두세요.
          </p>
        </section>

        {(logs.length > 0 || runError) && (
          <section className="rounded-xl border border-line bg-ink/60 p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
              진행 상황
              {refiningIndex !== null && ` · ${refiningIndex}안 수정`}
            </h2>
            <div className="mt-2 max-h-52 overflow-y-auto font-mono text-[11px] leading-5 text-fg-muted">
              {logs.map((line, i) => (
                <div key={`${i}-${line}`}>{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
            {runError && <p className="mt-2 text-xs text-rose">{runError}</p>}
          </section>
        )}
      </aside>

      {/* ── 우: 3안 미리보기 ── */}
      <section className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-fg">
            디자인 3안{" "}
            <span className="text-sm font-normal text-fg-dim">
              ({variants.length}/3 생성됨)
            </span>
          </h2>
          {selected && (
            <Link
              href={`/album/${projectId}/print`}
              className="rounded-lg border border-teal/50 px-3 py-1.5 text-sm text-teal transition hover:bg-teal/10"
            >
              인쇄 단계로 →
            </Link>
          )}
        </div>

        {variants.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-6 py-16 text-center text-sm text-fg-dim">
            아직 생성된 안이 없습니다. 왼쪽에서 컨셉을 적고 &ldquo;3안 생성&rdquo;을 누르세요.
          </p>
        ) : (
          variants.map((variant) => (
            <VariantCard
              key={variant.index}
              projectId={projectId}
              variant={variant}
              selected={selected === variant.index}
              rev={rev[variant.index] ?? 0}
              busy={running}
              feedback={feedback[variant.index] ?? ""}
              onFeedbackChange={(text) =>
                setFeedback((cur) => ({ ...cur, [variant.index]: text }))
              }
              onSelect={() => void handleSelect(variant.index)}
              onRefine={() => void handleRefine(variant.index)}
            />
          ))
        )}
      </section>
    </div>
  );
}

function mergeVariant(project: AlbumProject, variant: ArtworkVariant): AlbumProject {
  const prev = project.artwork ?? { variants: [] };
  const variants = [...prev.variants.filter((v) => v.index !== variant.index), variant].sort(
    (a, b) => a.index - b.index,
  );
  return { ...project, artwork: { ...prev, variants } };
}

function VariantCard({
  projectId,
  variant,
  selected,
  rev,
  busy,
  feedback,
  onFeedbackChange,
  onSelect,
  onRefine,
}: {
  projectId: string;
  variant: ArtworkVariant;
  selected: boolean;
  rev: number;
  busy: boolean;
  feedback: string;
  onFeedbackChange: (text: string) => void;
  onSelect: () => void;
  onRefine: () => void;
}) {
  return (
    <article
      className={`rounded-xl border bg-panel/60 p-5 transition ${
        selected ? "border-amber/70 ring-1 ring-amber/40" : "border-line"
      }`}
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-fg-dim">{variant.index}안</span>
          <h3 className="text-base font-semibold text-fg">{variant.name}</h3>
          {selected && (
            <span className="rounded-full bg-amber/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-bright ring-1 ring-amber/40">
              선택됨
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onSelect}
          disabled={selected}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            selected
              ? "cursor-default border border-line text-fg-dim"
              : "bg-amber text-ink hover:bg-amber-bright"
          }`}
        >
          {selected ? "선택된 안" : "이 안 선택"}
        </button>
      </header>

      <div className="flex flex-wrap gap-5">
        {PARTS.map((meta) => (
          <ArtPreview
            key={meta.part}
            projectId={projectId}
            filename={variant.files[meta.part]}
            meta={meta}
            rev={rev}
          />
        ))}
      </div>

      <div className="mt-5 border-t border-line/70 pt-4">
        <label
          htmlFor={`fb-${variant.index}`}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim"
        >
          이 안 수정 요청
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <textarea
            id={`fb-${variant.index}`}
            value={feedback}
            onChange={(e) => onFeedbackChange(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="예: 제목 글자를 더 크게, 배경은 더 어둡게. 라벨은 사진 대신 단색으로."
            className="min-w-[240px] flex-1 resize-y rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-dim focus:border-amber/60 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={onRefine}
            disabled={busy || !feedback.trim()}
            className="h-fit rounded-lg border border-teal/50 px-3 py-2 text-sm text-teal transition hover:bg-teal/10 disabled:opacity-30"
          >
            수정 반영
          </button>
        </div>
      </div>
    </article>
  );
}

function ArtPreview({
  projectId,
  filename,
  meta,
  rev,
}: {
  projectId: string;
  filename: string;
  meta: PartMeta;
  rev: number;
}) {
  const width = meta.widthMm * PX_PER_MM;
  const height = meta.heightMm * PX_PER_MM;
  const src = `/api/projects/${encodeURIComponent(projectId)}/file?type=artwork&name=${encodeURIComponent(
    filename,
  )}&v=${rev}`;

  return (
    <figure className="space-y-1.5">
      <div
        className="overflow-hidden rounded-lg border border-line bg-white"
        style={{ width: width * PREVIEW_SCALE, height: height * PREVIEW_SCALE }}
      >
        <iframe
          key={src}
          src={src}
          title={`${meta.label} 미리보기`}
          sandbox=""
          scrolling="no"
          style={{
            width,
            height,
            border: 0,
            transform: `scale(${PREVIEW_SCALE})`,
            transformOrigin: "top left",
            pointerEvents: "none",
          }}
        />
      </div>
      <figcaption className="text-[11px] text-fg-dim">
        {meta.label} · {meta.note}
      </figcaption>
    </figure>
  );
}
