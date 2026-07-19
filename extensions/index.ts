import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { inspectVideo, sha256File, uploadVideo } from "../src/io.ts";
import {
  assetsFromBranch,
  findReusableAsset,
  formatBytes,
  isKimiVideoModel,
  parseMaxBytes,
  parseTimeoutMs,
  rewriteProviderPayload,
  sanitizeTerminalText,
  validateVideoFile,
  videoFilesBaseUrl,
} from "../src/logic.ts";
import type { VideoAsset } from "../src/types.ts";

const runtimeAssets = new Map<string, VideoAsset>();

export default function kimiVideoExtension(pi: ExtensionAPI): void {

  pi.registerTool({
    name: "read_video",
    label: "read_video",
    description: "Read a local video file and return it as native Kimi video content. Use this instead of bash, ffprobe, ffmpeg, or frame extraction when the user asks what a video contains.",
    promptSnippet: "Read a local video as native multimodal content",
    promptGuidelines: [
      "When the user asks about a local video path, call read_video instead of inferring anything from the file name. After the tool returns, analyze the native video content; if the model cannot access it, say so explicitly.",
    ],
    parameters: createReadToolDefinition(process.cwd()).parameters,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("read_video"))} ${sanitizeTerminalText(args.path)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const asset = result.details as VideoAsset | undefined;
      if (!asset) return new Text(theme.fg("error", "Video read failed"), 0, 0);
      const dimensions = asset.width !== null && asset.height !== null
        ? `${asset.width}×${asset.height}`
        : "unknown";
      const duration = asset.duration !== null ? formatDuration(asset.duration) : "unknown";
      const summary = `${theme.fg("accent", "Video")} ${theme.bold(sanitizeTerminalText(asset.fileName))} · ${formatBytes(asset.size)} · ${duration} · ${dimensions}`;
      return new Text(
        expanded ? `${summary}\n${theme.fg("dim", sanitizeTerminalText(asset.localPath))}` : summary,
        0,
        0,
      );
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const localPath = resolve(ctx.cwd, params.path);
      if (!ctx.model || !isKimiVideoModel(ctx.model)) {
        throw new Error("The selected model does not support native video input.");
      }

      const timeoutMs = parseTimeoutMs(process.env.PI_KIMI_VIDEO_TIMEOUT_MS);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let asset: VideoAsset;
      try {
        asset = await prepareAsset(localPath, "", ctx, operationSignal);
      } catch (error) {
        throw new Error(operationErrorMessage(error, operationSignal, timeoutMs));
      }
      rememberAsset(asset);
      return {
        content: createVideoToolContent(asset),
        details: asset,
      };
    },
  });

  const syncVideoTool = (model: ExtensionContext["model"]): void => {
    const active = pi.getActiveTools();
    const hasTool = active.includes("read_video");
    const shouldEnable = isKimiVideoModel(model);
    if (shouldEnable === hasTool) return;
    pi.setActiveTools(shouldEnable
      ? [...active, "read_video"]
      : active.filter((name) => name !== "read_video"));
  };
  pi.on("session_start", (_event, ctx) => syncVideoTool(ctx.model));
  pi.on("model_select", (event) => syncVideoTool(event.model));


  pi.on("before_provider_request", (event, ctx) =>
    rewriteProviderPayload(event.payload, getAssets(ctx), ctx.model),
  );
}

export function createVideoToolContent(asset: VideoAsset) {
  return [
    {
      type: "text" as const,
      text: `${asset.marker}\nNative video content is attached to this request. Analyze the video directly. If its content is unavailable, state that explicitly; never infer content from the file name.`,
    },
    ...(asset.thumbnailBase64
      ? [{ type: "image" as const, data: asset.thumbnailBase64, mimeType: "image/jpeg" }]
      : []),
  ];
}

async function prepareAsset(
  localPath: string,
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<VideoAsset> {
  if (!ctx.model || !isKimiVideoModel(ctx.model)) {
    throw new Error("The selected model no longer exposes Kimi video input.");
  }
  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) throw new Error(`Video path is not a regular file: ${localPath}`);
  const mimeType = validateVideoFile(
    localPath,
    fileStat.size,
    parseMaxBytes(process.env.PI_KIMI_VIDEO_MAX_BYTES),
  );
  const hash = await sha256File(localPath, signal);
  const reusable = findReusableAsset(getAssets(ctx), ctx.model.provider, ctx.model.baseUrl, hash);

  let uploaded: { fileId: string; msUri: string };
  let media: Awaited<ReturnType<typeof inspectVideo>>;
  if (reusable) {
    uploaded = { fileId: reusable.fileId, msUri: reusable.msUri };
    media = {
      ...(reusable.duration !== null ? { duration: reusable.duration } : {}),
      ...(reusable.width !== null ? { width: reusable.width } : {}),
      ...(reusable.height !== null ? { height: reusable.height } : {}),
    };
  } else {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) throw new Error(`Kimi authentication unavailable: ${auth.error}`);
    if (!auth.apiKey && !hasAuthorization(auth.headers)) {
      throw new Error(`Kimi authentication is missing. Run /login ${ctx.model.provider} and try again.`);
    }
    const headers: Record<string, string> = { ...(auth.headers ?? {}) };
    if (auth.apiKey && !hasAuthorization(headers)) headers.Authorization = `Bearer ${auth.apiKey}`;
    [uploaded, media] = await Promise.all([
      uploadVideo(localPath, mimeType, videoFilesBaseUrl(ctx.model), headers, signal),
      inspectVideo(localPath, signal),
    ]);
  }

  return {
    marker: `[[pi-kimi-video:v1:${randomUUID()}]]`,
    version: "v1",
    fileId: uploaded.fileId,
    msUri: uploaded.msUri,
    provider: ctx.model.provider as VideoAsset["provider"],
    baseUrl: ctx.model.baseUrl,
    fileName: basename(localPath),
    localPath,
    hash,
    mimeType,
    size: fileStat.size,
    duration: media.duration ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    thumbnailBase64: media.thumbnailBase64 ?? null,
    prompt,
    createdAt: new Date().toISOString(),
  };
}

function rememberAsset(asset: VideoAsset): void {
  runtimeAssets.set(asset.marker, asset);
}

function getAssets(ctx: ExtensionContext): VideoAsset[] {
  const assets = new Map(runtimeAssets);
  for (const asset of assetsFromBranch(ctx.sessionManager.getBranch())) {
    assets.set(asset.marker, asset);
  }
  return [...assets.values()];
}

function hasAuthorization(headers: Readonly<Record<string, string>> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationErrorMessage(
  error: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): string {
  if (hasErrorName(signal?.reason, "TimeoutError") || hasErrorName(error, "TimeoutError")) {
    return `Video upload timed out after ${timeoutMs ?? "the configured timeout"} ms. Adjust PI_KIMI_VIDEO_TIMEOUT_MS and try again.`;
  }
  if (signal?.aborted || hasErrorName(error, "AbortError")) {
    return "Video upload was aborted before it completed.";
  }
  return errorMessage(error);
}

function hasErrorName(value: unknown, name: string): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === name) return true;
  return hasErrorName(value.cause, name);
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
