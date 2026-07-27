import type { NextRequest } from "next/server";
import { probeUrl, isAllowedSourceUrl, ALLOWED_SOURCE_HOSTS } from "@/lib/audio";
import { rejectCrossOrigin } from "@/lib/server-guards";

/** POST /api/extract/probe → body: { url } → ProbeResult */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

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
  // 허용 호스트(YouTube/SoundCloud)만 yt-dlp 로 넘긴다 (M6)
  if (!isAllowedSourceUrl(url)) {
    return Response.json(
      {
        error: `YouTube 또는 SoundCloud 주소만 사용할 수 있습니다 (허용 호스트: ${ALLOWED_SOURCE_HOSTS.join(", ")})`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await probeUrl(url, request.signal);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
