import type { NextRequest } from "next/server";
import type { ArtworkState, ArtworkVariant, DesignEvent } from "@/lib/types";
import { getProject, updateProject } from "@/lib/storage";
import {
  acquireDesignLock,
  generateVariants,
  releaseDesignLock,
} from "@/lib/design";

export const dynamic = "force-dynamic";

/** POST /api/design → body: { projectId } → SSE (DesignEvent) — 3안 생성 */
export async function POST(request: NextRequest) {
  let body: { projectId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) {
    return Response.json({ error: "projectId 가 필요합니다" }, { status: 400 });
  }

  const project = await getProject(projectId).catch(() => null);
  if (!project) {
    return Response.json({ error: "앨범을 찾을 수 없습니다" }, { status: 404 });
  }

  if (!acquireDesignLock(projectId)) {
    return Response.json(
      { error: "이미 이 앨범의 디자인을 생성하는 중입니다" },
      { status: 409 },
    );
  }

  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: DesignEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // 오래 걸리는 호출 동안 연결 유지 + 경과 시간 안내
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        if (closed) return;
        const sec = Math.round((Date.now() - startedAt) / 1000);
        try {
          controller.enqueue(encoder.encode(`: keep-alive ${sec}s\n\n`));
        } catch {
          closed = true;
        }
      }, 10000);

      try {
        send({ type: "status", message: "디자인 생성을 준비합니다…" });

        const generated = await generateVariants(project, {
          signal,
          onStatus: (message) => send({ type: "status", message }),
          onVariantError: (index, message) =>
            send({ type: "status", message: `${index}안 생성 실패: ${message}` }),
          onVariant: async (variant) => {
            // 안 하나가 끝날 때마다 project.json 갱신 (중간에 끊겨도 결과 보존)
            await persistVariant(projectId, variant);
            send({ type: "variant-done", variant });
          },
        });

        const fresh = (await getProject(projectId)) ?? project;
        const artwork: ArtworkState = fresh.artwork ?? { variants: [] };

        if (generated.length === 0 && !signal.aborted) {
          send({ type: "error", message: "3안 모두 생성에 실패했습니다" });
        }

        if (!signal.aborted) {
          send({ type: "done", artwork });
        }
      } catch (err) {
        if (!signal.aborted) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        clearInterval(heartbeat);
        releaseDesignLock(projectId);
        close();
      }
    },
    cancel() {
      releaseDesignLock(projectId);
    },
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

/** 생성된 안을 project.artwork.variants 에 병합 저장 */
async function persistVariant(projectId: string, variant: ArtworkVariant): Promise<void> {
  const fresh = await getProject(projectId);
  if (!fresh) return;
  const prev = fresh.artwork ?? { variants: [] };
  const variants = [...prev.variants.filter((v) => v.index !== variant.index), variant].sort(
    (a, b) => a.index - b.index,
  );
  const artwork: ArtworkState = { ...prev, variants };
  await updateProject(projectId, { artwork });
}
