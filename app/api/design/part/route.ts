import type { NextRequest } from "next/server";
import { regeneratePart, removeArtworkFile, variantFileName } from "@/lib/design";
import { PART_LABELS } from "@/lib/types";
import { rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import { designSseResponse } from "../stream";
import {
  MAX_VARIANTS,
  acquireDesignLock,
  badRequest,
  designBusyResponse,
  isArtworkPart,
  loadProject,
  persistPartRemoval,
  persistVariant,
  readBody,
  readProjectId,
  readVariantIndex,
} from "../shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/design/part
 *  body: { projectId, variant, part } → SSE (DesignEvent)
 *  해당 안의 해당 영역만 그 영역의 partMode 규칙(ai/photo/template/blank)으로 다시 만든다.
 *  완료 시 variant-done 으로 갱신된 variant 전체를 보낸다.
 */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const body = await readBody(request);
  if (!body) return badRequest("잘못된 요청 본문입니다");

  const projectId = readProjectId(body);
  const variantIndex = readVariantIndex(body);
  const part = body.part;

  if (!projectId) return badRequest("projectId 가 필요합니다");
  if (variantIndex < 1 || variantIndex > MAX_VARIANTS) {
    return badRequest(`variant 는 1~${MAX_VARIANTS} 이어야 합니다`);
  }
  if (!isArtworkPart(part)) return badRequest("part 값이 올바르지 않습니다");

  const project = await loadProject(projectId);
  if (!project) return badRequest("앨범을 찾을 수 없습니다", 404);

  const lock = acquireDesignLock(projectId);
  if (!lock) return designBusyResponse();

  return designSseResponse(request, lock, async ({ send, signal }) => {
    send({ type: "status", message: `${PART_LABELS[part]} 재생성을 준비합니다…` });

    const variant = await regeneratePart(project, variantIndex, part, {
      signal,
      onStatus: (message) => send({ type: "status", message }),
    });

    const saved = await persistVariant(projectId, variant);
    send({ type: "variant-done", variant });
    if (!signal.aborted) send({ type: "done", artwork: saved.artwork });
  });
}

/**
 * DELETE /api/design/part
 *  body: { projectId, variant, part } → { variant }
 *  해당 영역 파일을 지우고 files 에서 키를 제거한다.
 */
export async function DELETE(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const body = await readBody(request);
  if (!body) return badRequest("잘못된 요청 본문입니다");

  const projectId = readProjectId(body);
  const variantIndex = readVariantIndex(body);
  const part = body.part;

  if (!projectId) return badRequest("projectId 가 필요합니다");
  if (variantIndex < 1 || variantIndex > MAX_VARIANTS) {
    return badRequest(`variant 는 1~${MAX_VARIANTS} 이어야 합니다`);
  }
  if (!isArtworkPart(part)) return badRequest("part 값이 올바르지 않습니다");

  const project = await loadProject(projectId);
  if (!project) return badRequest("앨범을 찾을 수 없습니다", 404);

  const existing = project.artwork?.variants?.find((v) => v.index === variantIndex);
  if (!existing) return badRequest("해당 안을 찾을 수 없습니다", 404);

  // 생성 중 삭제를 막는다
  const lock = acquireDesignLock(projectId);
  if (!lock) return designBusyResponse();

  try {
    await removeArtworkFile(projectId, existing.files?.[part] ?? variantFileName(variantIndex, part));
    const { variant } = await persistPartRemoval(projectId, variantIndex, part);
    if (!variant) return badRequest("해당 안을 찾을 수 없습니다", 404);
    return Response.json({ variant });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err), 500);
  } finally {
    releaseJobLock(lock.key, lock.token);
  }
}
