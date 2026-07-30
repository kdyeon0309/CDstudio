"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AlbumProject,
  ArtworkPart,
  ArtworkState,
  ArtworkVariant,
  DesignEvent,
  PartMode,
} from "@/lib/types";
import {
  ARTWORK_PARTS,
  DEFAULT_PART_MODES,
  PART_LABELS,
  PRINT_SPECS,
} from "@/lib/types";

const PX_PER_MM = 96 / 25.4;
const PREVIEW_SCALE = 0.3;
/** 안 슬롯 (삭제되어 비어도 자리를 유지한다) */
const VARIANT_SLOTS = [1, 2, 3] as const;

interface PartMeta {
  widthMm: number;
  heightMm: number;
  note: string;
}

const PART_META: Record<ArtworkPart, PartMeta> = {
  front: {
    widthMm: PRINT_SPECS.front.widthMm,
    heightMm: PRINT_SPECS.front.heightMm,
    note: `${PRINT_SPECS.front.widthMm}×${PRINT_SPECS.front.heightMm}mm`,
  },
  "front-inner": {
    widthMm: PRINT_SPECS["front-inner"].widthMm,
    heightMm: PRINT_SPECS["front-inner"].heightMm,
    note: `${PRINT_SPECS["front-inner"].widthMm}×${PRINT_SPECS["front-inner"].heightMm}mm`,
  },
  label: {
    widthMm: PRINT_SPECS.label.outerDiameterMm,
    heightMm: PRINT_SPECS.label.outerDiameterMm,
    note: `Ø${PRINT_SPECS.label.outerDiameterMm}mm · 내경 Ø${PRINT_SPECS.label.innerDiameterMm}mm`,
  },
  back: {
    widthMm: PRINT_SPECS.back.widthMm,
    heightMm: PRINT_SPECS.back.heightMm,
    note: `${PRINT_SPECS.back.widthMm}×${PRINT_SPECS.back.heightMm}mm · 스파인 ${PRINT_SPECS.back.spineMm}mm`,
  },
  "back-inner": {
    widthMm: PRINT_SPECS["back-inner"].widthMm,
    heightMm: PRINT_SPECS["back-inner"].heightMm,
    note: `${PRINT_SPECS["back-inner"].widthMm}×${PRINT_SPECS["back-inner"].heightMm}mm · 스파인 ${PRINT_SPECS["back-inner"].spineMm}mm`,
  },
};

const MODE_OPTIONS: { mode: PartMode; label: string }[] = [
  { mode: "ai", label: "AI 디자인" },
  { mode: "photo", label: "내 사진" },
  { mode: "template", label: "기본 템플릿" },
  { mode: "blank", label: "비움" },
];

const MODE_LABELS: Record<PartMode, string> = {
  ai: "AI 디자인",
  photo: "내 사진",
  template: "기본 템플릿",
  blank: "비움",
};

type PartModes = Record<ArtworkPart, PartMode>;
type PartPhotos = Partial<Record<ArtworkPart, string>>;

/** 저장된 partModes 를 기본값으로 채워 전 영역이 채워진 맵으로 만든다 */
function readModes(artwork: ArtworkState | undefined): PartModes {
  const out: PartModes = { ...DEFAULT_PART_MODES };
  const saved = artwork?.partModes;
  if (saved) {
    for (const part of ARTWORK_PARTS) {
      const mode = saved[part];
      if (mode) out[part] = mode;
    }
  }
  return out;
}

