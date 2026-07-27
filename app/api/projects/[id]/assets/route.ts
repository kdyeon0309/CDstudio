import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { assetsDir, getProject, safeFilename } from "@/lib/storage";
import { rejectCrossOrigin } from "@/lib/server-guards";

type Ctx = { params: Promise<{ id: string }> };

/** 업로드 상한 (H8) */
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 파일당 5MB
const MAX_REQUEST_BYTES = 20 * 1024 * 1024; // 요청당 20MB
const MAX_FILES = 5; // 요청당 파일 개수
/** multipart 경계·헤더 오버헤드 여유 */
const MULTIPART_OVERHEAD = 64 * 1024;

type ImageKind = { ext: ".jpg" | ".png" | ".webp"; mime: string };

/** 매직바이트로 이미지 종류를 판별한다 (JPEG/PNG/WebP만 허용) */
function detectImage(head: Uint8Array): ImageKind | null {
  // JPEG: FF D8 FF
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((b, i) => head[i] === b)) {
    return { ext: ".png", mime: "image/png" };
  }
  // WebP: "RIFF" ???? "WEBP"
  const riff = [0x52, 0x49, 0x46, 0x46]; // RIFF
  const webp = [0x57, 0x45, 0x42, 0x50]; // WEBP
  if (
    head.length >= 12 &&
    riff.every((b, i) => head[i] === b) &&
    webp.every((b, i) => head[8 + i] === b)
  ) {
    return { ext: ".webp", mime: "image/webp" };
  }
  return null;
}

/** 확장자를 뗀 원본 이름을 안전화 */
function baseNameOf(original: string): string {
  const withoutExt = original.replace(/\.[^./\\]{1,10}$/, "");
  return safeFilename(withoutExt || "photo").slice(0, 60) || "photo";
}

// POST /api/projects/[id]/assets  multipart(file) → { filename, filenames }
export async function POST(request: Request, { params }: Ctx) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const { id } = await params;

  const project = await getProject(id).catch(() => null);
  if (!project) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }

  // 본문을 파싱하기 전에 Content-Length 로 1차 차단
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES + MULTIPART_OVERHEAD) {
    return Response.json(
      { error: `업로드 용량이 너무 큽니다 (요청당 최대 ${MAX_REQUEST_BYTES / 1024 / 1024}MB).` },
      { status: 413 },
    );
  }

  // Content-Length 를 신뢰하지 않는다 — 본문 스트림을 상한까지만 읽고,
  // 초과하는 즉시 중단한다 (formData() 가 무제한 버퍼링하는 것 방지).
  const hardCap = MAX_REQUEST_BYTES + MULTIPART_OVERHEAD;
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (!request.body) {
    return Response.json({ error: "요청 본문이 없습니다." }, { status: 400 });
  }
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > hardCap) {
        await reader.cancel();
        return Response.json(
          { error: `업로드 용량이 너무 큽니다 (요청당 최대 ${MAX_REQUEST_BYTES / 1024 / 1024}MB).` },
          { status: 413 },
        );
      }
      chunks.push(value);
    }
  } catch {
    return Response.json({ error: "본문을 읽지 못했습니다." }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return Response.json(
      { error: "multipart/form-data 요청이 아닙니다." },
      { status: 400 },
    );
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json(
      { error: "file 필드에 업로드할 사진이 필요합니다." },
      { status: 400 },
    );
  }
  if (files.length > MAX_FILES) {
    return Response.json(
      { error: `한 번에 최대 ${MAX_FILES}개까지 업로드할 수 있습니다.` },
      { status: 413 },
    );
  }

  // 실제 크기 검사 (Content-Length 를 신뢰하지 않는다)
  let total = 0;
  for (const file of files) {
    if (file.size === 0) {
      return Response.json({ error: "빈 파일은 업로드할 수 없습니다." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return Response.json(
        { error: `파일당 최대 ${MAX_FILE_BYTES / 1024 / 1024}MB 까지 업로드할 수 있습니다.` },
        { status: 413 },
      );
    }
    total += file.size;
  }
  if (total > MAX_REQUEST_BYTES) {
    return Response.json(
      { error: `요청당 최대 ${MAX_REQUEST_BYTES / 1024 / 1024}MB 까지 업로드할 수 있습니다.` },
      { status: 413 },
    );
  }

  // 매직바이트 검증 후 확장자는 서버가 강제한다
  const staged: { filename: string; buffer: Buffer }[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) {
      return Response.json(
        { error: `파일당 최대 ${MAX_FILE_BYTES / 1024 / 1024}MB 까지 업로드할 수 있습니다.` },
        { status: 413 },
      );
    }
    const kind = detectImage(buffer.subarray(0, 16));
    if (!kind) {
      return Response.json(
        { error: "JPEG · PNG · WebP 이미지만 업로드할 수 있습니다." },
        { status: 415 },
      );
    }
    const filename = safeFilename(
      `${Date.now()}-${randomUUID().slice(0, 8)}-${baseNameOf(file.name || "photo")}${kind.ext}`,
    );
    staged.push({ filename, buffer });
  }

  const dir = assetsDir(id);
  await fs.mkdir(dir, { recursive: true });
  for (const item of staged) {
    await fs.writeFile(path.join(dir, item.filename), item.buffer);
  }

  const filenames = staged.map((s) => s.filename);
  return Response.json({ filename: filenames[0], filenames }, { status: 201 });
}
