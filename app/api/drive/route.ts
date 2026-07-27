import { getDriveStatus } from "@/lib/burn";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getDriveStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
