import type { NextRequest } from "next/server";
import { probeUrl, isHttpUrl } from "@/lib/audio";

/** POST /api/extract/probe → body: { url } → ProbeResult */
export async function POST(request: NextRequest) {
  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return Response.json({ error: "url 이 필요합니다" }, { status: 400 });
  }
  if (!isHttpUrl(url)) {
    return Response.json({ error: "http/https URL만 허용됩니다" }, { status: 400 });
  }

  try {
    const result = await probeUrl(url, request.signal);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
