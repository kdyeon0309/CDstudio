import type { NextRequest } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ExtractEvent, ProbeItem, Track } from "@/lib/types";
import {
  getProject,
  saveProject,
  tracksDir as tracksDirOf,
  safeFilename,
} from "@/lib/storage";
import {
  downloadAudio,
  convertToCdWav,
  probeDuration,
  isHttpUrl,
  AbortError,
} from "@/lib/audio";

export const dynamic = "force-dynamic";

/** POST /api/extract → body: { projectId, items } → SSE (ExtractEvent) */
export async function POST(request: NextRequest) {
  let body: { projectId?: unknown; items?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const rawItems = Array.isArray(body.items) ? (body.items as ProbeItem[]) : [];
  if (!projectId) {
    return Response.json({ error: "projectId 가 필요합니다" }, { status: 400 });
  }
  const items = rawItems.filter(
    (it) => it && typeof it.sourceUrl === "string" && isHttpUrl(it.sourceUrl),
  );
  if (items.length === 0) {
    return Response.json({ error: "추출할 항목이 없습니다" }, { status: 400 });
  }

  const signal = request.signal;
  const tracksDir = tracksDirOf(projectId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: ExtractEvent) => {
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

      try {
        const project = await getProject(projectId);
        if (!project) {
          send({ type: "error", message: "프로젝트를 찾을 수 없습니다" });
          close();
          return;
        }

        await fs.mkdir(tracksDir, { recursive: true });

        // 기존 트랙 다음 순번(order/NN)부터 부여
        let nextOrder =
          project.tracks.reduce((max, t) => Math.max(max, t.order), 0) + 1;

        project.status = "extracting";
        await saveProject(project);

        for (const item of items) {
          if (signal.aborted) break;

          const trackId = randomUUID();
          const order = nextOrder;
          const title = item.title?.trim() || "제목 없음";
          send({ type: "track-start", trackId, title });

          const nn = String(order).padStart(2, "0");
          const filename = `${nn} - ${safeFilename(title)}.wav`;
          const outPath = path.join(tracksDir, filename);
          let tmpPath: string | undefined;

          try {
            tmpPath = await downloadAudio(
              item.sourceUrl,
              tracksDir,
              (percent) =>
                send({ type: "progress", trackId, phase: "download", percent }),
              signal,
            );

            await convertToCdWav(
              tmpPath,
              outPath,
              (percent) =>
                send({ type: "progress", trackId, phase: "convert", percent }),
              signal,
            );

            const durationSec = Math.round(await probeDuration(outPath, signal));

            await fs.rm(tmpPath, { force: true });
            tmpPath = undefined;

            const track: Track = {
              id: trackId,
              order,
              title,
              durationSec,
              sourceUrl: item.sourceUrl,
              filename,
              status: "done",
            };
            if (item.artist) track.artist = item.artist;

            // 매 track-done 마다 저장 (신선하게 읽어 병합)
            const fresh = (await getProject(projectId)) ?? project;
            fresh.tracks = [...fresh.tracks, track].sort((a, b) => a.order - b.order);
            fresh.status = "extracting";
            await saveProject(fresh);
            nextOrder += 1;

            send({ type: "track-done", trackId, track });
          } catch (err) {
            if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => {});
            // 실패/중단 시 부분 생성된 출력 파일 정리
            await fs.rm(outPath, { force: true }).catch(() => {});
            if (err instanceof AbortError || signal.aborted) {
              break;
            }
            const message = err instanceof Error ? err.message : String(err);
            send({ type: "track-error", trackId, message });
          }
        }

        // 마무리: 상태를 ready 로 확정
        const finalProject = (await getProject(projectId)) ?? project;
        finalProject.status = finalProject.tracks.length > 0 ? "ready" : "draft";
        await saveProject(finalProject);

        if (!signal.aborted) {
          send({ type: "done", project: finalProject });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", message });
        // 예외 시에도 extracting 상태로 남지 않도록 복구 시도
        try {
          const p = await getProject(projectId);
          if (p && p.status === "extracting") {
            p.status = p.tracks.length > 0 ? "ready" : "draft";
            await saveProject(p);
          }
        } catch {
          /* ignore */
        }
      } finally {
        close();
      }
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
