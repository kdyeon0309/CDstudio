import type { NextRequest } from "next/server";
import { backgroundJobs, isLegacyPart, isStudioPart } from "@/lib/background-jobs";
import {
  BACKGROUND_JOB_ENDPOINTS,
  type BackgroundJobEndpoint,
} from "@/lib/background-job-types";
import { rejectCrossOrigin } from "@/lib/server-guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("too-large");
  if (!request.body) throw new Error("invalid-json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("too-large");
    }
    chunks.push(value);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid-json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-json");
  return value as Record<string, unknown>;
}

function isEndpoint(value: unknown): value is BackgroundJobEndpoint {
  return typeof value === "string" &&
    (BACKGROUND_JOB_ENDPOINTS as readonly string[]).includes(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return noStore(rejected);
  let body: Record<string, unknown>;
  try { body = await readBoundedJson(request); }
  catch (error) {
    return json(
      { error: error instanceof Error && error.message === "too-large" ? "요청 본문이 너무 큽니다." : "잘못된 요청 본문입니다." },
      error instanceof Error && error.message === "too-large" ? 413 : 400,
    );
  }
  if (!isEndpoint(body.endpoint)) return json({ error: "지원하지 않는 작업 endpoint입니다." }, 400);
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    return json({ error: "input 객체가 필요합니다." }, 400);
  }
  const input = body.input as Record<string, unknown>;
  if (!validUuid(input.projectId)) return json({ error: "프로젝트 ID가 올바르지 않습니다." }, 400);
  if (body.clientJobId !== undefined && !validUuid(body.clientJobId)) {
    return json({ error: "clientJobId가 올바르지 않습니다." }, 400);
  }
  let part;
  if (body.endpoint === "/api/design/image") {
    if (!isStudioPart(input.part)) return json({ error: "표지 영역이 올바르지 않습니다." }, 400);
    part = input.part;
  } else if (body.endpoint === "/api/design/part") {
    if (!isLegacyPart(input.part)) return json({ error: "표지 영역이 올바르지 않습니다." }, 400);
    part = input.part;
  }
  const result = backgroundJobs.start({
    endpoint: body.endpoint,
    input,
    projectId: input.projectId,
    part,
    clientJobId: body.clientJobId as string | undefined,
  });
  return result.ok ? json({ job: result.job }, 202) : json({ error: result.error }, result.status);
}

export async function GET(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return noStore(rejected);
  const projectId = request.nextUrl.searchParams.get("projectId");
  const id = request.nextUrl.searchParams.get("id");
  if (!validUuid(projectId)) return json({ error: "프로젝트 ID가 올바르지 않습니다." }, 400);
  if (id !== null) {
    if (!validUuid(id)) return json({ error: "작업 ID가 올바르지 않습니다." }, 400);
    const job = backgroundJobs.get(projectId, id);
    return job ? json({ job }) : json({ error: "작업을 찾을 수 없습니다." }, 404);
  }
  return json({ jobs: backgroundJobs.list(projectId) });
}

export async function DELETE(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return noStore(rejected);
  let body: Record<string, unknown>;
  try { body = await readBoundedJson(request); }
  catch (error) {
    return json(
      { error: error instanceof Error && error.message === "too-large" ? "요청 본문이 너무 큽니다." : "잘못된 요청 본문입니다." },
      error instanceof Error && error.message === "too-large" ? 413 : 400,
    );
  }
  if (!validUuid(body.projectId) || !validUuid(body.id)) {
    return json({ error: "프로젝트 ID와 작업 ID가 올바르지 않습니다." }, 400);
  }
  const job = backgroundJobs.cancel(body.projectId, body.id);
  return job ? json({ job }, 202) : json({ error: "작업을 찾을 수 없습니다." }, 404);
}
