import { createHash, randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { POST as postStudioImage } from "@/app/api/design/image/route";
import { POST as postExtract } from "@/app/api/extract/route";
import { POST as postDesign } from "@/app/api/design/route";
import { POST as postDesignRefine } from "@/app/api/design/refine/route";
import { POST as postDesignPart } from "@/app/api/design/part/route";
import {
  ARTWORK_PARTS,
  STUDIO_ARTWORK_PARTS,
  type StudioArtworkPart,
} from "./types";
import type {
  BackgroundJob,
  BackgroundJobEndpoint,
  BackgroundJobEvent,
  SequencedBackgroundJobEvent,
} from "./background-job-types";

type RouteHandler = (request: NextRequest) => Promise<Response>;
type RouteHandlers = Record<BackgroundJobEndpoint, RouteHandler>;

const DEFAULT_HANDLERS: RouteHandlers = {
  "/api/design/image": postStudioImage,
  "/api/extract": postExtract,
  "/api/design": postDesign,
  "/api/design/refine": postDesignRefine,
  "/api/design/part": postDesignPart,
};

const TERMINAL_RETENTION_MS = 30 * 60 * 1000;
const MAX_TERMINAL_JOBS = 100;
const MAX_SOFT_EVENTS = 100;
const MAX_ERROR_LENGTH = 2_000;

interface InternalJob extends BackgroundJob {
  controller: AbortController;
  input?: Record<string, unknown>;
  clientJobId?: string;
  requestSignature?: string;
  nextSeq: number;
  order: number;
}

export interface StartBackgroundJobInput {
  endpoint: BackgroundJobEndpoint;
  input: Record<string, unknown>;
  projectId: string;
  part?: StudioArtworkPart;
  clientJobId?: string;
}

export type StartBackgroundJobResult =
  | { ok: true; job: BackgroundJob; reused: boolean }
  | { ok: false; status: 409; error: string };

function cloneEvent(entry: SequencedBackgroundJobEvent): SequencedBackgroundJobEvent {
  return { seq: entry.seq, event: structuredClone(entry.event) };
}

function publicJob(job: InternalJob): BackgroundJob {
  const snapshot: BackgroundJob = {
    id: job.id,
    endpoint: job.endpoint,
    projectId: job.projectId,
    status: job.status,
    startedAt: job.startedAt,
    cancelRequested: job.cancelRequested,
    events: job.events.map(cloneEvent),
  };
  if (job.part) snapshot.part = job.part;
  if (job.finishedAt !== undefined) snapshot.finishedAt = job.finishedAt;
  if (job.error !== undefined) snapshot.error = job.error;
  return snapshot;
}

function jobFamily(endpoint: BackgroundJobEndpoint): "studio" | "legacy" | "extract" {
  if (endpoint === "/api/design/image") return "studio";
  if (endpoint === "/api/extract") return "extract";
  return "legacy";
}

function jobsConflict(a: Pick<InternalJob, "endpoint" | "projectId" | "part">, b: StartBackgroundJobInput): boolean {
  if (a.projectId !== b.projectId) return false;
  const left = jobFamily(a.endpoint);
  const right = jobFamily(b.endpoint);
  if (left === "extract" || right === "extract") return left === right;
  if (left === "legacy" || right === "legacy") return true;
  return a.part === b.part;
}

function eventType(event: BackgroundJobEvent): string {
  return event.type;
}

function isEssential(event: BackgroundJobEvent): boolean {
  return [
    "track-start",
    "track-retry",
    "track-done",
    "track-error",
    "variant-done",
    "done",
    "error",
  ].includes(eventType(event));
}

function responseErrorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
    return value.error.slice(0, MAX_ERROR_LENGTH);
  }
  return fallback;
}

async function readResponseError(response: Response): Promise<string> {
  const fallback = `작업 요청이 거부되었습니다 (${response.status})`;
  try {
    const text = (await response.text()).slice(0, 16_384);
    if (!text) return fallback;
    try { return responseErrorMessage(JSON.parse(text), fallback); }
    catch { return text.slice(0, MAX_ERROR_LENGTH); }
  } catch {
    return fallback;
  }
}

function parseEvent(data: string): BackgroundJobEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      return null;
    }
    return parsed as BackgroundJobEvent;
  } catch {
    return null;
  }
}

function extractSseData(block: string): string | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return data || null;
}

