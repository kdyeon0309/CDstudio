/** 영역별 이미지 스튜디오의 저장 규칙과 입력 검증. */
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { assetsDir, updateProjectWith } from "./storage";
import {
  ARTWORK_PARTS,
  STUDIO_ARTWORK_PARTS,
  type AlbumProject,
  type StudioArtworkPart,
  type ArtworkStudio,
  type StudioCandidate,
  type StudioPart,
  type StudioPresentation,
  type StudioSnapshot,
} from "./types";

export const MAX_STUDIO_BODY_BYTES = 1024 * 1024;
export const MAX_STUDIO_REFS = 4;
export const MAX_STUDIO_REFERENCE_LABEL = 40;
export const MAX_STUDIO_CANDIDATES = 100;
export const MAX_STUDIO_SNAPSHOTS = 30;

export class StudioError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function isArtworkPart(value: unknown): value is StudioArtworkPart {
  return typeof value === "string" && (STUDIO_ARTWORK_PARTS as readonly string[]).includes(value);
}

export function defaultStudioPresentation(): StudioPresentation {
  return {
    fit: "cover",
    transform: { offsetXMm: 0, offsetYMm: 0, scale: 1 },
    overlay: { enabled: false, color: "#ffffff", position: "bottom", fontSizeMm: 6 },
  };
}

export function defaultArtworkStudio(project: AlbumProject): ArtworkStudio {
  return {
    version: 1,
    printSource: project.artwork.variants.length > 0 ? "legacy" : "studio",
    parts: {},
    snapshots: [],
  };
}

export function getStudioPart(project: AlbumProject, part: StudioArtworkPart): StudioPart {
  return project.studio?.parts[part] ?? {
    prompt: "",
    referenceFiles: [],
    candidates: [],
    presentation: defaultStudioPresentation(),
  };
}

