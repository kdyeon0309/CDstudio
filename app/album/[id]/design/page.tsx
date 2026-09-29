import StudioClient from "./studio-client";

/** 영역별 이미지 디자인 스튜디오. */
export default async function DesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StudioClient projectId={id} />;
}
