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
import { MAX_AUDIO_MINUTES, discOccupancySec } from "@/lib/types";
import type { AlbumProject, BurnEvent, BurnSettings } from "@/lib/types";

export const runtime = "nodejs";

function sse(event: BurnEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** 클라이언트가 보낸 굽기 설정을 서버에서 재검증한다 (PATCH와 동일 범위). */
function parseBurnSettings(
  raw: unknown,
): { ok: true; settings?: BurnSettings } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "settings는 객체여야 합니다." };
  }

  const { speed, pregapSec } = raw as { speed?: unknown; pregapSec?: unknown };
  const settings: BurnSettings = {};

  if (speed !== undefined && speed !== null) {
    if (typeof speed !== "number" || !Number.isInteger(speed) || speed < 1 || speed > 48) {
      return { ok: false, error: "speed는 1~48 사이의 정수여야 합니다." };
    }
    settings.speed = speed;
  }

  if (pregapSec !== undefined && pregapSec !== null) {
    if (
      typeof pregapSec !== "number" ||
      !Number.isInteger(pregapSec) ||
      pregapSec < 0 ||
      pregapSec > 5 // drutil은 6초 이상을 조용히 기본 2초로 되돌린다
    ) {
      return { ok: false, error: "pregapSec는 0~5 사이의 정수여야 합니다." };
    }
    settings.pregapSec = pregapSec;
  }

  return { ok: true, settings };
}