export function isSafeStudioImageFilename(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && value !== "."
    && value !== ".."
    && !value.includes("..")
    && !/[\\/:*?"<>|\x00-\x1f]/.test(value)
    && path.basename(value) === value
    && /\.(?:jpe?g|png|webp)$/i.test(value);
}

export async function validateStudioReferenceFiles(projectId: string, input: unknown): Promise<string[]> {
  if (!Array.isArray(input) || input.length > MAX_STUDIO_REFS) {
    throw new StudioError(`참고 이미지는 최대 ${MAX_STUDIO_REFS}개까지 선택할 수 있습니다.`);
  }
  const files: string[] = [];
  for (const value of input) {
    if (!isSafeStudioImageFilename(value) || files.includes(value)) {
      throw new StudioError("참고 이미지 파일명이 올바르지 않습니다.");
    }
    let stat;
    try {
      stat = await fs.lstat(path.join(assetsDir(projectId), value));
    } catch {
      throw new StudioError(`참고 이미지를 찾을 수 없습니다: ${value}`, 404);
    }
    if (!stat.isFile()) throw new StudioError("참고 이미지는 일반 파일이어야 합니다.");
    files.push(value);
  }
  return files;
}

/** 선택 순서대로 기본 이름을 붙이고, 저장·생성에 사용할 단일 이름표를 검증한다. */
export function validateStudioReferenceLabels(
  referenceFiles: string[], input: unknown,
): Record<string, string> {
  if (input === undefined) input = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StudioError("참고 이미지 이름 형식이 올바르지 않습니다.");
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set(referenceFiles);
  if (Object.keys(raw).some((filename) => !allowed.has(filename))) {
    throw new StudioError("선택되지 않은 참고 이미지의 이름은 지정할 수 없습니다.");
  }
  const labels: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const [index, filename] of referenceFiles.entries()) {
    const supplied = raw[filename];
    if (supplied !== undefined && typeof supplied !== "string") {
      throw new StudioError("참고 이미지 이름은 문자열이어야 합니다.");
    }
    if (typeof supplied === "string" && !supplied.trim()) {
      throw new StudioError("참고 이미지 이름은 공백일 수 없습니다.");
    }
    if (typeof supplied === "string" && /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(supplied)) {
      throw new StudioError("참고 이미지 이름은 한 줄이어야 합니다.");
    }
    const label = typeof supplied === "string" ? supplied.trim() : `이미지 ${index + 1}`;
    if (label.length > MAX_STUDIO_REFERENCE_LABEL) {
      throw new StudioError(`참고 이미지 이름은 ${MAX_STUDIO_REFERENCE_LABEL}자 이내의 한 줄이어야 합니다.`);
    }
    const unique = label.toLocaleLowerCase();
    const ordinal = /^이미지 ([1-9]\d*)$/.exec(label);
    if (ordinal && Number(ordinal[1]) !== index + 1) {
      throw new StudioError("'이미지 N' 이름의 숫자는 첨부 순서와 같아야 합니다.");
    }
    if (unique === "변형 원본" || seen.has(unique)) {
      throw new StudioError("참고 이미지 이름이 중복되었거나 예약된 이름입니다.");
    }
    seen.add(unique);
    labels[filename] = label;
  }
  return labels;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioError("요청 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

export function validateStudioPrompt(input: unknown): string {
  if (typeof input !== "string") {
    throw new StudioError("프롬프트는 문자열이어야 합니다.");
  }
  return input;
}

export function validateStudioPresentation(input: unknown): StudioPresentation {
  const raw = asRecord(input);
  if (raw.fit !== "cover" && raw.fit !== "contain") {
    throw new StudioError("이미지 배치 방식이 올바르지 않습니다.");
  }
  const t = asRecord(raw.transform);
  const number = (value: unknown, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new StudioError("위치·확대 또는 글자 크기 값이 허용 범위를 벗어났습니다.");
    }
    return value;
  };
  const overlay = asRecord(raw.overlay);
  if (typeof overlay.enabled !== "boolean"
    || typeof overlay.color !== "string"
    || !/^#[0-9a-fA-F]{6}$/.test(overlay.color)
    || (overlay.position !== "top" && overlay.position !== "bottom")) {
    throw new StudioError("글자 설정이 올바르지 않습니다.");
  }
  return {
    fit: raw.fit,
    transform: {
      offsetXMm: number(t.offsetXMm, -60, 60),
      offsetYMm: number(t.offsetYMm, -60, 60),
      scale: number(t.scale, 0.5, 3),
    },
    overlay: {
      enabled: overlay.enabled,
      color: overlay.color,
      position: overlay.position,
      fontSizeMm: number(overlay.fontSizeMm, 2, 20),
    },
  };
}

export function studioAssetReferences(project: AlbumProject, filename: string): boolean {
  for (const part of STUDIO_ARTWORK_PARTS) {
    const entry = project.studio?.parts[part];
    if (!entry) continue;
    if (entry.referenceFiles.includes(filename)) return true;
    if (entry.candidates.some((candidate) =>
      candidate.filename === filename || candidate.referenceFiles.includes(filename))) return true;
  }
  return false;
}

function requireCandidate(entry: StudioPart, candidateId: unknown): StudioCandidate {
  if (typeof candidateId !== "string") throw new StudioError("후보 ID가 필요합니다.");
  const candidate = entry.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new StudioError("해당 후보를 찾을 수 없습니다.", 404);
  return candidate;
}

export type StudioAction =
  | { action: "draft"; part: StudioArtworkPart; prompt: string; referenceFiles: string[]; referenceLabels: Record<string, string> }
  | { action: "select"; part: StudioArtworkPart; candidateId: string }
  | { action: "presentation"; part: StudioArtworkPart; presentation: StudioPresentation }
  | { action: "favorite"; part: StudioArtworkPart; candidateId: string; favorite: boolean }
  | { action: "delete"; part: StudioArtworkPart; candidateId: string }
  | { action: "clear"; part: StudioArtworkPart }
  | { action: "snapshot"; name: string }
  | { action: "delete-snapshot"; snapshotId: string }
  | { action: "restore"; snapshotId: string }
  | { action: "print-source"; printSource: "studio" | "legacy" };

/** 호출자는 design:${projectId} 작업 락을 보유해야 한다. */
export async function applyStudioAction(projectId: string, action: StudioAction): Promise<AlbumProject> {
  const saved = await updateProjectWith(projectId, (project) => {
    const studio = project.studio ?? defaultArtworkStudio(project);
    const parts = { ...studio.parts };
    const next: ArtworkStudio = { ...studio, parts, snapshots: [...studio.snapshots] };

    if ("part" in action) {
      const current = getStudioPart(project, action.part);
      const entry: StudioPart = { ...current, candidates: [...current.candidates] };
      parts[action.part] = entry;
      switch (action.action) {
        case "draft":
          entry.prompt = action.prompt;
          entry.referenceFiles = [...action.referenceFiles];
          entry.referenceLabels = { ...action.referenceLabels };
          break;
        case "select":
          requireCandidate(entry, action.candidateId);
          entry.selectedCandidateId = action.candidateId;
          next.printSource = "studio";
          break;
        case "presentation":
          entry.presentation = action.presentation;
          break;
        case "favorite": {
          requireCandidate(entry, action.candidateId);
          entry.candidates = entry.candidates.map((candidate) => candidate.id === action.candidateId
            ? { ...candidate, favorite: action.favorite }
            : candidate);
          break;
        }
        case "delete": {
          requireCandidate(entry, action.candidateId);
          if (entry.selectedCandidateId === action.candidateId
            || entry.candidates.some((candidate) => candidate.parentCandidateId === action.candidateId)
            || next.snapshots.some((snapshot) => snapshot.parts[action.part]?.candidateId === action.candidateId)) {
            throw new StudioError("사용 중이거나 다른 후보·저장된 세트가 참조하는 후보는 삭제할 수 없습니다.", 409);
          }
          entry.candidates = entry.candidates.filter((candidate) => candidate.id !== action.candidateId);
          break;
        }
        case "clear":
          delete entry.selectedCandidateId;
          next.printSource = "studio";
          break;
      }
    } else if (action.action === "snapshot") {
      if (next.snapshots.length >= MAX_STUDIO_SNAPSHOTS) {
        throw new StudioError(`저장된 세트는 최대 ${MAX_STUDIO_SNAPSHOTS}개입니다.`, 409);
      }
      const selection: StudioSnapshot["parts"] = {};
      for (const part of STUDIO_ARTWORK_PARTS) {
        const entry = parts[part];
        if (!entry?.selectedCandidateId) continue;
        if (!entry.candidates.some((candidate) => candidate.id === entry.selectedCandidateId)) continue;
        selection[part] = {
          candidateId: entry.selectedCandidateId,
          presentation: structuredClone(entry.presentation),
        };
      }
      next.snapshots.push({ id: randomUUID(), name: action.name, createdAt: new Date().toISOString(), parts: selection });
    } else if (action.action === "delete-snapshot") {
      const before = next.snapshots.length;
      next.snapshots = next.snapshots.filter((item) => item.id !== action.snapshotId);
      if (next.snapshots.length === before) throw new StudioError("저장된 세트를 찾을 수 없습니다.", 404);
    } else if (action.action === "restore") {
      const snapshot = next.snapshots.find((item) => item.id === action.snapshotId);
      if (!snapshot) throw new StudioError("저장된 세트를 찾을 수 없습니다.", 404);
      for (const part of STUDIO_ARTWORK_PARTS) {
        const selected = snapshot.parts[part];
        const previous = getStudioPart(project, part);
        const entry: StudioPart = { ...previous, candidates: [...previous.candidates] };
        if (selected) {
          if (!entry.candidates.some((candidate) => candidate.id === selected.candidateId)) {
            throw new StudioError("세트에 필요한 이미지 후보를 찾을 수 없습니다.", 409);
          }
          entry.selectedCandidateId = selected.candidateId;
          entry.presentation = structuredClone(selected.presentation);
        } else {
          delete entry.selectedCandidateId;
        }
        parts[part] = entry;
      }
      next.printSource = "studio";
    } else if (action.action === "print-source") {
      next.printSource = action.printSource;
    }

    const selected = ARTWORK_PARTS.some((part) => next.parts[part]?.selectedCandidateId);
    const status = (action.action === "select" || action.action === "restore")
      && selected && (project.status === "draft" || project.status === "ready")
      ? "designed" : project.status;
    return { ...project, status, studio: next };
  });
  if (!saved) throw new StudioError("앨범을 찾을 수 없습니다.", 404);
  return saved;
}

/** 호출자는 design:${projectId} 작업 락을 보유해야 한다. 후보는 자동 선택하지 않는다. */
export async function appendStudioCandidate(
  projectId: string,
  part: StudioArtworkPart,
  candidate: StudioCandidate,
): Promise<AlbumProject> {
  if (!isArtworkPart(part) || !isSafeStudioImageFilename(candidate.filename)) {
    throw new StudioError("이미지 후보 정보가 올바르지 않습니다.");
  }
  const saved = await updateProjectWith(projectId, (project) => {
    const studio = project.studio ?? defaultArtworkStudio(project);
    const entry = getStudioPart(project, part);
    if (entry.candidates.length >= MAX_STUDIO_CANDIDATES) {
      throw new StudioError(`영역별 후보는 최대 ${MAX_STUDIO_CANDIDATES}개입니다.`, 409);
    }
    if (entry.candidates.some((item) => item.id === candidate.id || item.filename === candidate.filename)) {
      throw new StudioError("이미지 후보 ID 또는 파일명이 중복되었습니다.", 409);
    }
    if (candidate.parentCandidateId && !entry.candidates.some((item) => item.id === candidate.parentCandidateId)) {
      throw new StudioError("원본 후보를 찾을 수 없습니다.", 409);
    }
    return {
      ...project,
      studio: {
        ...studio,
        parts: {
          ...studio.parts,
          [part]: { ...entry, candidates: [...entry.candidates, candidate] },
        },
      },
    };
  });
  if (!saved) throw new StudioError("앨범을 찾을 수 없습니다.", 404);
  return saved;
}

/** 호출자는 design:${projectId} 작업 락을 보유해야 한다. 업로드 등록·선택·배치를 한 번의 저장으로 반영한다. */
export async function importStudioCandidate(
  projectId: string,
  part: StudioArtworkPart,
  candidate: StudioCandidate,
): Promise<AlbumProject> {
  if (!isArtworkPart(part) || !isSafeStudioImageFilename(candidate.filename)) {
    throw new StudioError("이미지 후보 정보가 올바르지 않습니다.");
  }
  const saved = await updateProjectWith(projectId, (project) => {
    const studio = project.studio ?? defaultArtworkStudio(project);
    const entry = getStudioPart(project, part);
    if (entry.candidates.length >= MAX_STUDIO_CANDIDATES) {
      throw new StudioError(`영역별 후보는 최대 ${MAX_STUDIO_CANDIDATES}개입니다.`, 409);
    }
    if (entry.candidates.some((item) => item.id === candidate.id || item.filename === candidate.filename)) {
      throw new StudioError("이미지 후보 ID 또는 파일명이 중복되었습니다.", 409);
    }
    const status = project.status === "draft" || project.status === "ready" ? "designed" : project.status;
    return {
      ...project,
      status,
      studio: {
        ...studio,
        printSource: "studio",
        parts: {
          ...studio.parts,
          [part]: {
            ...entry,
            candidates: [...entry.candidates, candidate],
            selectedCandidateId: candidate.id,
            presentation: defaultStudioPresentation(),
          },
        },
      },
    };
  });
  if (!saved) throw new StudioError("앨범을 찾을 수 없습니다.", 404);
  return saved;
}
