/**
 * 파일시스템 저장소 — ~/CDstudio-library/<앨범ID>/
 *
 * ★ 오케스트레이터 소유 모듈. Worker는 이 API를 사용만 하고 수정하지 않는다.
 *   (버그 발견 시 수정하지 말고 보고)
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import type { AlbumProject } from "./types";

export function libraryRoot(): string {
  return process.env.CDSTUDIO_LIBRARY ?? path.join(os.homedir(), "CDstudio-library");
}

export function projectDir(id: string): string {
  return path.join(libraryRoot(), safeId(id));
}
export function tracksDir(id: string): string {
  return path.join(projectDir(id), "tracks");
}
export function assetsDir(id: string): string {
  return path.join(projectDir(id), "assets");
}
export function artworkDir(id: string): string {
  return path.join(projectDir(id), "artwork");
}

/** 경로 탈출 방지: uuid 형식 외 문자를 제거 */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "");
  if (!cleaned || cleaned !== id) throw new Error(`잘못된 프로젝트 ID: ${id}`);
  return cleaned;
}

/** 파일명 안전화 (트랙/에셋 파일명 생성용) — 경로 문자·제어문자 제거 */
export function safeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "")
    .replace(/\.\./g, "")
    .trim()
    .slice(0, 120) || "untitled";
}

async function projectJsonPath(id: string): Promise<string> {
  return path.join(projectDir(id), "project.json");
}

export async function listProjects(): Promise<AlbumProject[]> {
  const root = libraryRoot();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return []; // 라이브러리 폴더 미생성
  }
  const projects: AlbumProject[] = [];
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(path.join(root, entry, "project.json"), "utf8");
      projects.push(JSON.parse(raw) as AlbumProject);
    } catch {
      // project.json 없는 디렉토리는 무시
    }
  }
  projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return projects;
}

export async function getProject(id: string): Promise<AlbumProject | null> {
  try {
    const raw = await fs.readFile(await projectJsonPath(id), "utf8");
    return JSON.parse(raw) as AlbumProject;
  } catch {
    return null;
  }
}

export async function createProject(input: { title: string; artist: string }): Promise<AlbumProject> {
  const now = new Date().toISOString();
  const project: AlbumProject = {
    id: randomUUID(),
    title: input.title.trim() || "무제 앨범",
    artist: input.artist.trim() || "Unknown Artist",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    tracks: [],
    artwork: { variants: [] },
  };
  await fs.mkdir(tracksDir(project.id), { recursive: true });
  await fs.mkdir(assetsDir(project.id), { recursive: true });
  await fs.mkdir(artworkDir(project.id), { recursive: true });
  await saveProject(project);
  return project;
}

/** 전체 저장 (원자적: tmp → rename) */
export async function saveProject(project: AlbumProject): Promise<void> {
  project.updatedAt = new Date().toISOString();
  const file = await projectJsonPath(project.id);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(project, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/** 부분 갱신 (읽기→병합→저장). 동시성: 1인 로컬 사용 전제로 락 없음 */
export async function updateProject(
  id: string,
  patch: Partial<Omit<AlbumProject, "id" | "createdAt">>,
): Promise<AlbumProject | null> {
  const project = await getProject(id);
  if (!project) return null;
  const merged = { ...project, ...patch, id: project.id, createdAt: project.createdAt };
  await saveProject(merged);
  return merged;
}

export async function deleteProject(id: string): Promise<boolean> {
  const dir = projectDir(id);
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}
