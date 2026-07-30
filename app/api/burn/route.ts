import {
  BURN_LOCK_KEY,
  burn,
  burnStagingDir,
  checkDriveReady,
  cleanupBurnStaging,
  getDriveStatus,
  prepareBurnStaging,
  resolveBurnTracks,
  validateForBurn,
} from "@/lib/burn";
import { acquireJobLock, rejectCrossOrigin, releaseJobLock } from "@/lib/server-guards";
import { getProject, projectDir, tracksDir, updateProjectWith } from "@/lib/storage";
import type { BurnEvent } from "@/lib/types";

export const runtime = "nodejs";

function sse(event: BurnEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  // B3: 외부 페이지가 localhost API로 실물 CD를 굽게 두지 않는다.
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

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

  // 락 획득 전에 ID를 검증한다 — projectDir가 던지면 락이 누수되기 때문.
  let stagingDirectory: string;
  try {
    stagingDirectory = burnStagingDir(projectDir(projectId));
  } catch {
    return Response.json({ error: "잘못된 프로젝트 ID입니다." }, { status: 400 });
  }

  // B2: 드라이브는 1대뿐 — 전역 락. 획득한 토큰으로만 해제한다.
  const lockToken = acquireJobLock(BURN_LOCK_KEY);
  if (!lockToken) {
    return Response.json(
      { error: "이미 다른 굽기 작업이 진행 중입니다. 완료 후 다시 시도해 주세요." },
      { status: 409 },
    );
  }

  // H4: SSE 연결이 끊겨도 굽기 자체와 상태 저장은 계속된다.
  //     닫힌 controller에 enqueue하지 않도록 closed 플래그로 보호한다.
  let closed = false; // enqueue 금지 상태 (연결 종료/취소/닫힘)
  let controllerClosed = false; // controller.close() 호출 여부
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const send = (event: BurnEvent) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(sse(event));
    } catch {
      closed = true;
    }
  };
  const close = () => {
    closed = true;
    if (controllerClosed) return;
    controllerClosed = true;
    try {
      controllerRef?.close();
    } catch {
      // 이미 취소·종료된 스트림
    }
  };

  const runBurn = async () => {
    try {
      const project = await getProject(projectId);
      if (!project) {
        send({ type: "error", message: "프로젝트를 찾을 수 없습니다." });
        return;
      }

      // B3: 클라이언트 모달만 믿지 않고 서버에서 드라이브 상태를 재확인한다.
      send({ type: "validating", message: "드라이브 상태를 확인하고 있습니다." });
      const driveProblem = checkDriveReady(await getDriveStatus());
      if (driveProblem) {
        send({ type: "error", message: driveProblem });
        return;
      }

      // B1: project.tracks(order 순)만 이미지에 담는다 — 삭제·재정렬 반영.
      send({ type: "validating", message: "굽기 목록을 확인하고 있습니다." });
      const staged = await resolveBurnTracks(project, tracksDir(projectId));

      // H2: 원본 WAV 기준으로 규격·총 재생 시간을 검증한다.
      //     수 GB 이미지를 만들기 전에 검증해야 헛수고를 막을 수 있다.
      send({ type: "validating", message: "WAV 규격과 총 재생 시간을 확인하고 있습니다." });
      const failures = await validateForBurn(project, staged);
      if (failures.length > 0) {
        send({ type: "error", message: failures.join("\n") });
        return;
      }

      // W6: 폴더 굽기는 drutil이 파일시스템 순서로 구워 트랙 순서가 뒤바뀐다.
      //     CUE/BIN 이미지를 만들어 순서를 명시적으로 통제한다.
      send({ type: "validating", message: "굽기 이미지를 만들고 있습니다." });
      const staging = await prepareBurnStaging(staged, stagingDirectory, {
        onTrack: (done, total, title) => {
          send({ type: "log", message: `이미지 생성 중 (${done}/${total}) ${title}` });
        },
      });
      if (staging.failures.length > 0) {
        send({ type: "error", message: staging.failures.join("\n") });
        return;
      }

      let succeeded = false;
      await burn(staging, (event) => {
        if (event.type === "done") succeeded = true;
        else send(event);
      });

      if (!succeeded) return;

      // SSE 연결 여부와 무관하게 반드시 상태를 저장한다.
      const updated = await updateProjectWith(projectId, (current) => ({
        ...current,
        status: "burned",
        burnedAt: new Date().toISOString(),
      }));
      if (!updated) {
        send({ type: "error", message: "굽기는 완료됐지만 프로젝트 상태를 저장하지 못했습니다." });
      } else {
        send({ type: "done" });
      }
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "굽기 중 알 수 없는 오류가 발생했습니다.",
      });
    } finally {
      await cleanupBurnStaging(stagingDirectory);
      releaseJobLock(BURN_LOCK_KEY, lockToken);
      close();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // 굽기 작업은 스트림 수명과 분리해 실행한다 (탭을 닫아도 계속 진행).
      void runBurn();
    },
    cancel() {
      // 연결만 끊는다. 진행 중인 drutil은 죽이지 않는다 (죽이면 디스크가 버려짐).
      closed = true;
      controllerClosed = true;
    },
  });

  // 클라이언트 abort 시에도 enqueue만 멈춘다 (굽기·상태 저장은 계속).
  request.signal?.addEventListener("abort", () => {
    closed = true;
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
