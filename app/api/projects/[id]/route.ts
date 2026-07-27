import { deleteProject, getProject, updateProject } from "@/lib/storage";
import type { AlbumProject } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/projects/[id] → AlbumProject
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json(project);
}

// PATCH /api/projects/[id]  body: Partial<AlbumProject> → AlbumProject
export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  // id / createdAt 은 변경 불가 (storage.updateProject 가 강제로 유지하지만 방어적으로 제거)
  const patch = { ...(body as Record<string, unknown>) };
  delete patch.id;
  delete patch.createdAt;
  const updated = await updateProject(
    id,
    patch as Partial<Omit<AlbumProject, "id" | "createdAt">>,
  );
  if (!updated) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json(updated);
}

// DELETE /api/projects/[id] → { ok: true }
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const ok = await deleteProject(id);
  if (!ok) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json({ ok: true });
}
