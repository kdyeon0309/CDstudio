import type { BackgroundJob } from "@/lib/background-job-types";

type BackgroundJobEvent = BackgroundJob["events"][number]["event"];

const JOBS_URL = "/api/jobs";

export function newestUpdatedProject<T extends { updatedAt: string }>(current: T, incoming: T): T {
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
}

async function jobError(response: Response, fallback: string): Promise<Error> {
  const data = await response.json().catch(() => null) as { error?: string } | null;
  const error = new Error(data?.error ?? `${fallback} (${response.status})`) as Error & { status?: number };
  error.status = response.status;
  return error;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function startBackgroundJob(
  endpoint: BackgroundJob["endpoint"],
  input: Record<string, unknown>,
  clientJobId = crypto.randomUUID(),
): Promise<BackgroundJob> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(JOBS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, input, clientJobId }),
      });
      if (!response.ok) throw await jobError(response, "백그라운드 작업을 시작하지 못했습니다");
      return ((await response.json()) as { job: BackgroundJob }).job;
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status !== undefined && status < 500 && status !== 429) throw error;
      if (attempt < 2) await delay(350 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("백그라운드 작업을 시작하지 못했습니다.");
}

/** A late POST response is ignored after its page/project epoch is no longer active. */
export async function startBackgroundJobIfActive(
  endpoint: BackgroundJob["endpoint"],
  input: Record<string, unknown>,
  isActive: () => boolean,
  clientJobId = crypto.randomUUID(),
): Promise<BackgroundJob | null> {
  const job = await startBackgroundJob(endpoint, input, clientJobId);
  return isActive() ? job : null;
}

export async function listBackgroundJobs(projectId: string, signal?: AbortSignal): Promise<BackgroundJob[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${JOBS_URL}?projectId=${encodeURIComponent(projectId)}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw await jobError(response, "작업 목록을 불러오지 못했습니다");
      return ((await response.json()) as { jobs: BackgroundJob[] }).jobs;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status !== undefined && status < 500 && status !== 429) throw error;
      if (attempt < 2) await delay(350 * (attempt + 1), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("작업 목록을 불러오지 못했습니다.");
}

export async function getBackgroundJob(projectId: string, id: string, signal?: AbortSignal): Promise<BackgroundJob> {
  const response = await fetch(`${JOBS_URL}?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await jobError(response, "작업 상태를 불러오지 못했습니다");
  return ((await response.json()) as { job: BackgroundJob }).job;
}

export async function cancelBackgroundJob(projectId: string, id: string): Promise<BackgroundJob> {
  const response = await fetch(JOBS_URL, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, id }),
  });
  if (!response.ok) throw await jobError(response, "작업을 중단하지 못했습니다");
  return ((await response.json()) as { job: BackgroundJob }).job;
}

export interface BackgroundJobObserver {
  stop: () => void;
  finished: Promise<BackgroundJob | null>;
}

/** Stopping this observer never cancels the server-owned job. */
export function watchBackgroundJob(
  initialJob: BackgroundJob,
  callbacks: {
    onEvent: (event: BackgroundJobEvent, seq: number, job: BackgroundJob) => void;
    onUpdate?: (job: BackgroundJob) => void;
    onReconnect?: () => void;
  },
  intervalMs = 1000,
): BackgroundJobObserver {
  const controller = new AbortController();
  let lastSeq = -1;
  const deliver = (job: BackgroundJob) => {
    for (const item of job.events) {
      if (item.seq <= lastSeq) continue;
      lastSeq = item.seq;
      callbacks.onEvent(item.event, item.seq, job);
    }
    callbacks.onUpdate?.(job);
  };
  const finished = (async () => {
    let job = initialJob;
    let failures = 0;
    while (!controller.signal.aborted) {
      deliver(job);
      if (job.status !== "running") return job;
      await delay(intervalMs, controller.signal);
      if (controller.signal.aborted) break;
      try {
        job = await getBackgroundJob(job.projectId, job.id, controller.signal);
        failures = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        if ((error as { status?: number }).status === 404) {
          const unavailable: BackgroundJob = {
            ...job,
            status: "error",
            finishedAt: Date.now(),
            error: "서버가 다시 시작되어 작업 상태를 더 확인할 수 없습니다.",
          };
          callbacks.onUpdate?.(unavailable);
          return unavailable;
        }
        const status = (error as { status?: number }).status;
        if (status !== undefined && status < 500 && status !== 429) {
          const failed: BackgroundJob = {
            ...job,
            status: "error",
            finishedAt: Date.now(),
            error: error instanceof Error ? error.message : "작업 상태 확인 실패",
          };
          return failed;
        }
        failures += 1;
        callbacks.onReconnect?.();
        await delay(Math.min(intervalMs * 2 ** Math.min(failures, 4), 10000), controller.signal);
      }
    }
    return null;
  })();
  return { stop: () => controller.abort(), finished };
}
