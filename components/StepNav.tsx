"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const STEPS = [
  { seg: "tracks", n: "①", label: "트랙" },
  { seg: "design", n: "②", label: "디자인" },
  { seg: "print", n: "③", label: "인쇄" },
  { seg: "burn", n: "④", label: "굽기" },
] as const;

export default function StepNav({ id }: { id: string }) {
  const pathname = usePathname();
  const active = STEPS.find((s) => pathname?.startsWith(`/album/${id}/${s.seg}`))?.seg;

  return (
    <nav className="flex items-center gap-1" aria-label="앨범 제작 단계">
      {STEPS.map((s) => {
        const isActive = s.seg === active;
        return (
          <Link
            key={s.seg}
            href={`/album/${id}/${s.seg}`}
            aria-current={isActive ? "page" : undefined}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              isActive
                ? "bg-amber/15 text-amber-bright ring-1 ring-amber/40"
                : "text-fg-muted hover:bg-panel-2 hover:text-fg"
            }`}
          >
            <span
              className={`font-mono text-xs ${isActive ? "text-amber" : "text-fg-dim"}`}
            >
              {s.n}
            </span>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
