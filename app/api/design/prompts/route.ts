import type { NextRequest } from "next/server";
import { generateImagePrompts } from "@/lib/design";
import type { ArtworkPart, ArtworkState } from "@/lib/types";
import { ARTWORK_PARTS, PART_LABELS } from "@/lib/types";
import { updateProjectWith } from "@/lib/storage";
import { rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import { designSseResponse } from "../stream";
import {
  acquireDesignLock,
  badRequest,
  designBusyResponse,
  isArtworkPart,
  loadProject,
  readBody,
  readProjectId,
} from "../shared";

export const dynamic = "force-dynamic";

const MAX_FEELING_CHARS = 2000;

function readParts(value: unknown): ArtworkPart[] | null {
  if (value === undefined) return [...ARTWORK_PARTS];
  if (!Array.isArray(value)) return null;
  if (value.some((part) => !isArtworkPart(part))) return null;
  if (value.length === 0) return [...ARTWORK_PARTS];
  const requested = new Set<ArtworkPart>(value);
  return ARTWORK_PARTS.filter((part) => requested.has(part));
}

async function mergeImagePrompts(
  projectId: string,
  generated: Partial<Record<ArtworkPart, string>>,
) {
  const saved = await updateProjectWith(projectId, (project) => {
    const previous: ArtworkState = project.artwork ?? { variants: [] };
    return {
      ...project,
      artwork: {
        ...previous,
        imagePrompts: { ...(previous.imagePrompts ?? {}), ...generated },
      },
    };
  });
  if (!saved) throw new Error("프롬프트 저장 중 앨범이 삭제되었습니다");
  return saved;
}

/**
 * POST /api/design/prompts
 *  body: { projectId, parts?, feeling? } → SSE (DesignEvent: status / done / error)
 *  AI CLI 1회 호출로 요청 영역의 ChatGPT 이미지 생성 프롬프트를 만들어
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

  const promptBody = body as typeof body & { parts?: unknown; feeling?: unknown };
  const parts = readParts(promptBody.parts);
  if (!parts) return badRequest("parts 값이 올바르지 않습니다");

  if (promptBody.feeling !== undefined && typeof promptBody.feeling !== "string") {
    return badRequest("feeling 은 문자열이어야 합니다");
  }
  const rawFeeling = typeof promptBody.feeling === "string" ? promptBody.feeling : "";
  if (rawFeeling.length > MAX_FEELING_CHARS) {
    return badRequest(`feeling 은 ${MAX_FEELING_CHARS}자 이하여야 합니다`);
  }
  const feeling = rawFeeling.trim();

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
      parts,
      ...(feeling ? { feeling } : {}),
      signal,
      onStatus: (message) => send({ type: "status", message }),
    });

    const saved = await mergeImagePrompts(projectId, prompts);
    send({
      type: "status",
      message: `${parts.map((part) => PART_LABELS[part]).join(", ")} 프롬프트를 저장했습니다.`,
    });
    if (!signal.aborted) send({ type: "done", artwork: saved.artwork });
  });
}
