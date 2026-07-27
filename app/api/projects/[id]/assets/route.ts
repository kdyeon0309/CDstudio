import { promises as fs } from "fs";
import path from "path";
import { assetsDir, getProject, safeFilename } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/projects/[id]/assets  multipart(file) → { filename }
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;

  const project = await getProject(id).catch(() => null);
  if (!project) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "multipart/form-data 요청이 아닙니다." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json(
      { error: "file 필드에 업로드할 사진이 필요합니다." },
      { status: 400 },
    );
  }

  const dir = assetsDir(id);
  await fs.mkdir(dir, { recursive: true });

  // 충돌 방지 + 경로문자 제거를 위해 타임스탬프를 접두
  const filename = safeFilename(`${Date.now()}-${file.name || "photo"}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(dir, filename), buffer);

  return Response.json({ filename }, { status: 201 });
}
