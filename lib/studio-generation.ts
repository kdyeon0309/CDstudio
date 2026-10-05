import type {
  AlbumProject,
  StudioArtworkPart,
  StudioCandidate,
} from "@/lib/types";

export type StudioGenerationStatus = "running" | "success" | "error" | "cancelled";

export interface StudioGenerationJob {
  token: string;
  part: StudioArtworkPart;
  prompt: string;
  referenceFiles: string[];
  referenceNames: string[];
  parentCandidateId?: string;
  startedAt: number;
  finishedAt?: number;
  phase: string;
  status: StudioGenerationStatus;
  cancelRequested?: boolean;
  error?: string;
  notice?: string;
}

export type StudioGenerationJobs = Partial<Record<StudioArtworkPart, StudioGenerationJob>>;

export interface StudioGenerationController {
  token: string;
  controller: AbortController;
}

export type StudioGenerationControllers = Map<StudioArtworkPart, StudioGenerationController>;

export function beginStudioGeneration(
  jobs: StudioGenerationJobs,
  job: StudioGenerationJob,
): { jobs: StudioGenerationJobs; started: boolean } {
  if (jobs[job.part]?.status === "running") return { jobs, started: false };
  return { jobs: { ...jobs, [job.part]: job }, started: true };
}

export function updateStudioGeneration(
  jobs: StudioGenerationJobs,
  part: StudioArtworkPart,
  token: string,
  patch: Partial<Omit<StudioGenerationJob, "token" | "part" | "startedAt">>,
): StudioGenerationJobs {
  const current = jobs[part];
  if (!current || current.token !== token) return jobs;
  return { ...jobs, [part]: { ...current, ...patch } };
}

export function hasRunningStudioGeneration(jobs: StudioGenerationJobs): boolean {
  return Object.values(jobs).some((job) => job?.status === "running");
}

export function studioGenerationElapsed(job: StudioGenerationJob, now: number): string {
  const elapsed = Math.max(0, Math.floor(((job.finishedAt ?? now) - job.startedAt) / 1000));
  return `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
}

export function abortAllStudioGenerations(controllers: StudioGenerationControllers): void {
  for (const { controller } of controllers.values()) controller.abort();
}

interface PartMergeOptions {
  includePrintSource?: boolean;
  includeStatus?: boolean;
}

function latestUpdatedAt(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * A part-scoped response may have been serialized before another part finished.
 * Merge only its captured part into the latest client project so reverse-order
 * responses cannot roll back unrelated candidates, selections, or print state.
 */
export function mergeStudioPartProject(
  current: AlbumProject,
  incoming: AlbumProject,
  part: StudioArtworkPart,
  options: PartMergeOptions = {},
): AlbumProject {
  if (!incoming.studio) return current;
  const baseStudio = current.studio ?? incoming.studio;
  const incomingPart = incoming.studio.parts[part];
  return {
    ...current,
    updatedAt: latestUpdatedAt(current.updatedAt, incoming.updatedAt),
    ...(options.includeStatus ? { status: incoming.status } : {}),
    studio: {
      ...baseStudio,
      ...(options.includePrintSource ? { printSource: incoming.studio.printSource } : {}),
      parts: {
        ...baseStudio.parts,
        ...(incomingPart ? { [part]: incomingPart } : {}),
      },
    },
  };
}

/** Preserve locally observed candidates and guarantee the SSE candidate once. */
export function mergeStudioGenerationProject(
  current: AlbumProject,
  incoming: AlbumProject,
  part: StudioArtworkPart,
  candidate: StudioCandidate,
): AlbumProject {
  if (!incoming.studio) return current;
  const baseStudio = current.studio ?? incoming.studio;
  const currentPart = current.studio?.parts[part] ?? incoming.studio.parts[part];
  if (!currentPart) return current;
  const incomingCandidates = incoming.studio.parts[part]?.candidates ?? [];
  const candidates: StudioCandidate[] = [];
  const seen = new Set<string>();
  for (const item of [...currentPart.candidates, ...incomingCandidates, candidate]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    candidates.push(item);
  }
  return {
    ...current,
    updatedAt: latestUpdatedAt(current.updatedAt, incoming.updatedAt),
    studio: {
      ...baseStudio,
      parts: {
        ...baseStudio.parts,
        [part]: { ...currentPart, candidates },
      },
    },
  };
}
