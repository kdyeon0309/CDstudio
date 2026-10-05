import type { StudioArtworkPart } from "@/lib/types";
import { applyPresetPrompt, DESIGN_PRESETS, type DesignPreset } from "@/lib/design-presets";

export type PendingPresetApplication = {
  part: StudioArtworkPart;
  presetId: string;
};

export type PresetRequestResult =
  | { kind: "blocked" }
  | { kind: "apply"; pending: PendingPresetApplication }
  | { kind: "confirm"; pending: PendingPresetApplication };

export type PresetResolution =
  | { kind: "unchanged" }
  | { kind: "apply"; mode: "replace" | "append" };

export type PresetDraft = {
  prompt: string;
  referenceFiles: string[];
  referenceLabels?: Record<string, string>;
};

export function requestPresetApplication(
  part: StudioArtworkPart,
  presetId: string,
  currentPrompt: string,
  isBusy: boolean,
): PresetRequestResult {
  if (isBusy) return { kind: "blocked" };
  const pending = { part, presetId };
  return currentPrompt.length === 0 ? { kind: "apply", pending } : { kind: "confirm", pending };
}

export function resolvePresetApplication(
  pending: PendingPresetApplication | null,
  activePart: StudioArtworkPart,
  choice: "append" | "replace" | "cancel",
  isBusy: boolean,
): PresetResolution {
  if (isBusy || !pending || pending.part !== activePart || choice === "cancel") {
    return { kind: "unchanged" };
  }
  return { kind: "apply", mode: choice };
}

export function applyPresetToDrafts<T extends PresetDraft>(
  drafts: Partial<Record<StudioArtworkPart, T>>,
  pending: PendingPresetApplication | null,
  activePart: StudioArtworkPart,
  choice: "append" | "replace" | "cancel",
  generatedPrompt: string,
  isBusy: boolean,
): { drafts: Partial<Record<StudioArtworkPart, T>>; applied: boolean } {
  const resolution = resolvePresetApplication(pending, activePart, choice, isBusy);
  if (resolution.kind !== "apply" || !pending) return { drafts, applied: false };
  const current = drafts[pending.part];
  if (!current) return { drafts, applied: false };
  return {
    drafts: {
      ...drafts,
      [pending.part]: {
        ...current,
        prompt: applyPresetPrompt(current.prompt, generatedPrompt, resolution.mode),
      },
    },
    applied: true,
  };
}

function MiniatureLayout({ preset }: { preset: DesignPreset }) {
  const [primary, secondary] = preset.palette;
  const base = {
    background: `linear-gradient(135deg, ${primary}, ${secondary})`,
  };
  const line = "block h-1 rounded-full bg-white/75";
  let content;

  switch (preset.layout) {
    case "photo":
      content = <><span className="absolute inset-2 rounded bg-white/20" /><span className="absolute bottom-3 left-3 h-2 w-9 rounded-full bg-white/80" /></>;
      break;
    case "type":
      content = <><span className="absolute left-3 top-3 text-xl font-black leading-none text-white/90">Aa</span><span className="absolute bottom-3 right-3 h-1 w-7 bg-white/65" /></>;
      break;
    case "collage":
      content = <><span className="absolute left-2 top-2 h-7 w-8 -rotate-6 rounded-sm bg-white/35" /><span className="absolute bottom-2 right-2 h-8 w-9 rotate-6 rounded-sm bg-white/55" /></>;
      break;
    case "text":
      content = <span className="absolute inset-x-3 top-4 space-y-1.5"><span className={`${line} w-full`} /><span className={`${line} w-4/5`} /><span className={`${line} w-2/3`} /></span>;
      break;
    case "texture":
      content = <><span className="absolute inset-0 opacity-35" style={{ backgroundImage: "repeating-linear-gradient(45deg, transparent 0 5px, white 5px 6px)" }} /><span className="absolute inset-3 rounded-full border border-white/65" /></>;
      break;
    case "split":
      content = <><span className="absolute inset-y-0 left-1/2 w-px bg-white/80" /><span className="absolute left-2 top-3 h-2 w-5 rounded bg-white/65" /><span className="absolute bottom-3 right-2 h-2 w-5 rounded bg-white/65" /></>;
      break;
    case "list":
      content = <span className="absolute inset-x-3 top-3 space-y-1.5">{["w-full", "w-5/6", "w-4/5", "w-2/3"].map((width) => <span key={width} className="flex items-center gap-1"><span className="h-1 w-1 rounded-full bg-white/80" /><span className={`${line} ${width}`} /></span>)}</span>;
      break;
    case "strip":
      content = <><span className="absolute inset-y-0 left-3 w-2 bg-white/35" /><span className="absolute bottom-3 left-7 right-2 h-1 rounded bg-white/75" /></>;
      break;
    case "spine":
      content = <><span className="absolute inset-y-1 left-1/2 w-3 -translate-x-1/2 rounded-sm border border-white/70 bg-black/15" /><span className="absolute left-1/2 top-3 h-7 w-px -translate-x-1/2 bg-white/75" /></>;
      break;
    case "disc":
      content = <><span className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/65 bg-white/15" /><span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/40" /></>;
      break;
  }

  return (
    <span className="block">
      <span aria-hidden="true" className="relative block h-16 overflow-hidden rounded-md border border-white/10" style={base}>{content}</span>
      <span className="mt-1 block text-[9px] text-fg-dim">구성 예시</span>
    </span>
  );
}

