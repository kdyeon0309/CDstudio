import { redirect } from "next/navigation";

// /album/[id] 접근 시 첫 단계(트랙)로 리다이렉트
export default async function AlbumIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/album/${id}/tracks`);
}