export async function POST(request: Request) {
  // B3: 외부 페이지가 localhost API로 실물 CD를 굽게 두지 않는다.
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const expectedUpdatedAt = request.headers.get("X-CDstudio-Updated-At")?.trim();
  if (!expectedUpdatedAt) {
    return Response.json({ error: "굽기 전 최신 트랙 목록 확인이 필요합니다. 화면을 새로고침해 주세요." }, { status: 428 });
  }

  let projectId: string;
  let requestedSettings: BurnSettings | undefined;
  try {
    const body = (await request.json()) as { projectId?: unknown; settings?: unknown };
    if (typeof body.projectId !== "string" || !body.projectId) {
      return Response.json({ error: "projectId가 필요합니다." }, { status: 400 });
    }
    projectId = body.projectId;

    const parsed = parseBurnSettings(body.settings);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    requestedSettings = parsed.settings;
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
  // 굽는 동안 같은 앨범의 추출/트랙 편집도 막아, 모달에서 확인한 순서와
  // 실제 CUE/BIN에 쓰는 순서가 달라지지 않게 한다.
  const tracksLockKey = `extract:${projectId}`;
  const tracksLockToken = acquireJobLock(tracksLockKey);
  if (!tracksLockToken) {
    releaseJobLock(BURN_LOCK_KEY, lockToken);
    return Response.json(
      { error: "트랙 추출 또는 편집이 진행 중입니다. 완료 후 목록을 다시 확인해 주세요." },
      { status: 409 },
    );
  }
  let confirmedProject: AlbumProject | null;
  try {
    confirmedProject = await getProject(projectId);
  } catch {
    releaseJobLock(tracksLockKey, tracksLockToken);
    releaseJobLock(BURN_LOCK_KEY, lockToken);
    return Response.json({ error: "앨범 정보를 확인하지 못했습니다." }, { status: 500 });
  }
  if (!confirmedProject || confirmedProject.updatedAt !== expectedUpdatedAt || confirmedProject.status === "extracting") {
    releaseJobLock(tracksLockKey, tracksLockToken);
    releaseJobLock(BURN_LOCK_KEY, lockToken);
    return Response.json(
      { error: confirmedProject
        ? confirmedProject.status === "extracting"
          ? "트랙 추출이 진행 중입니다. 완료 후 목록을 다시 확인해 주세요."
          : "확인한 뒤 앨범 정보가 변경되었습니다. 최신 트랙 목록을 다시 확인해 주세요."
        : "프로젝트를 찾을 수 없습니다." },
      { status: confirmedProject ? 409 : 404 },
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
      const project = confirmedProject;

      // 사전 검증에 실패하면 프로젝트 버전을 바꾸지 않는다. 설정 저장은
      // 물리 굽기 성공 후 상태 변경과 함께 수행한다.
      const settings = requestedSettings ?? project.burnSettings;

      // B3: 클라이언트 모달만 믿지 않고 서버에서 드라이브 상태를 재확인한다.
      send({ type: "validating", message: "드라이브 상태를 확인하고 있습니다." });
      const driveStatus = await getDriveStatus();
      const driveProblem = checkDriveReady(driveStatus);
      if (driveProblem) {
        send({ type: "error", message: driveProblem });
        return;
      }

      // B1: project.tracks(order 순)만 이미지에 담는다 — 삭제·재정렬 반영.
      send({ type: "validating", message: "굽기 목록을 확인하고 있습니다." });
      const staged = await resolveBurnTracks(project, tracksDir(projectId));

      // H2: 원본 WAV 기준으로 규격·총 재생 시간(트랙 간격 포함)을 검증한다.
      //     수 GB 이미지를 만들기 전에 검증해야 헛수고를 막을 수 있다.
      send({ type: "validating", message: "WAV 규격과 총 재생 시간을 확인하고 있습니다." });
      const failures = await validateForBurn(project, staged, settings, driveStatus.writableMinutes);
      if (failures.length > 0) {
        send({ type: "error", message: failures.join("\n") });
        return;
      }

      // W6: 폴더 굽기는 drutil이 파일시스템 순서로 구워 트랙 순서가 뒤바뀐다.
      //     CUE/BIN 이미지를 만들어 순서를 명시적으로 통제한다.
      send({ type: "validating", message: "굽기 이미지를 만들고 있습니다." });
      const staging = await prepareBurnStaging(staged, stagingDirectory, {
        settings,
        onTrack: (done, total, title) => {
          send({ type: "log", message: `이미지 생성 중 (${done}/${total}) ${title}` });
        },
      });
      if (staging.failures.length > 0) {
        send({ type: "error", message: staging.failures.join("\n") });
        return;
      }

      // 실제 BIN 크기는 트랙별 CD 프레임 올림이 반영된다. 사전 ffprobe 추정치와
      // 미세하게 다를 수 있으므로 실물 기록 전에 한 번 더 한도를 확인한다.
      if (staging.mode === "cue") {
        const imageAudioSec = staging.tracks.reduce((sum, track) => sum + track.frames, 0) / 75;
        const imageDiscSec = discOccupancySec(imageAudioSec, staging.tracks.length, staging.pregapSec);
        if (imageDiscSec > MAX_AUDIO_MINUTES * 60) {
          send({ type: "error", message: `실제 굽기 이미지가 ${MAX_AUDIO_MINUTES}분 한도를 초과합니다.` });
          return;
        }
      }

      // 이미지 생성 중 공매체가 교체되었을 수 있으므로 바로 직전 상태로 재검증한다.
      send({ type: "validating", message: "굽기 직전 디스크 용량을 다시 확인하고 있습니다." });
      const finalDriveStatus = await getDriveStatus();
      const finalDriveProblem = checkDriveReady(finalDriveStatus);
      if (finalDriveProblem) {
        send({ type: "error", message: finalDriveProblem });
        return;
      }
      if (staging.mode === "cue") {
        const imageAudioSec = staging.tracks.reduce((sum, track) => sum + track.frames, 0) / 75;
        const imageDiscSec = discOccupancySec(imageAudioSec, staging.tracks.length, staging.pregapSec);
        if (typeof finalDriveStatus.writableMinutes === "number"
          && Number.isFinite(finalDriveStatus.writableMinutes)
          && finalDriveStatus.writableMinutes >= 0
          && imageDiscSec > finalDriveStatus.writableMinutes * 60) {
          send({ type: "error", message: "이미지 생성 중 매체가 교체되었거나 남은 용량이 부족합니다." });
          return;
        }
      }

      let succeeded = false;
      await burn(
        staging,
        (event) => {
          if (event.type === "done") succeeded = true;
          else send(event);
        },
        settings,
      );

      if (!succeeded) return;

      // SSE 연결 여부와 무관하게 반드시 상태를 저장한다.
      try {
        const updated = await updateProjectWith(projectId, (current) => ({
          ...current,
          ...(requestedSettings ? { burnSettings: requestedSettings } : {}),
          status: "burned",
          burnedAt: new Date().toISOString(),
        }));
        if (!updated) {
          send({ type: "log", message: "경고: CD 굽기는 완료됐지만 앨범 상태 저장에 실패했습니다. 다시 굽지 말고 실물 CD를 확인해 주세요." });
        }
      } catch {
        send({ type: "log", message: "경고: CD 굽기는 완료됐지만 앨범 상태 저장에 실패했습니다. 다시 굽지 말고 실물 CD를 확인해 주세요." });
      }
      // 실물 성공은 상태 저장 성공 여부와 별개로 종료 상태다. UI에서
      // 다시 굽기 버튼이 열려 공매체를 중복 소모하지 않도록 한다.
      send({ type: "done" });
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "굽기 중 알 수 없는 오류가 발생했습니다.",
      });
    } finally {
      await cleanupBurnStaging(stagingDirectory);
      releaseJobLock(tracksLockKey, tracksLockToken);
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