export default function DesignPresetPicker({
  part,
  disabled,
  pendingPresetId,
  appendPreviewPrompt,
  replacePreviewPrompt,
  onRequest,
  onResolve,
}: {
  part: StudioArtworkPart;
  disabled: boolean;
  pendingPresetId: string | null;
  appendPreviewPrompt: string;
  replacePreviewPrompt: string;
  onRequest: (presetId: string) => void;
  onResolve: (choice: "append" | "replace" | "cancel") => void;
}) {
  const presets = DESIGN_PRESETS[part];
  const pending = pendingPresetId ? presets.find((preset) => preset.id === pendingPresetId) : undefined;

  return (
    <div className="mt-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-fg">추천 프롬프트</h4>
          <p className="mt-0.5 text-[10px] leading-4 text-fg-dim">구성 예시를 고르면 프롬프트만 채웁니다. 이미지 생성은 시작되지 않으며 API 비용도 발생하지 않습니다.</p>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5 xl:grid-cols-2">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={disabled}
            onClick={() => onRequest(preset.id)}
            aria-label={`${preset.title} 추천 프롬프트 사용`}
            className="rounded-lg border border-line bg-ink/50 p-2 text-left transition hover:border-amber/60 focus-visible:border-amber focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MiniatureLayout preset={preset} />
            <span className="mt-1.5 block text-[11px] font-semibold leading-4 text-fg">{preset.title}</span>
            <span className="mt-0.5 block text-[9px] leading-3.5 text-fg-dim">{preset.description}</span>
            <span className="mt-1 flex flex-wrap gap-1">{preset.tags.map((tag) => <span key={tag} className="rounded bg-panel-2 px-1 py-0.5 text-[8px] text-fg-muted">{tag}</span>)}</span>
          </button>
        ))}
      </div>
      {pending && (
        <div role="group" aria-label={`${pending.title} 적용 방식 확인`} className="mt-3 rounded-lg border border-amber/40 bg-amber/5 p-3">
          <p className="text-[11px] font-semibold text-fg">‘{pending.title}’ 스타일을 어떻게 적용할까요?</p>
          <p className="mt-1 text-[10px] leading-4 text-fg-dim">현재 입력한 프롬프트는 자동으로 덮어쓰지 않습니다. 아래 미리보기 확인만으로 이미지 생성은 시작되지 않습니다.</p>
          <details className="mt-2 rounded border border-line bg-ink/60 p-2">
            <summary className="cursor-pointer text-[10px] text-amber">적용할 전체 프롬프트 미리보기</summary>
            <label className="mt-2 block text-[9px] text-fg-dim">기존 내용에 추가할 스타일 지시
              <textarea readOnly value={appendPreviewPrompt} rows={8} aria-label="기존 내용에 추가할 스타일 지시 미리보기" className="mt-1 w-full resize-y rounded border border-line bg-ink p-2 text-[10px] leading-4 text-fg outline-none" />
            </label>
            <label className="mt-2 block text-[9px] text-fg-dim">추천안으로 바꿀 전체 지시
              <textarea readOnly value={replacePreviewPrompt} rows={8} aria-label="추천안으로 바꿀 전체 지시 미리보기" className="mt-1 w-full resize-y rounded border border-line bg-ink p-2 text-[10px] leading-4 text-fg outline-none" />
            </label>
          </details>
          <div className="mt-2 grid gap-2">
            <button type="button" disabled={disabled} onClick={() => onResolve("append")} className="rounded-md border border-amber/50 px-2 py-1.5 text-[10px] text-amber disabled:opacity-40">기존 내용에 스타일 추가</button>
            <button type="button" disabled={disabled} onClick={() => onResolve("replace")} className="rounded-md border border-line px-2 py-1.5 text-[10px] text-fg-muted disabled:opacity-40">추천안으로 바꾸기</button>
            <button type="button" disabled={disabled} onClick={() => onResolve("cancel")} className="px-2 py-1 text-[10px] text-fg-dim disabled:opacity-40">취소</button>
          </div>
        </div>
      )}
    </div>
  );
}
