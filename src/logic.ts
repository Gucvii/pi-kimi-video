import { extname } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type BranchEntryLike,
  type ModelIdentity,
  type VideoAsset,
} from "./types.ts";

const EXTENSION_MIME = new Map<string, string>([
  [".mp4", "video/mp4"], [".mpeg", "video/mpeg"], [".mpg", "video/mpeg"],
  [".mov", "video/quicktime"], [".avi", "video/x-msvideo"], [".flv", "video/x-flv"],
  [".webm", "video/webm"], [".wmv", "video/x-ms-wmv"], [".3gp", "video/3gpp"],
  [".3gpp", "video/3gpp"],
]);

const KIMI_CODING_VIDEO_MODELS = new Set(["k3", "kimi-for-coding", "kimi-for-coding-highspeed"]);

export function isKimiVideoModel(model: ModelIdentity | undefined): boolean {
  return model?.provider === "kimi-coding"
    && KIMI_CODING_VIDEO_MODELS.has(model.id)
    && (model.api === undefined || model.api === "anthropic-messages");
}

export function videoFilesBaseUrl(model: ModelIdentity): string {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

export function parseMaxBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("PI_KIMI_VIDEO_MAX_BYTES must be a positive integer number of bytes.");
  }
  return parsed;
}

export function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("PI_KIMI_VIDEO_TIMEOUT_MS must be a positive integer number of milliseconds.");
  }
  return parsed;
}

export function validateVideoFile(fileName: string, size: number, maxBytes: number): string {
  const extension = extname(fileName).toLowerCase();
  const mime = EXTENSION_MIME.get(extension);
  if (!mime) {
    throw new Error(`Unsupported video format "${extension || "(none)"}". Supported: mp4, mpeg, mpg, mov, avi, flv, webm, wmv, 3gp, 3gpp.`);
  }
  if (size <= 0) throw new Error("Video file is empty.");
  if (size > maxBytes) {
    throw new Error(`Video is ${formatBytes(size)}, exceeding the ${formatBytes(maxBytes)} limit (PI_KIMI_VIDEO_MAX_BYTES).`);
  }
  return mime;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0] ?? "B";
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i] ?? unit;
  }
  return `${value < 10 && unit !== "B" ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

export function isVideoAsset(value: unknown): value is VideoAsset {
  if (!isRecord(value)) return false;
  return value.version === "v1"
    && typeof value.marker === "string"
    && typeof value.fileId === "string"
    && typeof value.msUri === "string"
    && value.msUri.startsWith("ms://")
    && value.provider === "kimi-coding"
    && typeof value.baseUrl === "string"
    && typeof value.fileName === "string"
    && typeof value.localPath === "string"
    && typeof value.hash === "string"
    && typeof value.mimeType === "string"
    && typeof value.size === "number"
    && (value.duration === null || typeof value.duration === "number")
    && (value.width === null || typeof value.width === "number")
    && (value.height === null || typeof value.height === "number")
    && (value.thumbnailBase64 === null || typeof value.thumbnailBase64 === "string")
    && typeof value.prompt === "string"
    && typeof value.createdAt === "string";
}

export function assetsFromBranch(entries: readonly BranchEntryLike[]): VideoAsset[] {
  const assets: VideoAsset[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && isRecord(entry.message)
      && entry.message.role === "toolResult" && entry.message.toolName === "read_video"
      && isVideoAsset(entry.message.details)) {
      assets.push(entry.message.details);
    }
  }
  return assets;
}

export function findReusableAsset(
  assets: readonly VideoAsset[], provider: string, baseUrl: string, hash: string,
): VideoAsset | undefined {
  return [...assets].reverse().find((asset) =>
    asset.provider === provider && normalizeBaseUrl(asset.baseUrl) === normalizeBaseUrl(baseUrl) && asset.hash === hash,
  );
}



export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\|$)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]?/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
}

export function singleLineTerminalText(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
