import type {
  DesignEvent,
  ExtractEvent,
  StudioArtworkPart,
  StudioImageEvent,
} from "./types";

export const BACKGROUND_JOB_ENDPOINTS = [
  "/api/design/image",
  "/api/extract",
  "/api/design",
  "/api/design/refine",
  "/api/design/part",
] as const;

export type BackgroundJobEndpoint = (typeof BACKGROUND_JOB_ENDPOINTS)[number];
export type BackgroundJobStatus = "running" | "success" | "error" | "cancelled";
export type BackgroundJobEvent = StudioImageEvent | ExtractEvent | DesignEvent;

export interface SequencedBackgroundJobEvent {
  seq: number;
  event: BackgroundJobEvent;
}

export interface BackgroundJob {
  id: string;
  endpoint: BackgroundJobEndpoint;
  projectId: string;
  part?: StudioArtworkPart;
  status: BackgroundJobStatus;
  startedAt: number;
  finishedAt?: number;
  cancelRequested: boolean;
  error?: string;
  events: SequencedBackgroundJobEvent[];
}

