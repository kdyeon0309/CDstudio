/**
 * CDstudio 공용 타입 계약
 *
 * ★ 이 파일은 모든 Worker가 공유하는 인터페이스 계약이다.
 *   변경은 오케스트레이터 전결 — Worker는 임의로 수정하지 않는다.
 *
 * API 라우트 계약 (요약):
 *  GET    /api/projects            → AlbumProject[]
 *  POST   /api/projects            → body: { title, artist } → AlbumProject
 *  GET    /api/projects/[id]       → AlbumProject
 *  PATCH  /api/projects/[id]       → body: Partial<AlbumProject> (tracks 순서 변경 포함) → AlbumProject
 *  DELETE /api/projects/[id]       → { ok: true }
 *
 *  POST   /api/extract/probe       → body: { url } → ProbeResult  (곡/플레이리스트 메타 조회, 다운로드 안 함)
 *  POST   /api/extract             → body: { projectId, items: ProbeItem[] } → SSE text/event-stream (ExtractEvent)
 *
 *  POST   /api/design              → body: { projectId } → SSE (DesignEvent) — 3안 생성
 *  POST   /api/design/refine       → body: { projectId, variant, feedback } → SSE (DesignEvent)
 *
 *  GET    /api/drive               → DriveStatus
 *  POST   /api/burn                → body: { projectId } → SSE (BurnEvent)
 *
 *  파일 서빙:
 *  GET    /api/projects/[id]/file?type=track&name=...    → 오디오 파일 (미리듣기용)
 *  GET    /api/projects/[id]/file?type=artwork&name=...  → 아트워크 HTML/이미지
 *  POST   /api/projects/[id]/assets                      → multipart 사진 업로드 → { filename }
 */

// ── 앨범 프로젝트 ──────────────────────────────────────────────

export type AlbumStatus =
  | "draft" // 생성 직후, 트랙 없음
  | "extracting" // 추출 진행 중
  | "ready" // 트랙 준비 완료
  | "designed" // 아트워크 선택 완료
  | "burned"; // 굽기 완료

export interface AlbumProject {
  id: string; // uuid (디렉토리명)
  title: string;
  artist: string;
  concept?: string; // 디자인 컨셉 프롬프트
  status: AlbumStatus;
  createdAt: string; // ISO 8601
  updatedAt: string;
  tracks: Track[]; // order 오름차순 유지
  artwork: ArtworkState;
  burnedAt?: string;
}

export interface Track {
  id: string; // uuid
  order: number; // 1-based, 굽기 순서 (파일명 prefix와 일치)
  title: string;
  artist?: string;
  durationSec: number; // ffprobe 기준
  sourceUrl: string;
  filename: string; // tracks/ 내 파일명, 예: "01 - 곡명.wav"
  status: TrackStatus;
  error?: string;
}

export type TrackStatus =
  | "pending"
  | "downloading"
  | "converting"
  | "done"
  | "error";

// ── 추출 ──────────────────────────────────────────────────────

/** yt-dlp 메타 조회 결과 (다운로드 전 미리보기) */
export interface ProbeResult {
  kind: "single" | "playlist";
  playlistTitle?: string;
  items: ProbeItem[];
  /** 플레이리스트 항목 상한(100) 초과로 잘렸으면 true */
  truncated?: boolean;
  /** 잘리기 전 전체 항목 수 */
  totalItems?: number;
}

export interface ProbeItem {
  sourceUrl: string; // 개별 영상/트랙 URL
  title: string;
  artist?: string; // uploader/channel
  durationSec?: number; // flat-playlist에선 근사치일 수 있음
}

/** POST /api/extract SSE 이벤트 (data: JSON 한 줄) */
export type ExtractEvent =
  | { type: "track-start"; trackId: string; title: string }
  | { type: "progress"; trackId: string; phase: "download" | "convert"; percent: number }
  | { type: "track-done"; trackId: string; track: Track }
  | { type: "track-error"; trackId: string; message: string }
  | { type: "done"; project: AlbumProject }
  | { type: "error"; message: string };

// ── 아트워크 ──────────────────────────────────────────────────

export interface ArtworkState {
  /** 생성된 안 (1~3). 파일은 artwork/variant-{n}-{part}.html */
  variants: ArtworkVariant[];
  /** 선택된 안 번호 (1-based). 인쇄는 이 안을 사용 */
  selected?: number;
}

export type ArtworkPart = "front" | "back" | "label";

export interface ArtworkVariant {
  index: number; // 1..3
  name: string; // Claude가 붙인 컨셉명 (예: "미드나잇 네온")
  /** part → artwork/ 내 HTML 파일명 */
  files: Record<ArtworkPart, string>;
}

/** POST /api/design SSE 이벤트 */
export type DesignEvent =
  | { type: "status"; message: string } // "1안 생성 중..." 등
  | { type: "variant-done"; variant: ArtworkVariant }
  | { type: "done"; artwork: ArtworkState }
  | { type: "error"; message: string };

/**
 * 인쇄 실치수 (mm) — 인쇄 페이지와 디자인 생성 프롬프트 공용 상수
 */
export const PRINT_SPECS = {
  front: { widthMm: 120, heightMm: 120 },
  back: { widthMm: 150, heightMm: 118, spineMm: 6.5 }, // 양쪽 스파인 포함 150
  label: { outerDiameterMm: 116, innerDiameterMm: 23 },
} as const;

// ── 드라이브 / 굽기 ────────────────────────────────────────────

export interface DriveStatus {
  connected: boolean; // 광학 드라이브 존재
  vendor?: string;
  product?: string;
  mediaPresent: boolean; // 디스크 삽입됨
  blank: boolean; // 공디스크 여부
  erasable: boolean; // CD-RW 여부
  writableMinutes?: number; // 오디오 기준 여유 분 (drutil status 파싱)
  raw: string; // drutil status 원문 (디버깅용)
}

/** POST /api/burn SSE 이벤트 */
export type BurnEvent =
  | { type: "validating"; message: string } // 사전 검증 (WAV 규격/총시간)
  | { type: "log"; message: string } // drutil 출력 라인
  | { type: "progress"; percent: number } // 파싱 가능할 때만
  | { type: "done" }
  | { type: "error"; message: string };

/** 굽기 사전 검증 상한 (분) — 80분 CD-R 마진 1분 */
export const MAX_AUDIO_MINUTES = 79;

// ── 유틸 공용 ─────────────────────────────────────────────────

/** 총 러닝타임(초) */
export function totalDurationSec(tracks: Track[]): number {
  return tracks.reduce((s, t) => s + (t.durationSec || 0), 0);
}

/** "MM:SS" 표기 */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
