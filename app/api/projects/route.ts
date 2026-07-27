import { createProject, listProjects } from "@/lib/storage";

// GET /api/projects → AlbumProject[]
export async function GET() {
  const projects = await listProjects();
  return Response.json(projects);
}

// POST /api/projects  body: { title, artist } → AlbumProject
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const { title, artist } = (body ?? {}) as { title?: unknown; artist?: unknown };
  const project = await createProject({
    title: typeof title === "string" ? title : "",
    artist: typeof artist === "string" ? artist : "",
  });
  return Response.json(project, { status: 201 });
}
