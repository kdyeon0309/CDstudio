import { redirect } from "next/navigation";

/** 기존 프롬프트 링크를 통합 디자인 스튜디오로 안내한다. */
export default async function PromptsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/album/${encodeURIComponent(id)}/design`);
}
