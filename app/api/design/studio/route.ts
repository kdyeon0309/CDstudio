import { getProject } from "@/lib/storage";
import { promises as fs, constants as fsConstants } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { assetsDir } from "@/lib/storage";
import { rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import {
  StudioError,
  applyStudioAction,
  getStudioPart,
  importStudioCandidate,
  isArtworkPart,
  isSafeStudioImageFilename,
  MAX_STUDIO_BODY_BYTES,
  MAX_STUDIO_CANDIDATES,
  validateStudioPresentation,
  validateStudioPrompt,
  validateStudioReferenceFiles,
  validateStudioReferenceLabels,
  type StudioAction,
} from "@/lib/studio";
import {
  acquireDesignLock,
  acquireDesignPartLock,
  designBusyResponse,
  designPartBusyResponse,
} from "../shared";
import type { AlbumProject, StudioArtworkPart, StudioCandidate } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown): Response {
  if (error instanceof StudioError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "디자인 정보를 저장하지 못했습니다." }, { status: 500 });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const maxBytes = MAX_STUDIO_BODY_BYTES;
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new StudioError("요청 본문이 너무 큽니다.", 413);
  }
  if (!request.body) throw new StudioError("요청 본문이 필요합니다.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new StudioError("요청 본문이 너무 큽니다.", 413);
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioError("올바른 JSON 요청이 아닙니다.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StudioError("요청 형식이 올바르지 않습니다.");
  }
  return parsed as Record<string, unknown>;
}

