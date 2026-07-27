import DesignClient from "./design-client";

/** ④ 디자인 3안 생성 페이지. params 는 Promise 이므로 await 한다. */
export default async function DesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DesignClient projectId={id} />;
}
