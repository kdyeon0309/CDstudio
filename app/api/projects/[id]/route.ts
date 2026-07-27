import { deleteProject, getProject, updateProjectWith } from "@/lib/storage";
import { rejectCrossOrigin } from "@/lib/server-guards";
import type {
  AlbumProject,
  AlbumStatus,
  ArtworkPart,
  ArtworkState,
  ArtworkVariant,
  Track,
  TrackStatus,
} from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

// ── PATCH 런타임 검증 (H9) ────────────────────────────────────

/** 갱신을 허용하는 필드 */
const PATCHABLE = [
  "title",
  "artist",
  "concept",
  "status",
  "tracks",
  "artwork",
  "burnedAt",
] as const;
type PatchableKey = (typeof PATCHABLE)[number];

const STATUSES: readonly AlbumStatus[] = [
  "draft",
  "extracting",
  "ready",
  "designed",
  "burned",
];
const TRACK_STATUSES: readonly TrackStatus[] = [
  "pending",
  "downloading",
  "converting",
  "done",
  "error",
];
const ARTWORK_PARTS: readonly ArtworkPart[] = ["front", "back", "label"];

const MAX_TRACKS = 200;
const MAX_TEXT = 500;

class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

function asString(value: unknown, field: string, maxLen = MAX_TEXT): string {
  if (typeof value !== "string") fail(`${field} 은(는) 문자열이어야 합니다.`);
  if (value.length > maxLen) fail(`${field} 이(가) 너무 깁니다.`);
  return value;
}

/** 경로 문자·제어문자가 없는 파일명인지 */
function asFilename(value: unknown, field: string): string {
  const s = asString(value, field, 200);
  if (!s.trim()) fail(`${field} 이(가) 비어 있습니다.`);
  if (/[/\\:*?"<>|\x00-\x1f]/.test(s) || s.includes("..")) {
    fail(`${field} 에 사용할 수 없는 문자가 있습니다.`);
  }
  return s;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} 형식이 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}

function validateTrack(value: unknown, idx: number): Track {
  const o = asRecord(value, `tracks[${idx}]`);
  const order = o.order;
  if (typeof order !== "number" || !Number.isInteger(order) || order < 1) {
    fail(`tracks[${idx}].order 는 1 이상의 정수여야 합니다.`);
  }
  const durationSec = o.durationSec;
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 0) {
    fail(`tracks[${idx}].durationSec 는 0 이상의 숫자여야 합니다.`);
  }
  const status = o.status;
  if (typeof status !== "string" || !TRACK_STATUSES.includes(status as TrackStatus)) {
    fail(`tracks[${idx}].status 값이 올바르지 않습니다.`);
  }

  const track: Track = {
    id: asString(o.id, `tracks[${idx}].id`, 100),
    order,
    title: asString(o.title, `tracks[${idx}].title`),
    durationSec,
    sourceUrl: asString(o.sourceUrl, `tracks[${idx}].sourceUrl`, 2000),
    filename: asFilename(o.filename, `tracks[${idx}].filename`),
    status: status as TrackStatus,
  };
  if (o.artist !== undefined) track.artist = asString(o.artist, `tracks[${idx}].artist`);
  if (o.error !== undefined) track.error = asString(o.error, `tracks[${idx}].error`, 2000);
  return track;
}

function validateTracks(value: unknown): Track[] {
  if (!Array.isArray(value)) fail("tracks 는 배열이어야 합니다.");
  if (value.length > MAX_TRACKS) fail(`tracks 는 최대 ${MAX_TRACKS}개까지 허용됩니다.`);
  const tracks = value.map((t, i) => validateTrack(t, i));
  const ids = new Set<string>();
  for (const t of tracks) {
    if (ids.has(t.id)) fail("tracks 에 중복된 id 가 있습니다.");
    ids.add(t.id);
  }
  return tracks;
}

function validateVariant(value: unknown, idx: number): ArtworkVariant {
  const o = asRecord(value, `artwork.variants[${idx}]`);
  const index = o.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
    fail(`artwork.variants[${idx}].index 는 1 이상의 정수여야 합니다.`);
  }
  const files = asRecord(o.files, `artwork.variants[${idx}].files`);
  const parsed = {} as Record<ArtworkPart, string>;
  for (const part of ARTWORK_PARTS) {
    parsed[part] = asFilename(files[part], `artwork.variants[${idx}].files.${part}`);
  }
  return {
    index,
    name: asString(o.name, `artwork.variants[${idx}].name`),
    files: parsed,
  };
}

function validateArtwork(value: unknown): ArtworkState {
  const o = asRecord(value, "artwork");
  if (!Array.isArray(o.variants)) fail("artwork.variants 는 배열이어야 합니다.");
  if (o.variants.length > 10) fail("artwork.variants 가 너무 많습니다.");
  const artwork: ArtworkState = {
    variants: o.variants.map((v, i) => validateVariant(v, i)),
  };
  if (o.selected !== undefined && o.selected !== null) {
    const selected = o.selected;
    if (typeof selected !== "number" || !Number.isInteger(selected) || selected < 1) {
      fail("artwork.selected 는 1 이상의 정수여야 합니다.");
    }
    artwork.selected = selected;
  }
  return artwork;
}

type ValidPatch = Partial<Omit<AlbumProject, "id" | "createdAt">>;

/** allowlist 밖 필드는 무시하고, 허용 필드는 형태를 검증한다 */
function validatePatch(body: Record<string, unknown>): ValidPatch {
  const patch: ValidPatch = {};
  for (const key of PATCHABLE) {
    if (!(key in body)) continue;
    const value = (body as Record<PatchableKey, unknown>)[key];
    switch (key) {
      case "title":
        patch.title = asString(value, "title");
        break;
      case "artist":
        patch.artist = asString(value, "artist");
        break;
      case "concept":
        patch.concept = asString(value, "concept", 4000);
        break;
      case "status":
        if (typeof value !== "string" || !STATUSES.includes(value as AlbumStatus)) {
          fail("status 값이 올바르지 않습니다.");
        }
        patch.status = value as AlbumStatus;
        break;
      case "tracks":
        patch.tracks = validateTracks(value);
        break;
      case "artwork":
        patch.artwork = validateArtwork(value);
        break;
      case "burnedAt":
        if (value === null) break; // 무시
        patch.burnedAt = asString(value, "burnedAt", 40);
        break;
    }
  }
  if (Object.keys(patch).length === 0) {
    fail("변경할 수 있는 필드가 없습니다.");
  }
  return patch;
}

// ── 핸들러 ────────────────────────────────────────────────────

// GET /api/projects/[id] → AlbumProject
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json(project);
}

// PATCH /api/projects/[id]  body: 검증된 Partial<AlbumProject> → AlbumProject
export async function PATCH(request: Request, { params }: Ctx) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }

  let patch: ValidPatch;
  try {
    patch = validatePatch(body as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // 최신 상태를 읽어 병합 (미리 읽어둔 객체를 덮어쓰지 않는다)
  const updated = await updateProjectWith(id, (project) => ({ ...project, ...patch }));
  if (!updated) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json(updated);
}

// DELETE /api/projects/[id] → { ok: true }
export async function DELETE(request: Request, { params }: Ctx) {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const { id } = await params;
  const ok = await deleteProject(id);
  if (!ok) {
    return Response.json({ error: "앨범을 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json({ ok: true });
}