export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, InternalJob>();
  private nextOrder = 1;

  constructor(
    private handlers: RouteHandlers = DEFAULT_HANDLERS,
    private readonly now: () => number = Date.now,
  ) {}

  refreshHandlers(handlers: RouteHandlers): void {
    this.handlers = handlers;
  }

  start(input: StartBackgroundJobInput): StartBackgroundJobResult {
    this.prune();
    const signature = createHash("sha256")
      .update(JSON.stringify([input.endpoint, input.input]))
      .digest("hex");
    if (input.clientJobId) {
      const existing = [...this.jobs.values()].find((job) => job.clientJobId === input.clientJobId);
      if (existing) {
        if (existing.projectId === input.projectId && existing.requestSignature === signature) {
          return { ok: true, job: publicJob(existing), reused: true };
        }
        return { ok: false, status: 409, error: "같은 clientJobId가 다른 작업에 사용되었습니다." };
      }
    }
    const conflict = [...this.jobs.values()].some((job) =>
      job.status === "running" && jobsConflict(job, input));
    if (conflict) {
      return { ok: false, status: 409, error: "같은 앨범에서 충돌하는 작업이 이미 진행 중입니다." };
    }

    const job: InternalJob = {
      id: randomUUID(),
      endpoint: input.endpoint,
      projectId: input.projectId,
      part: input.part,
      status: "running",
      startedAt: this.now(),
      cancelRequested: false,
      events: [],
      controller: new AbortController(),
      input: structuredClone(input.input),
      clientJobId: input.clientJobId,
      requestSignature: signature,
      nextSeq: 1,
      order: this.nextOrder++,
    };
    this.jobs.set(job.id, job);
    void this.run(job);
    return { ok: true, job: publicJob(job), reused: false };
  }

  list(projectId: string): BackgroundJob[] {
    this.prune();
    const latest = new Map<string, InternalJob>();
    for (const job of this.jobs.values()) {
      if (job.projectId !== projectId) continue;
      const key = `${job.endpoint}\0${job.part ?? ""}`;
      const previous = latest.get(key);
      if (!previous ||
          (previous.status !== "running" && job.status === "running") ||
          (previous.status !== "running" && job.status !== "running" &&
            (previous.startedAt < job.startedAt ||
              (previous.startedAt === job.startedAt && previous.order < job.order)))) {
        latest.set(key, job);
      }
    }
    return [...latest.values()]
      .sort((a, b) => a.startedAt - b.startedAt || a.order - b.order)
      .map(publicJob);
  }

  get(projectId: string, id: string): BackgroundJob | null {
    this.prune();
    const job = this.jobs.get(id);
    return job?.projectId === projectId ? publicJob(job) : null;
  }

  cancel(projectId: string, id: string): BackgroundJob | null {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.projectId !== projectId) return null;
    if (job.status === "running") {
      job.cancelRequested = true;
      job.controller.abort();
    }
    return publicJob(job);
  }

  private append(job: InternalJob, event: BackgroundJobEvent): void {
    if (event.type === "status") {
      if (job.events.some(({ event: previous }) =>
        previous.type === "status" && previous.message === event.message)) return;
    }
    if (event.type === "progress") {
      const index = job.events.findIndex(({ event: existing }) =>
        existing.type === "progress" && existing.trackId === event.trackId && existing.phase === event.phase);
      if (index >= 0) job.events.splice(index, 1);
    }
    job.events.push({ seq: job.nextSeq++, event: structuredClone(event) });
    let softCount = job.events.reduce((count, entry) => count + (isEssential(entry.event) ? 0 : 1), 0);
    while (softCount > MAX_SOFT_EVENTS) {
      const index = job.events.findIndex((entry) => !isEssential(entry.event));
      if (index < 0) break;
      job.events.splice(index, 1);
      softCount -= 1;
    }
  }

  private async consume(job: InternalJob, response: Response): Promise<{ done: boolean; error?: string }> {
    if (!response.ok) return { done: false, error: await readResponseError(response) };
    if (!response.body) return { done: false, error: "작업 응답 스트림이 없습니다." };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let terminalError: string | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = extractSseData(block);
          if (!data) continue;
          const event = parseEvent(data);
          if (!event) continue;
          this.append(job, event);
          if (event.type === "done") sawDone = true;
          else if (event.type === "error") terminalError = event.message;
        }
        if (done) break;
      }
      buffer += decoder.decode();
      const data = extractSseData(buffer);
      if (data) {
        const event = parseEvent(data);
        if (event) {
          this.append(job, event);
          if (event.type === "done") sawDone = true;
          else if (event.type === "error") terminalError = event.message;
        }
      }
    } finally {
      // Do not cancel the reader here: EOF is the route's cleanup boundary.
      await reader.closed.catch(() => undefined);
    }
    return { done: sawDone, error: terminalError };
  }

  private async run(job: InternalJob): Promise<void> {
    let sawDone = false;
    let failure: string | undefined;
    try {
      // Capture the implementation for this run. HMR may refresh future handlers while
      // an existing job is still consuming its original route stream.
      const handler = this.handlers[job.endpoint];
      const request = new NextRequest(new URL(job.endpoint, "http://localhost"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          host: "localhost",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(job.input),
        signal: job.controller.signal,
      });
      const response = await handler(request);
      const result = await this.consume(job, response);
      sawDone = result.done;
      failure = result.error;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (sawDone) {
        job.status = "success";
      } else if (job.cancelRequested) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.error = (failure || "작업이 완료 이벤트 없이 종료되었습니다.").slice(0, MAX_ERROR_LENGTH);
      }
      if (job.status === "error" && !job.events.some(({ event }) => event.type === "error")) {
        this.append(job, { type: "error", message: job.error ?? "작업에 실패했습니다." });
      }
      job.finishedAt = this.now();
      job.input = undefined;
      job.controller = new AbortController();
      this.prune();
    }
  }

  private prune(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && (job.finishedAt ?? job.startedAt) < cutoff) this.jobs.delete(id);
    }
    const terminal = [...this.jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    for (let index = 0; index < terminal.length - MAX_TERMINAL_JOBS; index += 1) {
      this.jobs.delete(terminal[index].id);
    }
  }
}

const registryHost = globalThis as typeof globalThis & {
  __cdstudioBackgroundJobRegistry?: BackgroundJobRegistry;
};

export const backgroundJobs = registryHost.__cdstudioBackgroundJobRegistry ??=
  new BackgroundJobRegistry();
backgroundJobs.refreshHandlers(DEFAULT_HANDLERS);

export function isStudioPart(value: unknown): value is StudioArtworkPart {
  return typeof value === "string" &&
    (STUDIO_ARTWORK_PARTS as readonly string[]).includes(value);
}

export function isLegacyPart(value: unknown): value is StudioArtworkPart {
  return typeof value === "string" && (ARTWORK_PARTS as readonly string[]).includes(value);
}
