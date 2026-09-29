import { promises as fs, constants as fsConstants } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { assetsDir, getProject } from "@/lib/storage";
import { rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import {
  appendStudioCandidate,
  getStudioPart,
  isArtworkPart,
  MAX_STUDIO_BODY_BYTES,
  MAX_STUDIO_CANDIDATES,
  StudioError,
  validateStudioReferenceFiles,
  validateStudioReferenceLabels,
} from "@/lib/studio";
import {
  codexImageAvailability,
  createImageWorkspace,
  generateCodexImage,
  ImageGenerationError,
} from "@/lib/image-generation";
import type { StudioArtworkPart, StudioCandidate, StudioImageEvent } from "@/lib/types";
import { acquireDesignLock, designBusyResponse } from "../shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

interface GenerateRequest {
  projectId: string;
  part: StudioArtworkPart;
  prompt: string;
  referenceFiles: string[];
  referenceLabels: Record<string, string>;
  parentCandidateId?: string;
}

function errorResponse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_STUDIO_BODY_BYTES) throw new StudioError("요청 본문이 너무 큽니다.", 413);
  if (!request.body) throw new StudioError("요청 본문이 없습니다.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_STUDIO_BODY_BYTES) {
      await reader.cancel();
      throw new StudioError("요청 본문이 너무 큽니다.", 413);
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new StudioError("요청 형식이 올바르지 않습니다."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StudioError("요청 형식이 올바르지 않습니다.");
  }
  return parsed as Record<string, unknown>;
}

function parseGenerateRequest(body: Record<string, unknown>): GenerateRequest {
  if (typeof body.projectId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(body.projectId)) {
    throw new StudioError("프로젝트 ID가 올바르지 않습니다.");
  }
  if (!isArtworkPart(body.part)) throw new StudioError("표지 영역이 올바르지 않습니다.");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new StudioError("프롬프트를 입력해 주세요.");
  }
  if (!Array.isArray(body.referenceFiles)) throw new StudioError("참고 이미지 목록이 필요합니다.");
  const referenceLabels = validateStudioReferenceLabels(body.referenceFiles as string[], body.referenceLabels);
  if (body.parentCandidateId !== undefined &&
    (typeof body.parentCandidateId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(body.parentCandidateId))) {
    throw new StudioError("수정할 후보 ID가 올바르지 않습니다.");
  }
  return {
    projectId: body.projectId,
    part: body.part,
    prompt: body.prompt.trim(),
    referenceFiles: body.referenceFiles as string[],
    referenceLabels,
    parentCandidateId: body.parentCandidateId as string | undefined,
  };
}

async function stageReference(projectId: string, filename: string, tempDir: string, index: number): Promise<string> {
  const source = path.join(assetsDir(projectId), filename);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_REFERENCE_BYTES) {
    throw new StudioError("참고 이미지는 20MB 이하의 일반 파일이어야 합니다.");
  }
  const staged = path.join(tempDir, `reference-${index}${path.extname(filename).toLowerCase()}`);
  await fs.copyFile(source, staged, fsConstants.COPYFILE_EXCL);
  return staged;
}

