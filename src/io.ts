import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { promptWithoutVideoReference, videoReferenceCandidates } from "./logic.ts";

const execFileAsync = promisify(execFile);

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  thumbnailBase64?: string;
}

export interface VideoAttachment {
  localPath: string;
  prompt: string;
}

export async function findVideoAttachment(
  input: string,
  cwd: string,
): Promise<VideoAttachment | undefined> {
  const matches: Array<{ localPath: string; candidate: ReturnType<typeof videoReferenceCandidates>[number] }> = [];
  for (const candidate of videoReferenceCandidates(input)) {
    let localPath: string;
    try {
      localPath = resolveLocalVideoPath(candidate.value, cwd);
      const fileStat = await stat(localPath);
      if (!fileStat.isFile()) continue;
    } catch {
      continue;
    }
    matches.push({ localPath, candidate });
  }

  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error("Attach one video per message.");
  }
  const match = matches[0];
  if (!match) return undefined;
  return {
    localPath: match.localPath,
    prompt: promptWithoutVideoReference(input, match.candidate),
  };
}

function resolveLocalVideoPath(value: string, cwd: string): string {
  if (value.startsWith("file://")) return fileURLToPath(new URL(value));
  const expanded = value === "~"
    ? homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? `${homedir()}${value.slice(1)}`
      : value;
  return resolve(cwd, expanded);
}

export async function sha256File(path: string, signal: AbortSignal | undefined): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, signal ? { signal } : undefined);
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  signal?.throwIfAborted();
  return hash.digest("hex");
}

export async function uploadVideo(
  path: string,
  mimeType: string,
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
): Promise<{ fileId: string; msUri: string }> {
  const blob = await openAsBlob(path, { type: mimeType });
  const form = new FormData();
  form.set("purpose", "video");
  form.set("file", blob, basename(path));
  const requestHeaders = new Headers(headers);
  requestHeaders.delete("content-type");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/files`, {
    method: "POST",
    headers: requestHeaders,
    body: form,
    ...(signal ? { signal } : {}),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(formatMoonshotError(response.status, body));
  if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("Moonshot upload succeeded but returned no file id.");
  }
  return { fileId: body.id, msUri: `ms://${body.id}` };
}

export async function inspectVideo(path: string, signal: AbortSignal | undefined): Promise<MediaMetadata> {
  const metadata = await optionalUnlessAborted(probe(path, signal), signal, {});
  const thumbnailBase64 = await optionalUnlessAborted(thumbnail(path, signal), signal, undefined);
  return thumbnailBase64 ? { ...metadata, thumbnailBase64 } : metadata;
}

async function probe(path: string, signal: AbortSignal | undefined): Promise<MediaMetadata> {
  const options = {
    encoding: "utf8" as const,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    ...(signal ? { signal } : {}),
  };
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration", "-of", "json", path,
  ], options);
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed)) return {};
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const stream = streams.find(isRecord);
  const format = isRecord(parsed.format) ? parsed.format : undefined;
  const duration = format ? numeric(format.duration) : undefined;
  const width = stream ? numeric(stream.width) : undefined;
  const height = stream ? numeric(stream.height) : undefined;
  return {
    ...(duration !== undefined ? { duration } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

async function thumbnail(path: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  const options = {
    encoding: "buffer" as const,
    timeout: 5_000,
    maxBuffer: 512 * 1024,
    ...(signal ? { signal } : {}),
  };
  const { stdout } = await execFileAsync("ffmpeg", [
    "-v", "error", "-i", path, "-frames:v", "1",
    "-vf", "scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ], options);
  return stdout.length > 0 ? stdout.toString("base64") : undefined;
}

async function optionalUnlessAborted<T>(
  promise: Promise<T>, signal: AbortSignal | undefined, fallback: T,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (signal?.aborted || isAbortLike(error)) throw error;
    return fallback;
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function formatMoonshotError(status: number, body: unknown): string {
  let detail: string | undefined;
  if (isRecord(body)) {
    if (typeof body.message === "string") detail = body.message;
    else if (isRecord(body.error) && typeof body.error.message === "string") detail = body.error.message;
    else if (typeof body.error === "string") detail = body.error;
  }
  return `Moonshot video upload failed (HTTP ${status})${detail ? `: ${detail}` : "."}`;
}

function numeric(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
