import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { inspectVideo, sha256File, uploadVideo } from "../src/io.ts";
import {
  assetsFromBranch,
  findReusableAsset,
  formatBytes,
  isKimiVideoModel,
  parseMaxBytes,
  parseTimeoutMs,
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
    description: "Read and analyze one local video with Kimi's video-capable OpenAI endpoint. Call it once per video when the user asks about one or more video paths.",
    promptSnippet: "Analyze a local video with Kimi vision",
    promptGuidelines: [
      "When the user asks about local video paths, call read_video once for each video. Pass the user's actual question in prompt. Never infer video content from a file name.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Local video path, relative or absolute" }),
      prompt: Type.Optional(Type.String({ description: "What the user wants to know about this video" })),
    }),
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("read_video"))} ${sanitizeTerminalText(args.path)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const asset = result.details as VideoAsset | undefined;
      if (!asset) {
        const message = result.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n") || "Video analysis failed";
        return new Text(theme.fg("error", sanitizeTerminalText(message)), 0, 0);
      }
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
        asset = await prepareAsset(localPath, params.prompt ?? "", ctx, operationSignal);
      } catch (error) {
        throw new Error(operationErrorMessage(error, operationSignal, timeoutMs));
      }
      rememberAsset(asset);
      let analysis: string;
      try {
        analysis = await analyzeVideo(
          asset,
          params.prompt?.trim() || "Describe only what visibly happens in this video. Do not infer from its file name.",
          ctx,
          operationSignal,
        );
      } catch (error) {
        throw new Error(operationErrorMessage(error, operationSignal, timeoutMs));
      }
      return {
        content: createVideoToolContent(asset, analysis),
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

}

export function createVideoToolContent(asset: VideoAsset, analysis: string) {
  return [
    { type: "text" as const, text: analysis },
    ...(asset.thumbnailBase64
      ? [{ type: "image" as const, data: asset.thumbnailBase64, mimeType: "image/jpeg" }]
      : []),
  ];
}

async function analyzeVideo(
  asset: VideoAsset,
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string> {
  if (!ctx.model || !isKimiVideoModel(ctx.model)) {
    throw new Error("The selected model no longer exposes Kimi video analysis.");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(`Kimi authentication unavailable: ${auth.error}`);
  if (!auth.apiKey && !hasAuthorization(auth.headers)) {
    throw new Error(`Kimi authentication is missing. Run /login ${ctx.model.provider} and try again.`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-kimi-video/0.6.0",
    ...(auth.headers ?? {}),
  };
  if (auth.apiKey && !hasAuthorization(headers)) headers.Authorization = `Bearer ${auth.apiKey}`;
  const response = await fetch(`${videoFilesBaseUrl(ctx.model)}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: ctx.model.id,
      messages: [{
        role: "user",
        content: [
          { type: "video_url", video_url: { url: asset.msUri } },
          { type: "text", text: prompt },
        ],
      }],
      max_completion_tokens: 4096,
      stream: false,
    }),
  });
  const body = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  if (!response.ok) throw new Error(formatAnalysisError(response.status, parsed, body));
  if (!isRecord(parsed)) throw new Error("Kimi video analysis returned an invalid JSON response.");
  const choices = parsed.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) && isRecord(first.message) ? first.message : undefined;
  const content = message && typeof message.content === "string" ? message.content.trim() : "";
  if (!content) {
    const finishReason = isRecord(first) && typeof first.finish_reason === "string" ? first.finish_reason : "unknown";
    throw new Error(`Kimi video analysis returned no answer (finish_reason=${finishReason}).`);
  }
  return content;
}

function formatAnalysisError(status: number, parsed: unknown, raw: string): string {
  let detail: string | undefined;
  if (isRecord(parsed)) {
    if (typeof parsed.message === "string") detail = parsed.message;
    else if (isRecord(parsed.error) && typeof parsed.error.message === "string") detail = parsed.error.message;
    else if (typeof parsed.error === "string") detail = parsed.error;
  }
  if (!detail && raw.trim()) detail = raw.trim().slice(0, 500);
  return `Kimi video analysis failed (HTTP ${status})${detail ? `: ${detail}` : "."}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    return `Video operation timed out after ${timeoutMs ?? "the configured timeout"} ms. Adjust PI_KIMI_VIDEO_TIMEOUT_MS and try again.`;
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
