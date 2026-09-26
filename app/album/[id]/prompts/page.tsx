import PromptsClient from "./prompts-client";

/** 디자인 단계 보조 페이지 — ChatGPT 이미지 생성 프롬프트. params 는 Promise 이므로 await 한다. */
export default async function PromptsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PromptsClient projectId={id} />;
}
