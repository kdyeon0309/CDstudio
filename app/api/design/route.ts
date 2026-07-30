import type { NextRequest } from "next/server";
import type { ArtworkState } from "@/lib/types";
import { getProject } from "@/lib/storage";
import { generateVariants, resolvePartModes } from "@/lib/design";
import { ARTWORK_PARTS, PART_LABELS } from "@/lib/types";
import { rejectCrossOrigin } from "@/lib/server-guards";
import { designSseResponse } from "./stream";
import {
  MAX_VARIANTS,
  acquireDesignLock,
  badRequest,
  designBusyResponse,
  loadProject,
  persistVariant,
  readBody,
  readProjectId,
} from "./shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/design
 *  body: { projectId, regenerate?: "all" | "missing" } → SSE (DesignEvent)
 *  - "all"(기본): 1~3안을 모두 만든다 (기존 안 덮어쓰기)
 *  - "missing"  : 이미 있는 안은 그대로 두고 비어 있는 슬롯만 만든다
 *  영역별 제작 방식(artwork.partModes)에 따라 ai / photo / template / blank 로 처리된다.
 */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const body = await readBody(request);
  if (!body) return badRequest("잘못된 요청 본문입니다");

  const projectId = readProjectId(body);
  if (!projectId) return badRequest("projectId 가 필요합니다");

  const regenerate = body.regenerate === "missing" ? "missing" : "all";

  const project = await loadProject(projectId);
  if (!project) return badRequest("앨범을 찾을 수 없습니다", 404);

  const modes = resolvePartModes(project);
  if (ARTWORK_PARTS.every((part) => modes[part] === "blank")) {
    return badRequest("모든 영역이 '비움'입니다 — 최소 한 영역의 제작 방식을 정해 주세요");
  }
  // photo 모드인데 사진이 지정되지 않은 영역은 미리 알려준다 (생성 자체는 진행)
  const photoWithoutFile = ARTWORK_PARTS.filter(
    (part) => modes[part] === "photo" && !project.artwork?.partPhotos?.[part],
  );

  const allIndexes = Array.from({ length: MAX_VARIANTS }, (_, i) => i + 1);
  const filled = new Set(
    (project.artwork?.variants ?? [])
      .filter((v) => Object.keys(v.files ?? {}).length > 0)
      .map((v) => v.index),
  );
  const indexes = regenerate === "missing" ? allIndexes.filter((i) => !filled.has(i)) : allIndexes;

  const lock = acquireDesignLock(projectId);
  if (!lock) return designBusyResponse();

  return designSseResponse(request, lock, async ({ send, signal }) => {
    if (indexes.length === 0) {
      send({ type: "status", message: "비어 있는 안이 없습니다." });
      const fresh = await getProject(projectId);
      send({ type: "done", artwork: fresh?.artwork ?? { variants: [] } });
      return;
    }

    send({
      type: "status",
      message:
        regenerate === "missing"
          ? `비어 있는 ${indexes.join("·")}안을 생성합니다…`
          : "디자인 생성을 준비합니다…",
    });
    for (const part of photoWithoutFile) {
      send({
        type: "status",
        message: `${PART_LABELS[part]}: 사진 모드인데 사용할 사진이 없습니다 — 이 영역은 건너뜁니다.`,
      });
    }

    const generated = await generateVariants(project, {
      signal,
      indexes,
      onStatus: (message) => send({ type: "status", message }),
      onVariantError: (index, message) =>
        send({ type: "status", message: `${index}안 생성 실패: ${message}` }),
      onVariant: async (variant) => {
        // 안 하나가 끝날 때마다 project.json 갱신 (중간에 끊겨도 결과 보존)
        await persistVariant(projectId, variant);
        send({ type: "variant-done", variant });
      },
    });

    if (signal.aborted) return;

    const fresh = await getProject(projectId);
    if (!fresh) throw new Error("디자인 저장 중 앨범이 삭제되었습니다");
    const artwork: ArtworkState = fresh.artwork ?? { variants: [] };

    if (generated.length === 0) {
      send({ type: "error", message: `${indexes.length}개 안 모두 생성에 실패했습니다` });
      return;
    }
    send({ type: "done", artwork });
  });
}
