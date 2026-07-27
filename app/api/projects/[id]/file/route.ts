import { createReadStream } from "fs";
import { promises as fs } from "fs";
import { Readable } from "stream";
import path from "path";
import { assetsDir, artworkDir, tracksDir } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

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

/** "bytes=start-end" 파싱. 단일 범위만 지원. */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid"; // multipart range 등 미지원 형식
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "invalid";

  let start: number;
  let end: number;
  if (rawStart === "") {
    // suffix range: 마지막 N 바이트
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
    if (end > size - 1) end = size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** Node ReadStream → Web ReadableStream (요청 중단 시 파일 핸들 정리) */
function toWebStream(
  filePath: string,
  range: { start: number; end: number } | undefined,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const nodeStream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  if (signal) {
    if (signal.aborted) nodeStream.destroy();
    else signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
  }
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

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
  let size: number;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return Response.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
    }
    size = stat.size;
  } catch {
    return Response.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  }

  const ext = path.extname(base).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? defaultType;
  // 오디오 미리듣기(seek)를 위해 track 에만 Range 를 지원한다
  const supportsRange = type === "track";

  const commonHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };
  if (supportsRange) commonHeaders["Accept-Ranges"] = "bytes";

  const rangeHeader = supportsRange ? request.headers.get("range") : null;
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, size);
    if (parsed === "invalid" || parsed === null) {
      return new Response(null, {
        status: 416,
        headers: { ...commonHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    const length = parsed.end - parsed.start + 1;
    return new Response(toWebStream(filePath, parsed, request.signal), {
      status: 206,
      headers: {
        ...commonHeaders,
        "Content-Range": `bytes ${parsed.start}-${parsed.end}/${size}`,
        "Content-Length": String(length),
      },
    });
  }

  // 전체 응답도 스트리밍 (WAV 수백 MB 를 메모리에 올리지 않는다)
  return new Response(toWebStream(filePath, undefined, request.signal), {
    status: 200,
    headers: { ...commonHeaders, "Content-Length": String(size) },
  });
}
