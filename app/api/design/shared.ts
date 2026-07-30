/**
 * 디자인 API 공통 검증·저장 헬퍼 (라우트 아님).
 * 프로젝트 갱신은 반드시 updateProjectWith 로 — 장시간 CLI 호출 중
 * 다른 요청이 바꾼 내용을 되돌리지 않기 위함.
 */
import type { AlbumProject, ArtworkPart, ArtworkState, ArtworkVariant } from "@/lib/types";
import { ARTWORK_PARTS } from "@/lib/types";
import { getProject, updateProjectWith } from "@/lib/storage";
import { acquireJobLock } from "@/lib/server-guards";

export const MAX_VARIANTS = 3;

export interface DesignBody {
  projectId?: unknown;
  variant?: unknown;
  part?: unknown;
  feedback?: unknown;
  regenerate?: unknown;
}

export async function readBody(request: Request): Promise<DesignBody | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as DesignBody;
  } catch {
    return null;
  }
}

export function badRequest(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export function readProjectId(body: DesignBody): string {
  return typeof body.projectId === "string" ? body.projectId : "";
}

export function readVariantIndex(body: DesignBody): number {
  return typeof body.variant === "number" && Number.isInteger(body.variant) ? body.variant : 0;
}

export function isArtworkPart(value: unknown): value is ArtworkPart {
  return typeof value === "string" && (ARTWORK_PARTS as readonly string[]).includes(value);
}

export async function loadProject(projectId: string): Promise<AlbumProject | null> {
  return getProject(projectId).catch(() => null);
}

/** 디자인 작업 락 — 생성/수정/영역 재생성/삭제가 서로 겹치지 않게 한다 */
export function acquireDesignLock(projectId: string): { key: string; token: string } | null {
  const key = `design:${projectId}`;
  const token = acquireJobLock(key);
  return token ? { key, token } : null;
}

export function designBusyResponse(): Response {
  return Response.json(
    { error: "이미 이 앨범의 디자인 작업이 진행 중입니다" },
    { status: 409 },
  );
}

function normalizeArtwork(artwork: ArtworkState | undefined): ArtworkState {
  return artwork ?? { variants: [] };
}

/** 안 하나를 artwork.variants 에 병합 저장 (같은 index 교체) */
export async function persistVariant(
  projectId: string,
  variant: ArtworkVariant,
): Promise<AlbumProject> {
  const saved = await updateProjectWith(projectId, (project) => {
    const prev = normalizeArtwork(project.artwork);
    const variants = [...prev.variants.filter((v) => v.index !== variant.index), variant].sort(
      (a, b) => a.index - b.index,
    );
    return { ...project, artwork: { ...prev, variants } };
  });
  if (!saved) throw new Error("디자인 저장 중 앨범이 삭제되었습니다");
  return saved;
}

/** 안 하나를 통째로 제거 (selected 가 그 안이면 해제) */
export async function persistVariantRemoval(
  projectId: string,
  index: number,
): Promise<AlbumProject> {
  const saved = await updateProjectWith(projectId, (project) => {
    const prev = normalizeArtwork(project.artwork);
    const variants = prev.variants.filter((v) => v.index !== index);
    const next: ArtworkState = { ...prev, variants };
    if (next.selected === index) delete next.selected;
    return { ...project, artwork: next };
  });
  if (!saved) throw new Error("디자인 저장 중 앨범이 삭제되었습니다");
  return saved;
}

/** 한 영역만 files 에서 제거. 남은 영역이 없으면 selected 도 해제한다. */
export async function persistPartRemoval(
  projectId: string,
  index: number,
  part: ArtworkPart,
): Promise<{ project: AlbumProject; variant: ArtworkVariant | null }> {
  let updated: ArtworkVariant | null = null;
  const saved = await updateProjectWith(projectId, (project) => {
    const prev = normalizeArtwork(project.artwork);
    const variants = prev.variants.map((v) => {
      if (v.index !== index) return v;
      const files = { ...(v.files ?? {}) };
      delete files[part];
      updated = { ...v, files };
      return updated;
    });
    const next: ArtworkState = { ...prev, variants };
    const remaining = updated ? Object.keys(updated.files ?? {}).length : 0;
    if (updated && remaining === 0 && next.selected === index) delete next.selected;
    return { ...project, artwork: next };
  });
  if (!saved) throw new Error("디자인 저장 중 앨범이 삭제되었습니다");
  return { project: saved, variant: updated };
}