function streamGeneration(
  request: Request, input: GenerateRequest, referenceFiles: string[], referenceNames: string[],
  lock: { key: string; token: string },
): Response {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: StudioImageEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
        catch { closed = true; abort(); }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": keep-alive\n\n")); }
        catch { closed = true; abort(); }
      }, 10_000);
      let tempDir: string | undefined;
      let finalPath: string | undefined;
      let registered = false;
      try {
        send({ type: "status", message: "Codex로 이미지를 생성하고 있습니다…" });
        tempDir = await createImageWorkspace();
        const paths: string[] = [];
        for (const [index, filename] of referenceFiles.entries()) {
          paths.push(await stageReference(input.projectId, filename, tempDir, index));
        }
        const outputPath = path.join(tempDir, "generated.png");
        const dimensions = await generateCodexImage({
          cwd: tempDir,
          part: input.part,
          prompt: input.prompt,
          referencePaths: paths,
          referenceNames,
          outputPath,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) throw new ImageGenerationError("이미지 생성이 취소되었습니다.");
        send({ type: "status", message: "생성된 이미지를 확인하고 후보로 저장하고 있습니다…" });
        const id = randomUUID();
        const filename = `generated-${input.part}-${id}.png`;
        finalPath = path.join(assetsDir(input.projectId), filename);
        await fs.mkdir(assetsDir(input.projectId), { recursive: true });
        await fs.copyFile(outputPath, finalPath, fsConstants.COPYFILE_EXCL);
        if (abortController.signal.aborted) throw new ImageGenerationError("이미지 생성이 취소되었습니다.");
        const candidate: StudioCandidate = {
          id,
          filename,
          prompt: input.prompt,
          referenceFiles: input.referenceFiles,
          referenceLabels: input.referenceLabels,
          parentCandidateId: input.parentCandidateId,
          width: dimensions.width,
          height: dimensions.height,
          createdAt: new Date().toISOString(),
        };
        const project = await appendStudioCandidate(input.projectId, input.part, candidate);
        registered = true;
        send({ type: "done", project, candidate });
      } catch (error) {
        if (!abortController.signal.aborted) {
          send({
            type: "error",
            message: error instanceof StudioError || error instanceof ImageGenerationError
              ? error.message : "이미지를 생성하거나 저장하지 못했습니다.",
          });
        }
      } finally {
        if (finalPath && !registered) await fs.unlink(finalPath).catch(() => {});
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abort);
        releaseJobLock(lock.key, lock.token);
        if (!closed) { try { controller.close(); } catch { /* already canceled */ } }
        closed = true;
      }
    },
    cancel() { abort(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET() {
  return Response.json(await codexImageAvailability(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  let input: GenerateRequest;
  try { input = parseGenerateRequest(await parseBody(request)); }
  catch (error) {
    return error instanceof StudioError
      ? errorResponse(error.message, error.status)
      : errorResponse("요청을 읽을 수 없습니다.");
  }
  if (request.signal.aborted) return errorResponse("요청이 취소되었습니다.", 499);
  const lock = acquireDesignLock(input.projectId);
  if (!lock) return designBusyResponse();
  let handedOff = false;
  try {
    const project = await getProject(input.projectId);
    if (!project) return errorResponse("앨범을 찾을 수 없습니다.", 404);
    if (getStudioPart(project, input.part).candidates.length >= MAX_STUDIO_CANDIDATES) {
      return errorResponse(`영역별 후보는 최대 ${MAX_STUDIO_CANDIDATES}개입니다.`, 409);
    }
    let parentFilename: string | undefined;
    if (input.parentCandidateId) {
      parentFilename = getStudioPart(project, input.part).candidates.find((candidate) =>
        candidate.id === input.parentCandidateId)?.filename;
      if (!parentFilename) return errorResponse("수정할 이미지 후보를 찾을 수 없습니다.", 404);
    }
    const explicitReferences = await validateStudioReferenceFiles(input.projectId, input.referenceFiles);
    // Recheck against validated filenames before deriving the attachment-order mapping.
    input.referenceLabels = validateStudioReferenceLabels(explicitReferences, input.referenceLabels);
    if (parentFilename) await validateStudioReferenceFiles(input.projectId, [parentFilename]);
    const available = await codexImageAvailability(request.signal);
    if (!available.connected) return errorResponse(available.message, 503);
    if (request.signal.aborted) return errorResponse("요청이 취소되었습니다.", 499);
    // 부모가 명시적 참고 이미지이기도 하면 한 번만 첨부하고 두 이름을 함께 알려 준다.
    const parentAlreadyAttached = Boolean(parentFilename && explicitReferences.includes(parentFilename));
    const allReferences = parentFilename && !parentAlreadyAttached
      ? [...explicitReferences, parentFilename] : explicitReferences;
    const referenceNames = [
      ...explicitReferences.map((filename) => filename === parentFilename
        ? `${input.referenceLabels[filename]} (변형 원본)` : input.referenceLabels[filename]),
      ...(parentFilename && !parentAlreadyAttached ? ["변형 원본"] : []),
    ];
    const response = streamGeneration(request, input, allReferences, referenceNames, lock);
    handedOff = true;
    return response;
  } catch (error) {
    return error instanceof StudioError ? errorResponse(error.message, error.status)
      : errorResponse("이미지 생성 요청을 준비하지 못했습니다.");
  } finally {
    if (!handedOff) releaseJobLock(lock.key, lock.token);
  }
}