const fileUrl = (projectId: string, type: "artwork" | "asset", name: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/file?type=${type}&name=${encodeURIComponent(name)}`;

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

type Busy = "generate" | "refine" | "part" | "delete" | null;

export default function DesignClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<AlbumProject | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [concept, setConcept] = useState("");
  const [conceptSaved, setConceptSaved] = useState(false);

  const [partModes, setPartModes] = useState<PartModes>({ ...DEFAULT_PART_MODES });
  const [partPhotos, setPartPhotos] = useState<PartPhotos>({});
  const [partsError, setPartsError] = useState<string | null>(null);
  const [partsSaved, setPartsSaved] = useState(false);

  const [assets, setAssets] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<Busy>(null);
  const [refiningIndex, setRefiningIndex] = useState<number | null>(null);
  const [activePart, setActivePart] = useState<{
    variant: number;
    part: ArtworkPart;
  } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  /** iframe 캐시 무효화용 리비전. 키: `${안번호}:${영역}` */
  const [rev, setRev] = useState<Record<string, number>>({});

  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  /** 제작 방식 PATCH 직렬화 (연타 시 경합 방지) */
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  /** 서버 값으로 제작 방식을 초기화했는지 (사용자 편집 덮어쓰기 방지) */
  const partsInitRef = useRef(false);

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
          if (!partsInitRef.current) {
            partsInitRef.current = true;
            setPartModes(readModes(data.artwork));
            setPartPhotos({ ...(data.artwork?.partPhotos ?? {}) });
          }
          setLoadError(null);
        })
        .catch((err: Error) => setLoadError(err.message)),
    [projectId],
  );

  /** 업로드된 사진 목록 (목록 API 미지원이면 조용히 무시) */
  const loadAssets = useCallback(
    () =>
      fetch(`/api/projects/${encodeURIComponent(projectId)}/assets`, {
        cache: "no-store",
      })
        .then(async (res) =>
          res.ok ? ((await res.json()) as { filenames?: string[] }) : null,
        )
        .then((data) => {
          if (data && Array.isArray(data.filenames)) setAssets(data.filenames);
        })
        .catch(() => {
          /* 목록을 못 받아도 업로드는 가능하므로 무시 */
        }),
    [projectId],
  );

  useEffect(() => {
    void loadProject();
    void loadAssets();
  }, [loadProject, loadAssets]);

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

  // ── 제작 방식 저장 ────────────────────────────────────────
  /** 최신 project 를 다시 읽어 artwork 의 다른 필드를 보존한 채 병합 PATCH */
  const persistParts = useCallback(
    (modes: PartModes, photos: PartPhotos): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
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
            partModes: modes,
            partPhotos: photos,
          };
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
            throw new Error(data?.error ?? `제작 방식 저장 실패 (${res.status})`);
          }
          setProject(data as AlbumProject);
          setPartsError(null);
          setPartsSaved(true);
          window.setTimeout(() => setPartsSaved(false), 1500);
          return true;
        } catch (err) {
          setPartsError(err instanceof Error ? err.message : String(err));
          return false;
        }
      };
      const next = saveChainRef.current.then(run, run);
      saveChainRef.current = next;
      return next;
    },
    [projectId],
  );

  function changeMode(part: ArtworkPart, mode: PartMode) {
    const nextModes: PartModes = { ...partModes, [part]: mode };
    setPartModes(nextModes);
    void persistParts(nextModes, partPhotos);
  }

  function changePhoto(part: ArtworkPart, filename: string) {
    const nextPhotos: PartPhotos = { ...partPhotos };
    if (nextPhotos[part] === filename) delete nextPhotos[part];
    else nextPhotos[part] = filename;
    setPartPhotos(nextPhotos);
    void persistParts(partModes, nextPhotos);
  }

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
        const name = data.filename;
        setAssets((cur) => (cur.includes(name) ? cur : [...cur, name]));
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  // ── SSE 이벤트 ────────────────────────────────────────────
  const bumpRev = useCallback((index: number, parts: readonly ArtworkPart[]) => {
    setRev((cur) => {
      const next = { ...cur };
      for (const part of parts) {
        const key = `${index}:${part}`;
        next[key] = (next[key] ?? 0) + 1;
      }
      return next;
    });
  }, []);

  const handleEvent = useCallback(
    (event: DesignEvent) => {
      switch (event.type) {
        case "status":
          setLogs((cur) => [...cur, event.message]);
          break;
        case "variant-done":
          setLogs((cur) => [...cur, `${event.variant.index}안 저장 완료`]);
          setProject((cur) => (cur ? mergeVariant(cur, event.variant) : cur));
          bumpRev(event.variant.index, ARTWORK_PARTS);
          break;
        case "done":
          setProject((cur) => (cur ? { ...cur, artwork: event.artwork } : cur));
          setLogs((cur) => [...cur, "완료"]);
          break;
        case "error":
          setRunError(event.message);
          break;
      }
    },
    [bumpRev],
  );

  /** SSE 엔드포인트 공통 실행기 */
  async function runDesignStream(url: string, body: Record<string, unknown>) {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as { error?: string } | null)?.error ?? `요청 실패 (${res.status})`,
        );
      }
      await readDesignStream(res, handleEvent);
      return true;
    } catch (err) {
      if (!controller.signal.aborted) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
      return false;
    } finally {
      abortRef.current = null;
    }
  }

  /** photo 모드인데 사진을 안 고른 영역이 있으면 이름 목록을 돌려준다 */
  function missingPhotoParts(): string[] {
    return ARTWORK_PARTS.filter(
      (part) => partModes[part] === "photo" && !partPhotos[part],
    ).map((part) => PART_LABELS[part]);
  }

  // ── 3안 생성 ──────────────────────────────────────────────
  async function handleGenerate(regenerateMissing = false) {
    if (busy) return;
    const missing = missingPhotoParts();
    if (missing.length > 0) {
      setRunError(
        `“내 사진”으로 지정한 영역에 쓸 사진을 고르세요: ${missing.join(", ")}`,
      );
      return;
    }
    setBusy("generate");
    setRunError(null);
    setLogs([]);
    try {
      // 서버가 project.concept / artwork.partModes 를 읽으므로 먼저 저장한다
      if (!(await saveConcept())) return;
      if (!(await persistParts(partModes, partPhotos))) {
        setRunError("제작 방식을 저장하지 못해 생성을 중단했습니다.");
        return;
      }
      const body: Record<string, unknown> = { projectId };
      if (regenerateMissing) body.regenerate = "missing";
      await runDesignStream("/api/design", body);
    } finally {
      setBusy(null);
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
    try {
      const ok = await runDesignStream("/api/design/refine", {
        projectId,
        variant: index,
        feedback: text,
      });
      if (ok) setFeedback((cur) => ({ ...cur, [index]: "" }));
    } finally {
      setBusy(null);
      setRefiningIndex(null);
      void loadProject();
    }
  }

  // ── 영역 재생성 ───────────────────────────────────────────
  async function handleRegeneratePart(index: number, part: ArtworkPart) {
    if (busy) return;
    if (partModes[part] === "photo" && !partPhotos[part]) {
      setRunError(`${PART_LABELS[part]} 영역에 쓸 사진을 먼저 고르세요.`);
      return;
    }
    setBusy("part");
    setActivePart({ variant: index, part });
    setRunError(null);
    setLogs([]);
    try {
      await runDesignStream("/api/design/part", { projectId, variant: index, part });
    } finally {
      setBusy(null);
      setActivePart(null);
      void loadProject();
    }
  }

  // ── 영역 삭제 ─────────────────────────────────────────────
  async function handleDeletePart(index: number, part: ArtworkPart) {
    if (busy) return;
    if (!window.confirm(`${index}안의 ${PART_LABELS[part]}를 삭제할까요?`)) return;
    setBusy("delete");
    setRunError(null);
    try {
      const res = await fetch("/api/design/part", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, variant: index, part }),
      });
      const data = (await res.json().catch(() => null)) as
        | { variant?: ArtworkVariant; error?: string }
        | null;
      if (!res.ok || !data?.variant) {
        throw new Error(data?.error ?? `영역 삭제 실패 (${res.status})`);
      }
      const nextVariant = data.variant;
      setProject((cur) => (cur ? mergeVariant(cur, nextVariant) : cur));
      bumpRev(index, [part]);
      setLogs((cur) => [...cur, `${index}안 ${PART_LABELS[part]} 삭제됨`]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // ── 안 삭제 ───────────────────────────────────────────────
  async function handleDeleteVariant(index: number) {
    if (busy) return;
    if (!window.confirm(`${index}안을 통째로 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setBusy("delete");
    setRunError(null);
    try {
      const res = await fetch("/api/design/variant", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, variant: index }),
      });
      const data = (await res.json().catch(() => null)) as
        | { artwork?: ArtworkState; error?: string }
        | null;
      if (!res.ok || !data?.artwork) {
        throw new Error(data?.error ?? `안 삭제 실패 (${res.status})`);
      }
      const nextArtwork = data.artwork;
      setProject((cur) => (cur ? { ...cur, artwork: nextArtwork } : cur));
      bumpRev(index, ARTWORK_PARTS);
      setLogs((cur) => [...cur, `${index}안 삭제됨`]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
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
    else {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setRunError(data?.error ?? `안 선택 저장 실패 (${res.status})`);
    }
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
    <div className="grid gap-8 lg:grid-cols-[340px_minmax(0,1fr)]">
      {/* ── 좌: 입력 패널 ── */}
      <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
        <section className="rounded-xl border border-line bg-panel/60 p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
            앨범
          </h2>
          <p className="mt-2 truncate text-base font-semibold text-fg">{project.title}</p>
          <p className="truncate text-sm text-fg-muted">{project.artist}</p>
          <p className="mt-2 text-xs text-fg-dim">
            트랙 {project.tracks.length}곡 — 뒷표지 트랙리스트에 그대로 들어갑니다
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
            사진 업로드
          </h2>
          <p className="mt-2 text-xs text-fg-dim">
            배경 그림은 ChatGPT 등에서 생성한 이미지를 업로드해 &ldquo;내 사진&rdquo;으로
            지정하면 됩니다.
          </p>
          <p className="mt-1 text-xs text-fg-dim">
            JPEG · PNG · WebP · 개당 5MB 까지. 아트워크 HTML 안에 base64 로 삽입됩니다.
          </p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
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
          {assets.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2">
              {assets.map((name) => (
                <li key={name} className="overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={fileUrl(projectId, "asset", name)}
                    alt={name}
                    className="h-16 w-full object-cover"
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel/60 p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
            영역별 제작 방식
          </h2>
          <p className="mt-2 text-xs text-fg-dim">
            영역마다 AI 디자인 · 내 사진 · 기본 템플릿 · 비움 중에서 고릅니다. 바꾸면 바로
            저장됩니다.
          </p>
          <div className="mt-4 space-y-4">
            {ARTWORK_PARTS.map((part) => (
              <div key={part} className="rounded-lg border border-line/70 bg-ink/40 p-3">
                <p className="text-xs font-semibold text-fg">{PART_LABELS[part]}</p>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  {MODE_OPTIONS.map((opt) => {
                    const active = partModes[part] === opt.mode;
                    return (
                      <button
                        key={opt.mode}
                        type="button"
                        aria-pressed={active}
                        disabled={running}
                        onClick={() => changeMode(part, opt.mode)}
                        className={`rounded-md border px-2 py-1.5 text-[11px] transition disabled:opacity-40 ${
                          active
                            ? "border-amber/70 bg-amber/15 text-amber-bright"
                            : "border-line text-fg-muted hover:bg-panel-2 hover:text-fg"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {partModes[part] === "photo" && (
                  <div className="mt-3">
                    {assets.length === 0 ? (
                      <p className="text-[11px] text-amber">
                        위에서 사진을 먼저 업로드하세요.
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] text-fg-dim">쓸 사진을 고르세요</p>
                        <ul className="mt-1.5 grid grid-cols-3 gap-1.5">
                          {assets.map((name) => {
                            const picked = partPhotos[part] === name;
                            return (
                              <li key={name}>
                                <button
                                  type="button"
                                  disabled={running}
                                  aria-pressed={picked}
                                  onClick={() => changePhoto(part, name)}
                                  title={name}
                                  className={`block w-full overflow-hidden rounded-md border transition disabled:opacity-40 ${
                                    picked
                                      ? "border-amber ring-1 ring-amber/50"
                                      : "border-line hover:border-fg-dim"
                                  }`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={fileUrl(projectId, "asset", name)}
                                    alt={name}
                                    className="h-12 w-full object-cover"
                                  />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                        {!partPhotos[part] && (
                          <p className="mt-1.5 text-[11px] text-amber">
                            사진이 지정되지 않았습니다.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            {partsSaved && <span className="text-xs text-teal">저장됨</span>}
            {partsError && <span className="text-xs text-rose">{partsError}</span>}
          </div>
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
            로컬 AI CLI 를 호출합니다. 안당 수 분 걸릴 수 있으니 이 탭을 열어 두세요.
          </p>
        </section>

        {(logs.length > 0 || runError) && (
          <section className="rounded-xl border border-line bg-ink/60 p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim">
              진행 상황
              {refiningIndex !== null && ` · ${refiningIndex}안 수정`}
              {activePart &&
                ` · ${activePart.variant}안 ${PART_LABELS[activePart.part]} 재생성`}
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
            아직 생성된 안이 없습니다. 왼쪽에서 컨셉과 영역별 제작 방식을 정하고
            &ldquo;3안 생성&rdquo;을 누르세요.
          </p>
        ) : (
          VARIANT_SLOTS.map((index) => {
            const variant = variants.find((v) => v.index === index);
            if (!variant) {
              return (
                <EmptySlotCard
                  key={index}
                  index={index}
                  busy={running}
                  onRegenerate={() => void handleGenerate(true)}
                />
              );
            }
            return (
              <VariantCard
                key={index}
                projectId={projectId}
                variant={variant}
                partModes={partModes}
                selected={selected === index}
                rev={rev}
                busy={running}
                activePart={activePart}
                feedback={feedback[index] ?? ""}
                onFeedbackChange={(text) =>
                  setFeedback((cur) => ({ ...cur, [index]: text }))
                }
                onSelect={() => void handleSelect(index)}
                onRefine={() => void handleRefine(index)}
                onDeleteVariant={() => void handleDeleteVariant(index)}
                onDeletePart={(part) => void handleDeletePart(index, part)}
                onRegeneratePart={(part) => void handleRegeneratePart(index, part)}
              />
            );
          })
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

function EmptySlotCard({
  index,
  busy,
  onRegenerate,
}: {
  index: number;
  busy: boolean;
  onRegenerate: () => void;
}) {
  return (
    <article className="rounded-xl border border-dashed border-line bg-panel/30 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-mono text-xs text-fg-dim">{index}안</span>
          <p className="mt-1 text-sm text-fg-dim">삭제되었거나 아직 만들지 않은 안입니다.</p>
        </div>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={busy}
          className="rounded-lg border border-amber/50 px-3 py-1.5 text-sm text-amber transition hover:bg-amber/10 disabled:opacity-30"
        >
          이 안 다시 생성
        </button>
      </div>
    </article>
  );
}

function VariantCard({
  projectId,
  variant,
  partModes,
  selected,
  rev,
  busy,
  activePart,
  feedback,
  onFeedbackChange,
  onSelect,
  onRefine,
  onDeleteVariant,
  onDeletePart,
  onRegeneratePart,
}: {
  projectId: string;
  variant: ArtworkVariant;
  partModes: PartModes;
  selected: boolean;
  rev: Record<string, number>;
  busy: boolean;
  activePart: { variant: number; part: ArtworkPart } | null;
  feedback: string;
  onFeedbackChange: (text: string) => void;
  onSelect: () => void;
  onRefine: () => void;
  onDeleteVariant: () => void;
  onDeletePart: (part: ArtworkPart) => void;
  onRegeneratePart: (part: ArtworkPart) => void;
}) {
  const filled = ARTWORK_PARTS.filter((part) => variant.files[part]).length;

  return (
    <article
      className={`rounded-xl border bg-panel/60 p-5 transition ${
        selected ? "border-amber/70 ring-1 ring-amber/40" : "border-line"
      }`}
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-fg-dim">{variant.index}안</span>
          <h3 className="text-base font-semibold text-fg">{variant.name}</h3>
          <span className="font-mono text-[10px] text-fg-dim">
            {filled}/{ARTWORK_PARTS.length} 영역
          </span>
          {selected && (
            <span className="rounded-full bg-amber/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-bright ring-1 ring-amber/40">
              선택됨
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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
          <button
            type="button"
            onClick={onDeleteVariant}
            disabled={busy}
            className="rounded-lg border border-rose/50 px-3 py-1.5 text-sm text-rose transition hover:bg-rose/10 disabled:opacity-30"
          >
            안 삭제
          </button>
        </div>
      </header>

      <div className="flex flex-wrap gap-5">
        {ARTWORK_PARTS.map((part) => (
          <ArtPreview
            key={part}
            projectId={projectId}
            part={part}
            filename={variant.files[part]}
            mode={partModes[part]}
            rev={rev[`${variant.index}:${part}`] ?? 0}
            busy={busy}
            regenerating={
              activePart?.variant === variant.index && activePart.part === part
            }
            onDelete={() => onDeletePart(part)}
            onRegenerate={() => onRegeneratePart(part)}
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
  part,
  filename,
  mode,
  rev,
  busy,
  regenerating,
  onDelete,
  onRegenerate,
}: {
  projectId: string;
  part: ArtworkPart;
  filename: string | undefined;
  mode: PartMode;
  rev: number;
  busy: boolean;
  regenerating: boolean;
  onDelete: () => void;
  onRegenerate: () => void;
}) {
  const meta = PART_META[part];
  const label = PART_LABELS[part];
  const width = meta.widthMm * PX_PER_MM;
  const height = meta.heightMm * PX_PER_MM;
  const boxStyle = { width: width * PREVIEW_SCALE, height: height * PREVIEW_SCALE };

  return (
    <figure className="space-y-1.5">
      {filename ? (
        <div
          className="overflow-hidden rounded-lg border border-line bg-white"
          style={boxStyle}
        >
          <iframe
            key={`${filename}-${rev}`}
            src={`${fileUrl(projectId, "artwork", filename)}&v=${rev}`}
            title={`${label} 미리보기`}
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
      ) : (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-line bg-ink/40 text-[11px] text-fg-dim"
          style={boxStyle}
        >
          {regenerating ? "생성 중…" : "비어 있음"}
        </div>
      )}

      <figcaption className="text-[11px] text-fg-dim">
        <span className="text-fg-muted">{label}</span> · {meta.note}
        <br />
        방식: {MODE_LABELS[mode]}
      </figcaption>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onRegenerate}
          disabled={busy}
          className="rounded-md border border-line px-2 py-1 text-[11px] text-fg-muted transition hover:bg-panel-2 hover:text-fg disabled:opacity-30"
        >
          {regenerating ? "재생성 중…" : "재생성"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy || !filename}
          className="rounded-md border border-rose/40 px-2 py-1 text-[11px] text-rose transition hover:bg-rose/10 disabled:opacity-30"
        >
          삭제
        </button>
      </div>
    </figure>
  );
}
