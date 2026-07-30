/**
 * 디자인 API 공통 SSE 스트림 헬퍼 (라우트 아님 — route.ts 만 라우트가 된다).
 *
 * - 10초 주기 keep-alive 코멘트로 오래 걸리는 CLI 호출 동안 연결을 유지한다.
 * - 탭이 닫히면 controller 가 닫히므로 enqueue 실패를 삼키고 작업을 abort 한다.
 * - 스트림이 끝날 때 반드시 작업 락을 해제한다 (소유 토큰 일치 시에만).
 */
import type { NextRequest } from "next/server";
import type { DesignEvent } from "@/lib/types";
import { releaseJobLock } from "@/lib/server-guards";

export interface DesignStreamCtx {
  send: (event: DesignEvent) => void;
  signal: AbortSignal;
}

export function designSseResponse(
  request: NextRequest,
  lock: { key: string; token: string },
  run: (ctx: DesignStreamCtx) => Promise<void>,
): Response {
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
        await run({ send, signal });
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
        releaseJobLock(lock.key, lock.token);
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
