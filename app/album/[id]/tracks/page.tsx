import TracksClient from "./TracksClient";

/** ② 추출·트랙 편집 페이지. params 는 Promise 이므로 await 한다. */
export default async function TracksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TracksClient projectId={id} />;
}
