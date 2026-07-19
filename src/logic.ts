import { extname } from "node:path";
import {
  CUSTOM_TYPE,
  DEFAULT_MAX_BYTES,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_MS,
  MARKER_PATTERN,
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

export interface VideoReferenceCandidate {
  value: string;
  start: number;
  end: number;
}

export function videoReferenceCandidates(input: string): VideoReferenceCandidate[] {
  const candidates: VideoReferenceCandidate[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? "")) index++;
    if (index >= input.length) break;

    const start = index;
    let value = "";
    let quote: "\"" | "'" | undefined;
    while (index < input.length) {
      const char = input[index];
      if (char === undefined) break;
      if (quote) {
        if (char === quote) {
          quote = undefined;
          index++;
          continue;
        }
        if (char === "\\" && input[index + 1] === quote) {
          value += quote;
          index += 2;
          continue;
        }
        value += char;
        index++;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === "\"" || char === "'") {
        quote = char;
        index++;
        continue;
      }
      if (char === "\\" && index + 1 < input.length) {
        const next = input[index + 1] ?? "";
        if (/\s/.test(next) || next === "\\" || next === "\"" || next === "'") {
          value += next;
          index += 2;
          continue;
        }
      }
      value += char;
      index++;
    }

    const pathValue = value.startsWith("@") ? value.slice(1) : value;
    if (isSupportedVideoPath(pathValue)) {
      candidates.push({ value: pathValue, start, end: index });
    }
  }
  return candidates;
}

export function promptWithoutVideoReference(
  input: string,
  candidate: VideoReferenceCandidate,
): string {
  const before = input.slice(0, candidate.start).trimEnd();
  const after = input.slice(candidate.end).trimStart();
  return [before, after].filter(Boolean).join(" ").trim() || DEFAULT_PROMPT;
}

export function isSupportedVideoPath(value: string): boolean {
  return EXTENSION_MIME.has(extname(value).toLowerCase());
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
    if (entry.type === "custom_message" && entry.customType === CUSTOM_TYPE && isVideoAsset(entry.details)) {
      assets.push(entry.details);
      continue;
    }
    if (entry.type === "message" && isRecord(entry.message)
      && entry.message.role === "toolResult" && entry.message.toolName === "read"
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


export function rewriteProviderPayload(
  payload: unknown, assets: readonly VideoAsset[], model: ModelIdentity | undefined,
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  const byMarker = new Map(assets.map((asset) => [asset.marker, asset]));
  let changed = false;
  const messages = payload.messages.map((message: unknown) => {
    if (!isRecord(message) || message.role !== "user") return message;
    if (typeof message.content === "string") {
      const content = transformText(message.content, byMarker, model);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    }
    if (Array.isArray(message.content)) {
      const transformed = transformContentParts(message.content, byMarker, model);
      if (!transformed.changed) return message;
      changed = true;
      return { ...message, content: transformed.content };
    }
    return message;
  });
  return changed ? { ...payload, messages } : payload;
}

type PayloadPart =
  | { type: "text"; text: string }
  | { type: "video"; source: { type: "url"; url: string } };

function transformContentParts(
  parts: readonly unknown[],
  assets: ReadonlyMap<string, VideoAsset>,
  model: ModelIdentity | undefined,
): { content: unknown[]; changed: boolean } {
  let changed = false;
  const content: unknown[] = [];
  for (const part of parts) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      const transformed = transformText(part.text, assets, model);
      if (transformed !== part.text) changed = true;
      if (Array.isArray(transformed)) content.push(...transformed);
      else content.push({ ...part, text: transformed });
      continue;
    }
    if (isRecord(part) && part.type === "tool_result" && Array.isArray(part.content)) {
      const nested = transformContentParts(part.content, assets, model);
      if (nested.changed) {
        changed = true;
        content.push({ ...part, content: nested.content });
      } else {
        content.push(part);
      }
      continue;
    }
    content.push(part);
  }
  return { content, changed };
}

function transformText(
  text: string,
  assets: ReadonlyMap<string, VideoAsset>,
  model: ModelIdentity | undefined,
): string | PayloadPart[] {
  MARKER_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(MARKER_PATTERN)].filter((match) => assets.has(match[0]));
  if (matches.length === 0) return text;

  const canInject = (asset: VideoAsset): boolean => model !== undefined
    && isKimiVideoModel(model)
    && asset.provider === model.provider
    && normalizeBaseUrl(asset.baseUrl) === normalizeBaseUrl(model.baseUrl);
  if (!matches.some((match) => {
    const matchedAsset = assets.get(match[0]);
    return matchedAsset !== undefined && canInject(matchedAsset);
  })) {
    return text.replace(MARKER_PATTERN, (matchedMarker) => {
      const matchedAsset = assets.get(matchedMarker);
      return matchedAsset ? unavailablePlaceholder(matchedAsset, matchedMarker) : matchedMarker;
    });
  }

  const parts: PayloadPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    const index = match.index;
    const matchedAsset = assets.get(match[0]);
    if (index === undefined || !matchedAsset) continue;
    const before = text.slice(cursor, index);
    if (before) parts.push({ type: "text", text: before });
    if (canInject(matchedAsset)) {
      parts.push({ type: "video", source: { type: "url", url: matchedAsset.msUri } });
      cursor = index + match[0].length;
      const whitespace = /^\s*\n\s*/.exec(text.slice(cursor));
      if (whitespace) cursor += whitespace[0].length;
    } else {
      parts.push({ type: "text", text: unavailablePlaceholder(matchedAsset, match[0]) });
      cursor = index + match[0].length;
    }
  }
  const after = text.slice(cursor);
  if (after) parts.push({ type: "text", text: after });
  return parts;
}


function unavailablePlaceholder(asset: VideoAsset, marker: string): string {
  return `[Video attachment unavailable for the current model endpoint: ${asset.fileName}, ${formatBytes(asset.size)}, marker ${marker}]`;
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