function readId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) {
    throw new StudioError(`${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

type DraftInput = { action: "draft"; part: StudioArtworkPart; prompt: string };
type ImportInput = { action: "import"; part: StudioArtworkPart; filename: string };

function parseAction(body: Record<string, unknown>): StudioAction | DraftInput | ImportInput {
  const action = body.action;
  if (action === "snapshot") {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) {
      throw new StudioError("세트 이름은 1~80자여야 합니다.");
    }
    return { action, name: body.name.trim() };
  }
  if (action === "restore" || action === "delete-snapshot") {
    return { action, snapshotId: readId(body.snapshotId, "세트 ID") };
  }
  if (action === "print-source") {
    if (body.printSource !== "studio" && body.printSource !== "legacy") {
      throw new StudioError("인쇄 디자인 선택이 올바르지 않습니다.");
    }
    return { action, printSource: body.printSource };
  }
  if (!isArtworkPart(body.part)) throw new StudioError("디자인 영역이 올바르지 않습니다.");
  const part = body.part;
  switch (action) {
    case "import":
      if (!isSafeStudioImageFilename(body.filename)) {
        throw new StudioError("가져올 이미지 파일명이 올바르지 않습니다.");
      }
      return { action, part, filename: body.filename };
    case "draft":
      return { action, part, prompt: validateStudioPrompt(body.prompt) };
    case "select":
    case "favorite":
    case "delete": {
      const candidateId = readId(body.candidateId, "후보 ID");
      if (action === "favorite") {
        if (typeof body.favorite !== "boolean") throw new StudioError("즐겨찾기 값이 올바르지 않습니다.");
        return { action, part, candidateId, favorite: body.favorite };
      }
      return { action, part, candidateId };
    }
    case "presentation":
      return { action, part, presentation: validateStudioPresentation(body.presentation) };
    case "clear":
      return { action, part };
    default:
      throw new StudioError("지원하지 않는 디자인 작업입니다.");
  }
}

const FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_EDGE = 8192;
const OUTPUT_EDGES = [4096, 3072, 2048] as const;

/** ffprobe/ffmpeg 는 인자 배열로만 실행하고 시간·출력량을 제한한다. */
function runImageTool(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) { tooLarge = true; child.kill("SIGKILL"); }
      else output.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new StudioError("이미지 확인 도구를 실행하지 못했습니다.", 500));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new StudioError("이미지 확인 시간이 초과되었습니다.", 422));
      else if (tooLarge || code !== 0) reject(new StudioError("이미지 파일을 읽거나 변환할 수 없습니다.", 422));
      else resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

async function probeImage(filename: string): Promise<{ codec: string; width: number; height: number }> {
  const output = await runImageTool(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
    "-of", "json", filename,
  ], 15_000);
  try {
    const parsed = JSON.parse(output) as { streams?: { codec_name?: string; width?: number; height?: number }[] };
    const image = parsed.streams?.[0];
    if (image && typeof image.codec_name === "string" && Number.isInteger(image.width) && Number.isInteger(image.height)) {
      return { codec: image.codec_name, width: image.width!, height: image.height! };
    }
  } catch { /* invalid decoder metadata */ }
  throw new StudioError("이미지 크기를 확인할 수 없습니다.", 422);
}

async function importUploadedImage(project: AlbumProject, part: StudioArtworkPart, filename: string): Promise<AlbumProject> {
  const projectId = project.id;
  const entry = getStudioPart(project, part);
  if (entry.candidates.length >= MAX_STUDIO_CANDIDATES) {
    throw new StudioError(`영역별 후보는 최대 ${MAX_STUDIO_CANDIDATES}개입니다.`, 409);
  }
  const source = path.join(assetsDir(projectId), filename);
  const sourceStat = await fs.lstat(source).catch(() => null);
  if (!sourceStat) throw new StudioError("업로드 이미지를 찾을 수 없습니다.", 404);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0 || sourceStat.size > MAX_IMPORT_BYTES) {
    throw new StudioError("이미지는 20MB 이하의 일반 파일이어야 합니다.", 422);
  }
  const handle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const signature = Buffer.alloc(12);
  try { await handle.read(signature, 0, 12, 0); } finally { await handle.close(); }
  const ext = path.extname(filename).toLowerCase();
  const png = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  const webp = signature.subarray(0, 4).toString("ascii") === "RIFF"
    && signature.subarray(8, 12).toString("ascii") === "WEBP";
  if (!((ext === ".png" && png) || ((ext === ".jpg" || ext === ".jpeg") && jpeg)
    || (ext === ".webp" && webp))) {
    throw new StudioError("JPEG · PNG · WebP 이미지 형식이 올바르지 않습니다.", 415);
  }
  const metadata = await probeImage(source);
  const expectedCodec = png ? "png" : jpeg ? "mjpeg" : "webp";
  if (metadata.codec !== expectedCodec || metadata.width < 1 || metadata.height < 1
    || metadata.width > MAX_IMPORT_EDGE || metadata.height > MAX_IMPORT_EDGE
    || metadata.width * metadata.height > 64 * 1024 * 1024) {
    throw new StudioError("이미지 형식 또는 해상도가 허용 범위를 벗어났습니다.", 422);
  }

  const id = randomUUID();
  const candidateFilename = `uploaded-${part}-${id}.png`;
  const outputPath = path.join(assetsDir(projectId), candidateFilename);
  let registered = false;
  try {
    // 원본을 매번 새로 읽어 20MB에 드는 가장 큰 PNG를 택한다. JPEG EXIF 자동 회전은 유지한다.
    const conversionDeadline = Date.now() + 30_000;
    let normalized: Awaited<ReturnType<typeof probeImage>> | null = null;
    for (const edge of OUTPUT_EDGES) {
      const remainingMs = conversionDeadline - Date.now();
      if (remainingMs <= 0) throw new StudioError("이미지 변환 시간이 초과되었습니다.", 422);
      await runImageTool(FFMPEG, [
        "-v", "error", "-xerror", "-n", "-autorotate", "-i", source,
        "-map", "0:v:0", "-frames:v", "1",
        "-vf", `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
        "-pix_fmt", "rgba", outputPath,
      ], remainingMs);
      const outputStat = await fs.lstat(outputPath).catch(() => null);
      if (!outputStat || !outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size === 0) {
        throw new StudioError("변환된 이미지 파일을 확인할 수 없습니다.", 422);
      }
      if (outputStat.size > MAX_IMPORT_BYTES) {
        if (edge === OUTPUT_EDGES.at(-1)) throw new StudioError("변환된 이미지 크기가 20MB를 초과했습니다.", 422);
        await fs.unlink(outputPath);
        continue;
      }
      normalized = await probeImage(outputPath);
      if (normalized.codec !== "png" || normalized.width < 1 || normalized.height < 1
        || normalized.width > edge || normalized.height > edge) {
        throw new StudioError("변환된 이미지 크기를 확인할 수 없습니다.", 422);
      }
      break;
    }
    if (!normalized) throw new StudioError("변환된 이미지 크기가 20MB를 초과했습니다.", 422);
    const candidate: StudioCandidate = {
      id,
      filename: candidateFilename,
      source: "upload",
      prompt: "",
      referenceFiles: [],
      width: normalized.width,
      height: normalized.height,
      createdAt: new Date().toISOString(),
    };
    const project = await importStudioCandidate(projectId, part, candidate);
    registered = true;
    return project;
  } finally {
    if (!registered) await fs.unlink(outputPath).catch(() => {});
  }
}

