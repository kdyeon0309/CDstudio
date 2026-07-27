import { promises as fs } from "fs";
import path from "path";
import { assetsDir, artworkDir, tracksDir } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

const CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

// GET /api/projects/[id]/file?type=track|artwork|asset&name=...
export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const name = searchParams.get("name");

  if (!name) {
    return Response.json({ error: "name 파라미터가 필요합니다." }, { status: 400 });
  }
  // 경로 탈출 방지: basename 이 원본과 다르면 (슬래시/.. 포함) 거부
  const base = path.basename(name);
  if (base !== name || base === "" || base === "." || base === "..") {
    return Response.json({ error: "잘못된 파일명입니다." }, { status: 400 });
  }

  let dir: string;
  let defaultType: string;
  try {
    switch (type) {
      case "track":
        dir = tracksDir(id);
        defaultType = "audio/wav";
        break;
      case "artwork":
        dir = artworkDir(id);
        defaultType = "text/html; charset=utf-8";
        break;
      case "asset":
        dir = assetsDir(id);
        defaultType = "application/octet-stream";
        break;
      default:
        return Response.json(
          { error: "type 은 track|artwork|asset 중 하나여야 합니다." },
          { status: 400 },
        );
    }
  } catch {
    // safeId 실패 등
    return Response.json({ error: "잘못된 프로젝트 ID 입니다." }, { status: 400 });
  }

  const filePath = path.join(dir, base);
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return Response.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  }

  const ext = path.extname(base).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? defaultType;

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.length),
      "Cache-Control": "no-store",
    },
  });
}
