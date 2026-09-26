import type { NextRequest } from "next/server";
import { generateImagePrompts } from "@/lib/design";
import { rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import { designSseResponse } from "../stream";
import {
  acquireDesignLock,
  badRequest,
  designBusyResponse,
  loadProject,
  persistImagePrompts,
  readBody,
  readProjectId,
} from "../shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/design/prompts
 *  body: { projectId } → SSE (DesignEvent: status / done / error)
 *  AI CLI 1회 호출로 5영역의 ChatGPT 이미지 생성 프롬프트를 만들어
 *  artwork.imagePrompts 에 저장한다. done 이벤트의 artwork 에 결과가 담긴다.
 *  디자인 락을 공유하므로 디자인 생성/수정과 동시에 돌지 않는다.
 */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const body = await readBody(request);
  if (!body) return badRequest("잘못된 요청 본문입니다");

  const projectId = readProjectId(body);
  if (!projectId) return badRequest("projectId 가 필요합니다");

  const lock = acquireDesignLock(projectId);
  if (!lock) return designBusyResponse();

  // 락을 잡은 뒤 최신 상태(컨셉·영역별 지시)를 읽는다
  const project = await loadProject(projectId);
  if (!project) {
    releaseJobLock(lock.key, lock.token);
    return badRequest("앨범을 찾을 수 없습니다", 404);
  }

  return designSseResponse(request, lock, async ({ send, signal }) => {
    send({ type: "status", message: "앨범 정보로 이미지 프롬프트를 준비합니다…" });

    const prompts = await generateImagePrompts(project, {
      signal,
      onStatus: (message) => send({ type: "status", message }),
    });

    const saved = await persistImagePrompts(projectId, prompts);
    send({ type: "status", message: "프롬프트 5개를 저장했습니다." });
    if (!signal.aborted) send({ type: "done", artwork: saved.artwork });
  });
}
