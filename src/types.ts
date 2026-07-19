export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface VideoAsset {
  marker: string;
  version: "v1";
  fileId: string;
  msUri: string;
  provider: "kimi-coding";
  baseUrl: string;
  fileName: string;
  localPath: string;
  hash: string;
  mimeType: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumbnailBase64: string | null;
  prompt: string;
  createdAt: string;
}

export interface ModelIdentity {
  provider: string;
  id: string;
  baseUrl: string;
  api?: string;
}

export interface BranchEntryLike {
  type?: unknown;
  details?: unknown;
  message?: unknown;
}

export const MARKER_PATTERN = /\[\[pi-kimi-video:v1:[0-9a-f-]+\]\]/gi;
