import type { NextRequest } from "next/server";
import { refineVariant } from "@/lib/design";
import { PART_LABELS } from "@/lib/types";
import { rejectCrossOrigin } from "@/lib/server-guards";
import { designSseResponse } from "../stream";
import {
  MAX_VARIANTS,
  acquireDesignLock,
  badRequest,
  designBusyResponse,
  loadProject,
  persistVariant,
  readBody,
  readProjectId,
  readVariantIndex,
} from "../shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/design/refine
 *  body: { projectId, variant, feedback } → SSE (DesignEvent)
 *  ai 영역만 피드백을 반영해 다시 만들고, photo/template 영역은 서버가 다시 채운다.
 */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const body = await readBody(request);
  if (!body) return badRequest("잘못된 요청 본문입니다");

  const projectId = readProjectId(body);
  const variantIndex = readVariantIndex(body);
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";

  if (!projectId) return badRequest("projectId 가 필요합니다");
  if (variantIndex < 1 || variantIndex > MAX_VARIANTS) {
    return badRequest(`variant 는 1~${MAX_VARIANTS} 이어야 합니다`);
  }
  if (!feedback) return badRequest("수정 요청 내용을 입력해 주세요");
  if (feedback.length > 4000) return badRequest("수정 요청이 너무 깁니다 (4000자 이내)");

  const project = await loadProject(projectId);
  if (!project) return badRequest("앨범을 찾을 수 없습니다", 404);

  const lock = acquireDesignLock(projectId);
  if (!lock) return designBusyResponse();

  return designSseResponse(request, lock, async ({ send, signal }) => {
    const variant = await refineVariant(project, variantIndex, feedback, {
      signal,
      onStatus: (message) => send({ type: "status", message }),
      onPartError: (part, message) =>
        send({ type: "status", message: `${PART_LABELS[part]} 건너뜀: ${message}` }),
    });

    const saved = await persistVariant(projectId, variant);
    send({ type: "variant-done", variant });
    if (!signal.aborted) send({ type: "done", artwork: saved.artwork });
  });
}
