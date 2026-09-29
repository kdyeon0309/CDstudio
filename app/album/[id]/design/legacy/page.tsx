import DesignClient from "../design-client";

/** 기존 3안 HTML 디자인을 열 수 있는 호환 화면. */
export default async function LegacyDesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DesignClient projectId={id} />;
}
