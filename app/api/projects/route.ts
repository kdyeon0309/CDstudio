import { createProject, listProjects } from "@/lib/storage";
import { rejectCrossOrigin } from "@/lib/server-guards";

const MAX_TEXT = 500;

// GET /api/projects → AlbumProject[]
export async function GET() {
  const projects = await listProjects();
  return Response.json(projects);
}

// POST /api/projects  body: { title, artist } → AlbumProject
export async function POST(request: Request) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const { title, artist } = (body ?? {}) as { title?: unknown; artist?: unknown };
  if (
    (title !== undefined && typeof title !== "string") ||
    (artist !== undefined && typeof artist !== "string")
  ) {
    return Response.json(
      { error: "title · artist 는 문자열이어야 합니다." },
      { status: 400 },
    );
  }
  if (
    (typeof title === "string" && title.length > MAX_TEXT) ||
    (typeof artist === "string" && artist.length > MAX_TEXT)
  ) {
    return Response.json({ error: "앨범명 · 아티스트가 너무 깁니다." }, { status: 400 });
  }
  const project = await createProject({
    title: typeof title === "string" ? title : "",
    artist: typeof artist === "string" ? artist : "",
  });
  return Response.json(project, { status: 201 });
}
