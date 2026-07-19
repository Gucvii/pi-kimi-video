import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text } from "@earendil-works/pi-tui";
import { inspectVideo, sha256File, uploadVideo } from "../src/io.ts";
import {
  assetsFromBranch,
  findAssetByMarker,
  findReusableAsset,
  formatBytes,
  isDirectKimi,
  markerId,
  parseMaxBytes,
  parseRecallArgs,
  parseTimeoutMs,
  parseVideoArgs,
  rewriteChatCompletionsPayload,
  sanitizeTerminalText,
  singleLineTerminalText,
  validateVideoFile,
} from "../src/logic.ts";
import { CUSTOM_TYPE, type VideoAsset } from "../src/types.ts";

export default function kimiVideoExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<VideoAsset>(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const asset = message.details;
    if (!asset) {
      const content = typeof message.content === "string" ? sanitizeTerminalText(message.content) : "Kimi video";
      return new Text(content, 0, 0);
    }
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const dimensions = typeof asset.width === "number" && typeof asset.height === "number" ? `${asset.width}×${asset.height}` : "unknown";
    const duration = typeof asset.duration === "number" ? formatDuration(asset.duration) : "unknown";
    const fileName = sanitizeTerminalText(asset.fileName);
    const msUri = sanitizeTerminalText(asset.msUri);
    const marker = sanitizeTerminalText(asset.marker);
    const prompt = sanitizeTerminalText(asset.prompt);
    const compact = `${theme.fg("accent", "Kimi video")} ${theme.bold(fileName)} · ${formatBytes(asset.size)} · ${duration} · ${dimensions}`;
    box.addChild(new Text(expanded
      ? `${compact}\n${theme.fg("dim", `URI: ${msUri}`)}\n${theme.fg("dim", `Marker: ${marker}`)}\nPrompt: ${prompt}`
      : `${compact}\n${theme.fg("dim", msUri)}\n${prompt}`, 0, 0));
    if (expanded && asset.thumbnailBase64) {
      box.addChild(new Image(asset.thumbnailBase64, "image/jpeg", { fallbackColor: (text) => theme.fg("dim", text) }, {
        maxWidthCells: 72,
        maxHeightCells: 18,
        filename: `${singleLineTerminalText(asset.fileName)}.jpg`,
      }));
    }
    return box;
  });

  pi.registerCommand("video", {
    description: "Upload a video to direct Moonshot Kimi K3: /video <path> [prompt]",
    handler: async (args, ctx) => {
      let operationSignal: AbortSignal | undefined;
      let timeoutMs: number | undefined;
      try {
        if (!ctx.isIdle()) throw new Error("The agent must be idle before uploading a video.");
        if (!ctx.model || !isDirectKimi(ctx.model)) {
          throw new Error("/video requires the direct moonshotai or moonshotai-cn kimi-k3 model (OpenAI Chat Completions). Switch models first.");
        }
        timeoutMs = parseTimeoutMs(process.env.PI_KIMI_VIDEO_TIMEOUT_MS);
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        operationSignal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
        const parsed = parseVideoArgs(args);
        const localPath = resolve(ctx.cwd, parsed.path);
        const fileStat = await stat(localPath).catch((error: unknown) => {
          throw new Error(`Cannot read video file "${localPath}": ${errorMessage(error)}`);
        });
        if (!fileStat.isFile()) throw new Error(`Video path is not a regular file: ${localPath}`);
        const mimeType = validateVideoFile(localPath, fileStat.size, parseMaxBytes(process.env.PI_KIMI_VIDEO_MAX_BYTES));
        const hash = await sha256File(localPath, operationSignal);
        const branchAssets = getAssets(ctx);
        const reusable = findReusableAsset(branchAssets, ctx.model.provider, ctx.model.baseUrl, hash);

        let uploaded: { fileId: string; msUri: string };
        let media: Awaited<ReturnType<typeof inspectVideo>>;
        if (reusable) {
          uploaded = { fileId: reusable.fileId, msUri: reusable.msUri };
          media = {
            ...(reusable.duration !== null ? { duration: reusable.duration } : {}),
            ...(reusable.width !== null ? { width: reusable.width } : {}),
            ...(reusable.height !== null ? { height: reusable.height } : {}),
          };
          ctx.ui.notify(`Reusing active-branch upload ${singleLineTerminalText(reusable.msUri)}`, "info");
        } else {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
          if (!auth.ok) throw new Error(`Moonshot authentication unavailable: ${auth.error}`);
          if (!auth.apiKey && !hasAuthorization(auth.headers)) {
            throw new Error("Moonshot authentication unavailable. Set MOONSHOT_API_KEY and select the model again.");
          }
          const headers: Record<string, string> = { ...(auth.headers ?? {}) };
          if (auth.apiKey && !hasAuthorization(headers)) headers.Authorization = `Bearer ${auth.apiKey}`;
          [uploaded, media] = await Promise.all([
            uploadVideo(localPath, mimeType, ctx.model.baseUrl, headers, operationSignal),
            inspectVideo(localPath, operationSignal),
          ]);
        }

        const marker = `[[pi-kimi-video:v1:${randomUUID()}]]`;
        const asset: VideoAsset = {
          marker,
          version: "v1",
          fileId: uploaded.fileId,
          msUri: uploaded.msUri,
          provider: ctx.model.provider === "moonshotai-cn" ? "moonshotai-cn" : "moonshotai",
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
          prompt: parsed.prompt,
          createdAt: new Date().toISOString(),
        };
        pi.sendMessage({ customType: CUSTOM_TYPE, content: `${marker}\n${parsed.prompt}`, display: true, details: asset }, { triggerTurn: true });
      } catch (error) {
        ctx.ui.notify(sanitizeTerminalText(operationErrorMessage(error, operationSignal, timeoutMs)), "error");
      }
    },
  });

  pi.registerCommand("video-list", {
    description: "List Kimi video assets on the active branch",
    handler: async (_args, ctx) => {
      const assets = getAssets(ctx);
      if (assets.length === 0) {
        ctx.ui.notify("No Kimi videos are present on the active branch.", "info");
        return;
      }
      ctx.ui.notify(assets.map((asset) =>
        singleLineTerminalText(`${markerId(asset.marker).slice(0, 12)}  ${asset.fileName}  ${formatBytes(asset.size)}  ${asset.msUri}`),
      ).join("\n"), "info");
    },
  });

  pi.registerCommand("video-recall", {
    description: "Recall an active-branch video without uploading it again",
    handler: async (args, ctx) => {
      try {
        if (!ctx.isIdle()) throw new Error("The agent must be idle before recalling a video.");
        const parsed = parseRecallArgs(args);
        const original = findAssetByMarker(getAssets(ctx), parsed.id);
        const prompt = parsed.prompt || original.prompt;
        const marker = `[[pi-kimi-video:v1:${randomUUID()}]]`;
        const asset: VideoAsset = { ...original, marker, prompt, thumbnailBase64: null, createdAt: new Date().toISOString() };
        pi.sendMessage({ customType: CUSTOM_TYPE, content: `${marker}\n${prompt}`, display: true, details: asset }, { triggerTurn: true });
      } catch (error) {
        ctx.ui.notify(sanitizeTerminalText(errorMessage(error)), "error");
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) =>
    rewriteChatCompletionsPayload(event.payload, getAssets(ctx), ctx.model),
  );
}

function getAssets(ctx: ExtensionContext): VideoAsset[] {
  return assetsFromBranch(ctx.sessionManager.getBranch());
}

function hasAuthorization(headers: Readonly<Record<string, string>> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationErrorMessage(
  error: unknown, signal: AbortSignal | undefined, timeoutMs: number | undefined,
): string {
  if (hasErrorName(signal?.reason, "TimeoutError") || hasErrorName(error, "TimeoutError")) {
    return `Video operation timed out after ${timeoutMs ?? "the configured timeout"} ms. Adjust PI_KIMI_VIDEO_TIMEOUT_MS and try again.`;
  }
  if (signal?.aborted || hasErrorName(error, "AbortError")) {
    return "Video operation was aborted before it completed.";
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
