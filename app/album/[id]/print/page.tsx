import PrintClient from "./print-client";

export default async function PrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PrintClient projectId={id} />;
}
