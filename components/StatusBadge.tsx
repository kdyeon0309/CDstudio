import type { AlbumStatus } from "@/lib/types";

const STATUS_META: Record<
  AlbumStatus,
  { label: string; dot: string; text: string; ring: string }
> = {
  draft: {
    label: "초안",
    dot: "bg-fg-dim",
    text: "text-fg-muted",
    ring: "ring-line-strong/60",
  },
  extracting: {
    label: "추출 중",
    dot: "bg-amber animate-pulse",
    text: "text-amber-bright",
    ring: "ring-amber/40",
  },
  ready: {
    label: "트랙 준비됨",
    dot: "bg-teal",
    text: "text-teal",
    ring: "ring-teal/40",
  },
  designed: {
    label: "디자인 완료",
    dot: "bg-amber-bright",
    text: "text-amber-bright",
    ring: "ring-amber/40",
  },
  burned: {
    label: "굽기 완료",
    dot: "bg-rose",
    text: "text-rose",
    ring: "ring-rose/40",
  },
};

export default function StatusBadge({ status }: { status: AlbumStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-ink/60 px-2.5 py-1 text-xs font-medium ring-1 ${meta.ring} ${meta.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}
