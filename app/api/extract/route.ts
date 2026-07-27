import type { NextRequest } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ExtractEvent, ProbeItem, Track } from "@/lib/types";
import {
  getProject,
  updateProjectWith,
  tracksDir as tracksDirOf,
  safeFilename,
} from "@/lib/storage";
import { acquireJobLock, releaseJobLock, rejectCrossOrigin } from "@/lib/server-guards";
import {
  downloadAudio,
  convertToCdWav,
  probeDuration,
  isAllowedSourceUrl,
  assertAllowedSourceUrl,
  MAX_EXTRACT_ITEMS,
  AbortError,
} from "@/lib/audio";

export const dynamic = "force-dynamic";

/** 이미 쓰인 파일명과 겹치지 않는 이름을 만든다 */
function uniqueFilename(base: string, taken: Set<string>): string {
  let name = `${base}.wav`;
  let n = 2;
  while (taken.has(name)) {
    name = `${base} (${n}).wav`;
    n += 1;
  }
  return name;
}

/** POST /api/extract → body: { projectId, items } → SSE (ExtractEvent) */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

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
  // 허용 호스트(YouTube/SoundCloud)만 통과 (M6)
  const items = rawItems.filter(
    (it) => it && typeof it.sourceUrl === "string" && isAllowedSourceUrl(it.sourceUrl),
  );
  if (items.length === 0) {
    return Response.json(
      { error: "추출할 항목이 없습니다 (YouTube/SoundCloud 주소만 허용)" },
      { status: 400 },
    );
  }
  if (items.length > MAX_EXTRACT_ITEMS) {
    return Response.json(
      { error: `한 번에 최대 ${MAX_EXTRACT_ITEMS}곡까지 추출할 수 있습니다` },
      { status: 400 },
    );
  }

  // 락 획득 전에 ID를 검증한다 — tracksDirOf가 던지면 락이 누수되기 때문.
  let tracksDir: string;
  try {
    tracksDir = tracksDirOf(projectId);
  } catch {
    return Response.json({ error: "잘못된 프로젝트 ID입니다" }, { status: 400 });
  }

  // 프로젝트별 추출 락 — 동시 추출 시 order·파일명 충돌 방지 (H1)
  const lockKey = `extract:${projectId}`;
  const lockToken = acquireJobLock(lockKey);
  if (!lockToken) {
    return Response.json(
      { error: "이 앨범은 이미 추출 중입니다. 완료 후 다시 시도하세요." },
      { status: 409 },
    );
  }

  const signal = request.signal;

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
        const existing = await getProject(projectId);
        if (!existing) {
          send({ type: "error", message: "프로젝트를 찾을 수 없습니다" });
          close();
          return;
        }

        await fs.mkdir(tracksDir, { recursive: true });
        await updateProjectWith(projectId, (p) => ({ ...p, status: "extracting" }));

        for (const item of items) {
          if (signal.aborted) break;

          const trackId = randomUUID();
          const title = item.title?.trim() || "제목 없음";
          send({ type: "track-start", trackId, title });

          // 최종 파일명은 저장 직전(락 안)에 결정한다 — 그전까지는 임시 파일 사용
          const stagePath = path.join(tracksDir, `.tmp-conv-${trackId}.wav`);
          let tmpPath: string | undefined;
          let stagedPath: string | undefined = stagePath;

          try {
            assertAllowedSourceUrl(item.sourceUrl);

            tmpPath = await downloadAudio(
              item.sourceUrl,
              tracksDir,
              (percent) =>
                send({ type: "progress", trackId, phase: "download", percent }),
              signal,
            );

            await convertToCdWav(
              tmpPath,
              stagePath,
              (percent) =>
                send({ type: "progress", trackId, phase: "convert", percent }),
              signal,
            );

            const durationSec = Math.round(await probeDuration(stagePath, signal));

            await fs.rm(tmpPath, { force: true });
            tmpPath = undefined;

            // ── order·파일명 배정 + 트랙 추가를 최신 상태에서 원자적으로 수행 (H1)
            const holder: { track: Track | null } = { track: null };
            const updated = await updateProjectWith(projectId, (p) => {
              const order =
                p.tracks.reduce((max, t) => Math.max(max, t.order), 0) + 1;
              const taken = new Set(p.tracks.map((t) => t.filename));
              const filename = uniqueFilename(
                `${String(order).padStart(2, "0")} - ${safeFilename(title)}`,
                taken,
              );
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
              holder.track = track;
              return {
                ...p,
                tracks: [...p.tracks, track].sort((a, b) => a.order - b.order),
                status: "extracting",
              };
            });

            const savedTrack = holder.track;
            if (!updated || !savedTrack) {
              throw new Error("프로젝트를 찾을 수 없습니다");
            }

            // 배정된 이름으로 확정 이동. 실패 시 방금 추가한 트랙을 되돌린다.
            try {
              await fs.rename(stagePath, path.join(tracksDir, savedTrack.filename));
              stagedPath = undefined;
            } catch (renameErr) {
              await updateProjectWith(projectId, (p) => ({
                ...p,
                tracks: p.tracks.filter((t) => t.id !== trackId),
              }));
              throw renameErr;
            }

            send({ type: "track-done", trackId, track: savedTrack });
          } catch (err) {
            if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => {});
            // 실패/중단 시 부분 생성된 임시 출력 파일 정리
            if (stagedPath) await fs.rm(stagedPath, { force: true }).catch(() => {});
            if (err instanceof AbortError || signal.aborted) {
              break;
            }
            const message = err instanceof Error ? err.message : String(err);
            send({ type: "track-error", trackId, message });
          }
        }

        // 마무리: 상태를 ready 로 확정 (최신 상태 기준)
        const finalProject = await updateProjectWith(projectId, (p) => ({
          ...p,
          status: p.tracks.length > 0 ? "ready" : "draft",
        }));

        if (!signal.aborted && finalProject) {
          send({ type: "done", project: finalProject });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", message });
        // 예외 시에도 extracting 상태로 남지 않도록 복구 시도
        try {
          await updateProjectWith(projectId, (p) =>
            p.status === "extracting"
              ? { ...p, status: p.tracks.length > 0 ? "ready" : "draft" }
              : p,
          );
        } catch {
          /* ignore */
        }
      } finally {
        releaseJobLock(lockKey, lockToken);
        close();
      }
    },
    cancel() {
      // 클라이언트가 스트림을 취소해도 start() 의 finally 가 락을 해제한다.
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
