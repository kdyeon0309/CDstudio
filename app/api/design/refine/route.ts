import type { NextRequest } from "next/server";
import type { DesignEvent } from "@/lib/types";
import { getProject, updateProjectWith } from "@/lib/storage";
import { refineVariant } from "@/lib/design";
import {
  acquireJobLock,
  rejectCrossOrigin,
  releaseJobLock,
} from "@/lib/server-guards";

export const dynamic = "force-dynamic";

/** POST /api/design/refine → body: { projectId, variant, feedback } → SSE (DesignEvent) */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  let body: { projectId?: unknown; variant?: unknown; feedback?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const variantIndex =
    typeof body.variant === "number" && Number.isInteger(body.variant) ? body.variant : 0;
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";

  if (!projectId) {
    return Response.json({ error: "projectId 가 필요합니다" }, { status: 400 });
  }
  if (variantIndex < 1 || variantIndex > 3) {
    return Response.json({ error: "variant 는 1~3 이어야 합니다" }, { status: 400 });
  }
  if (!feedback) {
    return Response.json({ error: "수정 요청 내용을 입력해 주세요" }, { status: 400 });
  }
  if (feedback.length > 4000) {
    return Response.json({ error: "수정 요청이 너무 깁니다 (4000자 이내)" }, { status: 400 });
  }

  const project = await getProject(projectId).catch(() => null);
  if (!project) {
    return Response.json({ error: "앨범을 찾을 수 없습니다" }, { status: 404 });
  }

  const lockKey = `design:${projectId}`;
  const lockToken = acquireJobLock(lockKey);
  if (!lockToken) {
    return Response.json(
      { error: "이미 이 앨범의 디자인을 생성하는 중입니다" },
      { status: 409 },
    );
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const signal = abortController.signal;

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
        const variant = await refineVariant(project, variantIndex, feedback, {
          signal,
          onStatus: (message) => send({ type: "status", message }),
        });

        // project.artwork.variants 병합 저장 (같은 index 교체)
        const saved = await updateProjectWith(projectId, (latest) => {
          const prev = latest.artwork ?? { variants: [] };
          const variants = [
            ...prev.variants.filter((v) => v.index !== variant.index),
            variant,
          ].sort((a, b) => a.index - b.index);
          return { ...latest, artwork: { ...prev, variants } };
        });
        if (!saved) throw new Error("디자인 저장 중 앨범이 삭제되었습니다");

        send({ type: "variant-done", variant });
        if (!signal.aborted) {
          send({ type: "done", artwork: saved.artwork });
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
        request.signal.removeEventListener("abort", abort);
        releaseJobLock(lockKey, lockToken);
        close();
      }
    },
    cancel() {
      abortController.abort();
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
