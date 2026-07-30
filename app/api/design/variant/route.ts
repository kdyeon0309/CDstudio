import type { NextRequest } from "next/server";
import { removeArtworkFile, removeVariantFiles, variantFileName } from "@/lib/design";
import { ARTWORK_PARTS } from "@/lib/types";
import { rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import {
  MAX_VARIANTS,
  acquireDesignLock,
  badRequest,
  designBusyResponse,
  loadProject,
  persistVariantRemoval,
  readBody,
  readProjectId,
  readVariantIndex,
} from "../shared";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/design/variant
 *  body: { projectId, variant } → { artwork }
 *  해당 안의 파일을 전부 지우고 variants 에서 제거한다.
 *  selected 가 그 안이면 선택도 해제된다.
 */
export async function DELETE(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const body = await readBody(request);
  if (!body) return badRequest("잘못된 요청 본문입니다");

  const projectId = readProjectId(body);
  const variantIndex = readVariantIndex(body);

  if (!projectId) return badRequest("projectId 가 필요합니다");
  if (variantIndex < 1 || variantIndex > MAX_VARIANTS) {
    return badRequest(`variant 는 1~${MAX_VARIANTS} 이어야 합니다`);
  }

  const project = await loadProject(projectId);
  if (!project) return badRequest("앨범을 찾을 수 없습니다", 404);

  const existing = project.artwork?.variants?.find((v) => v.index === variantIndex);
  if (!existing) return badRequest("해당 안을 찾을 수 없습니다", 404);

  // 생성 중 삭제를 막는다
  const lock = acquireDesignLock(projectId);
  if (!lock) return designBusyResponse();

  try {
    await removeVariantFiles(projectId, existing);
    // files 에 기록되지 않은 잔여 파일(중단된 생성물)도 함께 정리
    for (const part of ARTWORK_PARTS) {
      await removeArtworkFile(projectId, variantFileName(variantIndex, part));
    }
    const saved = await persistVariantRemoval(projectId, variantIndex);
    return Response.json({ artwork: saved.artwork });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err), 500);
  } finally {
    releaseJobLock(lock.key, lock.token);
  }
}
