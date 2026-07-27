import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/lib/storage";
import StatusBadge from "@/components/StatusBadge";
import StepNav from "@/components/StepNav";

export default async function AlbumLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line/70 bg-panel/40 backdrop-blur">
        <div className="mx-auto w-full max-w-6xl px-6 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <Link
                href="/"
                className="mb-1 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-dim transition hover:text-fg-muted"
              >
                ← 라이브러리
              </Link>
              <div className="flex items-center gap-3">
                <h1 className="truncate text-xl font-semibold tracking-tight text-fg">
                  {project.title}
                </h1>
                <StatusBadge status={project.status} />
              </div>
              <p className="mt-0.5 truncate text-sm text-fg-muted">
                {project.artist}
              </p>
            </div>
          </div>

          <div className="-mb-px mt-4 overflow-x-auto">
            <StepNav id={id} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