async function requireCandidateFiles(projectId: string, project: AlbumProject, action: StudioAction): Promise<void> {
  const files: string[] = [];
  if (action.action === "select") {
    const candidate = project.studio?.parts[action.part]?.candidates.find((item) => item.id === action.candidateId);
    if (!candidate) throw new StudioError("해당 후보를 찾을 수 없습니다.", 404);
    files.push(candidate.filename);
  } else if (action.action === "restore") {
    const snapshot = project.studio?.snapshots.find((item) => item.id === action.snapshotId);
    if (!snapshot) throw new StudioError("저장된 세트를 찾을 수 없습니다.", 404);
    for (const [part, selected] of Object.entries(snapshot.parts)) {
      if (!isArtworkPart(part) || !selected) continue;
      const candidate = project.studio?.parts[part]?.candidates.find((item) => item.id === selected.candidateId);
      if (!candidate) throw new StudioError("세트에 필요한 이미지 후보를 찾을 수 없습니다.", 409);
      files.push(candidate.filename);
    }
  }
  for (const filename of files) {
    const stat = await fs.lstat(path.join(assetsDir(projectId), filename)).catch(() => null);
    if (!stat?.isFile()) throw new StudioError("이미지 파일이 없어 후보를 선택할 수 없습니다.", 409);
  }
}

// GET /api/design/studio?projectId=... → AlbumProject
export async function GET(request: Request) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId || !/^[a-zA-Z0-9-]{1,100}$/.test(projectId)) {
    return Response.json({ error: "projectId 가 필요합니다." }, { status: 400 });
  }
  const project = await getProject(projectId).catch(() => null);
  if (!project) return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  return Response.json(project);
}

// PATCH /api/design/studio  { projectId, action, ... } → AlbumProject
export async function PATCH(request: Request) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  let body: Record<string, unknown>;
  let projectId: string;
  let action: StudioAction | DraftInput | ImportInput;
  try {
    body = await readBody(request);
    projectId = readId(body.projectId, "projectId");
    action = parseAction(body);
  } catch (error) {
    return errorResponse(error);
  }

  const partScoped = "part" in action;
  const lock = "part" in action
    ? acquireDesignPartLock(projectId, action.part)
    : acquireDesignLock(projectId);
  if (!lock) return partScoped ? designPartBusyResponse() : designBusyResponse();
  try {
    const project = await getProject(projectId).catch(() => null);
    if (!project) throw new StudioError("앨범을 찾을 수 없습니다.", 404);
    if (action.action === "import") {
      return Response.json(await importUploadedImage(project, action.part, action.filename));
    }
    if (action.action === "draft" && !('referenceFiles' in action)) {
      const referenceFiles = await validateStudioReferenceFiles(projectId, body.referenceFiles);
      const resolvedLabels = validateStudioReferenceLabels(referenceFiles, body.referenceLabels);
      const explicitLabels = body.referenceLabels as Record<string, string> | undefined;
      action = {
        action: "draft",
        part: action.part,
        prompt: action.prompt,
        referenceFiles,
        // Drafts retain only names the user chose; ordinal defaults follow attachment order.
        referenceLabels: Object.fromEntries(referenceFiles
          .filter((filename) => explicitLabels && Object.prototype.hasOwnProperty.call(explicitLabels, filename))
          .map((filename) => [filename, resolvedLabels[filename]])),
      };
    }
    await requireCandidateFiles(projectId, project, action);
    return Response.json(await applyStudioAction(projectId, action));
  } catch (error) {
    return errorResponse(error);
  } finally {
    releaseJobLock(lock.key, lock.token);
  }
}
