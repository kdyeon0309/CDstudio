"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AlbumProject } from "@/lib/types";
import { formatDuration, totalDurationSec } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";

export default function LibraryPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<AlbumProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        if (!res.ok) throw new Error("목록을 불러오지 못했습니다.");
        const data = (await res.json()) as AlbumProject[];
        if (!active) return;
        setProjects(data);
        setError(null);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "알 수 없는 오류");
        setProjects([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleDelete(id: string, title: string) {
    if (!confirm(`앨범 "${title}" 을(를) 삭제할까요?\n트랙·아트워크 파일이 모두 사라지며 되돌릴 수 없습니다.`)) {
      return;
    }
    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (res.ok) {
      setProjects((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
    } else {
      alert("삭제에 실패했습니다.");
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line/70 bg-panel/40 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <DiscMark />
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-fg">
                CD<span className="text-amber">studio</span>
              </h1>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-fg-dim">
                bootleg mastering desk
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="rounded-md bg-amber px-4 py-2 text-sm font-semibold text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.2)] transition hover:bg-amber-bright active:translate-y-px"
          >
            + 새 앨범
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-[0.18em] text-fg-muted">
            라이브러리
          </h2>
          {projects && (
            <span className="font-mono text-xs text-fg-dim">
              {projects.length}장
            </span>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-md border border-rose/40 bg-rose/10 px-4 py-3 text-sm text-rose">
            {error}
          </p>
        )}

        {projects === null ? (
          <p className="py-20 text-center text-sm text-fg-dim">불러오는 중…</p>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setShowModal(true)} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <AlbumCard key={p.id} project={p} onDelete={handleDelete} />
            ))}
          </ul>
        )}
      </main>

      {showModal && (
        <NewAlbumModal
          onClose={() => setShowModal(false)}
          onCreated={(project) => {
            setShowModal(false);
            router.push(`/album/${project.id}/tracks`);
          }}
        />
      )}
    </div>
  );
}

function AlbumCard({
  project,
  onDelete,
}: {
  project: AlbumProject;
  onDelete: (id: string, title: string) => void;
}) {
  const trackCount = project.tracks.length;
  const total = totalDurationSec(project.tracks);
  return (
    <li className="group relative overflow-hidden rounded-xl border border-line bg-panel transition hover:border-line-strong hover:bg-panel-2">
      <Link href={`/album/${project.id}/tracks`} className="block p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <StatusBadge status={project.status} />
          <span className="font-mono text-[11px] text-fg-dim">
            {trackCount > 0 ? `${trackCount}곡 · ${formatDuration(total)}` : "빈 앨범"}
          </span>
        </div>
        <h3 className="truncate text-base font-semibold text-fg" title={project.title}>
          {project.title}
        </h3>
        <p className="mt-0.5 truncate text-sm text-fg-muted" title={project.artist}>
          {project.artist}
        </p>
        <p className="mt-3 font-mono text-[11px] text-fg-dim">
          {new Date(project.updatedAt).toLocaleDateString("ko-KR", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })}{" "}
          수정
        </p>
      </Link>
      <button
        onClick={() => onDelete(project.id, project.title)}
        aria-label="앨범 삭제"
        title="앨범 삭제"
        className="absolute right-3 top-3 hidden rounded-md border border-line-strong bg-ink/70 p-1.5 text-fg-muted opacity-0 transition hover:border-rose/60 hover:text-rose group-hover:flex group-hover:opacity-100"
      >
        <TrashIcon />
      </button>
    </li>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-panel/40 px-6 py-20 text-center">
      <DiscMark large />
      <p className="mt-5 text-base font-medium text-fg">아직 앨범이 없습니다</p>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">
        음원을 추출해 오디오 CD로 굽고 앨범 아트를 만드는 첫 앨범을 시작해 보세요.
      </p>
      <button
        onClick={onCreate}
        className="mt-6 rounded-md bg-amber px-4 py-2 text-sm font-semibold text-ink transition hover:bg-amber-bright"
      >
        + 새 앨범 만들기
      </button>
    </div>
  );
}

function NewAlbumModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: AlbumProject) => void;
}) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), artist: artist.trim() }),
      });
      if (!res.ok) throw new Error("앨범 생성에 실패했습니다.");
      onCreated((await res.json()) as AlbumProject);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "알 수 없는 오류");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-line-strong bg-panel p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-fg">새 앨범</h2>
        <p className="mt-1 text-sm text-fg-muted">
          제목과 아티스트를 입력하면 트랙 추출 화면으로 이동합니다.
        </p>

        <label className="mt-5 block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-fg-muted">
            앨범 제목
          </span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: Midnight Sessions"
            className="w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg-dim focus:border-amber focus:ring-1 focus:ring-amber/50"
          />
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-fg-muted">
            아티스트
          </span>
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="예: Various Artists"
            className="w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg-dim focus:border-amber focus:ring-1 focus:ring-amber/50"
          />
        </label>

        {err && <p className="mt-3 text-sm text-rose">{err}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-fg-muted transition hover:text-fg"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-amber px-4 py-2 text-sm font-semibold text-ink transition hover:bg-amber-bright disabled:opacity-50"
          >
            {busy ? "생성 중…" : "만들기"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DiscMark({ large = false }: { large?: boolean }) {
  const size = large ? "h-14 w-14" : "h-9 w-9";
  return (
    <div
      className={`${size} relative flex items-center justify-center rounded-full bg-gradient-to-br from-panel-2 to-ink ring-1 ring-line-strong`}
    >
      <div className="absolute inset-[3px] rounded-full border border-line" />
      <div className={`${large ? "h-4 w-4" : "h-2.5 w-2.5"} rounded-full bg-amber`} />
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
