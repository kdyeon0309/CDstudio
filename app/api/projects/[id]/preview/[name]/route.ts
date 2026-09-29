import path from "path";
import { GET as getProjectFile } from "../../file/route";

type Ctx = { params: Promise<{ id: string; name: string }> };

export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

// GET /api/projects/[id]/preview/[name]
// next/image 전용 queryless 경로. 실제 파일 검증과 스트리밍은 기존 file GET에 위임한다.
export async function GET(request: Request, { params }: Ctx) {
  const { id, name } = await params;
  const requestUrl = new URL(request.url);
  const extension = path.extname(name).toLowerCase();
  if (
    requestUrl.search ||
    !name ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    path.basename(name) !== name ||
    !IMAGE_EXTENSIONS.has(extension)
  ) {
    return Response.json({ error: "올바른 이미지 파일명이 아닙니다." }, { status: 400 });
  }

  const fileUrl = new URL(`/api/projects/${encodeURIComponent(id)}/file`, requestUrl);
  fileUrl.searchParams.set("type", "asset");
  fileUrl.searchParams.set("name", name);
  const fileRequest = new Request(fileUrl, {
    method: "GET",
    headers: request.headers,
    signal: request.signal,
  });
  return getProjectFile(fileRequest, { params: Promise.resolve({ id }) });
}
