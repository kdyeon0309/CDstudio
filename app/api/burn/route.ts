import { burn, validateForBurn } from "@/lib/burn";
import { getProject, tracksDir, updateProject } from "@/lib/storage";
import type { BurnEvent } from "@/lib/types";

export const runtime = "nodejs";

function sse(event: BurnEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  let projectId: string;
  try {
    const body = (await request.json()) as { projectId?: unknown };
    if (typeof body.projectId !== "string" || !body.projectId) {
      return Response.json({ error: "projectId가 필요합니다." }, { status: 400 });
    }
    projectId = body.projectId;
  } catch {
    return Response.json({ error: "올바른 JSON 요청이 아닙니다." }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: BurnEvent) => controller.enqueue(sse(event));
      try {
        const project = await getProject(projectId);
        if (!project) {
          send({ type: "error", message: "프로젝트를 찾을 수 없습니다." });
          controller.close();
          return;
        }

        send({ type: "validating", message: "WAV 규격과 총 재생 시간을 확인하고 있습니다." });
        const failures = await validateForBurn(project, tracksDir(projectId));
        if (failures.length > 0) {
          send({ type: "error", message: failures.join("\n") });
          controller.close();
          return;
        }

        let succeeded = false;
        await burn(tracksDir(projectId), (event) => {
          if (event.type === "done") succeeded = true;
          else send(event);
        });

        if (succeeded) {
          const updated = await updateProject(projectId, {
            status: "burned",
            burnedAt: new Date().toISOString(),
          });
          if (!updated) {
            send({ type: "error", message: "굽기는 완료됐지만 프로젝트 상태를 저장하지 못했습니다." });
          } else {
            send({ type: "done" });
          }
        }
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "굽기 중 알 수 없는 오류가 발생했습니다.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
