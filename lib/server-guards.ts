/**
 * 서버 요청 가드 + 작업 락 — 오케스트레이터 소유 모듈.
 * Worker는 이 API를 사용만 하고 수정하지 않는다.
 */
import { randomUUID } from "crypto";

/**
 * same-origin 요청인지 검사한다.
 * localhost 전용 앱이라도 외부 웹페이지가 fetch로 localhost:3000의
 * 상태 변경 API(굽기/삭제/추출)를 두드릴 수 있으므로,
 * 브라우저가 붙이는 Origin / Sec-Fetch-Site 헤더로 차단한다.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("host");
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** same-origin이 아니면 403 응답을 돌려준다. 통과 시 null */
export function rejectCrossOrigin(request: Request): Response | null {
  if (isSameOrigin(request)) return null;
  return Response.json(
    { error: "동일 출처 요청만 허용됩니다." },
    { status: 403 },
  );
}

// ── 소유 토큰 기반 인메모리 작업 락 ──────────────────────────
// 예: "burn:drive"(전역 굽기), `extract:${projectId}`, `design:${projectId}`
// 획득한 쪽만(토큰 일치 시) 해제할 수 있어, 취소 경합 시 남의 락을 지우지 못한다.
const jobLocks = new Map<string, string>();

/** 락 획득 시 해제용 토큰 반환, 이미 잠겨 있으면 null */
export function acquireJobLock(key: string): string | null {
  if (jobLocks.has(key)) return null;
  const token = randomUUID();
  jobLocks.set(key, token);
  return token;
}

/** 토큰이 일치할 때만 해제 */
export function releaseJobLock(key: string, token: string): void {
  if (jobLocks.get(key) === token) jobLocks.delete(key);
}

export function isJobLocked(key: string): boolean {
  return jobLocks.has(key);
}
