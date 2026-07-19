import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text } from "@earendil-works/pi-tui";
import { findVideoAttachment, inspectVideo, sha256File, uploadVideo } from "../src/io.ts";
import {
  assetsFromBranch,
  findReusableAsset,
  formatBytes,
  isDirectKimi,
  parseMaxBytes,
  parseTimeoutMs,
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
    const dimensions = typeof asset.width === "number" && typeof asset.height === "number"
      ? `${asset.width}×${asset.height}`
      : "unknown";
    const duration = typeof asset.duration === "number" ? formatDuration(asset.duration) : "unknown";
    const fileName = sanitizeTerminalText(asset.fileName);
    const localPath = sanitizeTerminalText(asset.localPath);
    const summary = `${theme.fg("accent", "Video")} ${theme.bold(fileName)} · ${formatBytes(asset.size)} · ${duration} · ${dimensions}`;
    box.addChild(new Text(
      expanded ? `${summary}\n${theme.fg("dim", localPath)}` : summary,
      0,
      0,
    ));

    if (asset.thumbnailBase64) {
      box.addChild(new Image(
        asset.thumbnailBase64,
        "image/jpeg",
        { fallbackColor: (text) => theme.fg("dim", text) },
        {
          maxWidthCells: expanded ? 72 : 56,
          maxHeightCells: expanded ? 18 : 12,
          filename: `${singleLineTerminalText(asset.fileName)}.jpg`,
        },
      ));
    }
    return box;
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    let attachment: Awaited<ReturnType<typeof findVideoAttachment>>;
    try {
      attachment = await findVideoAttachment(event.text, ctx.cwd);
    } catch (error) {
      ctx.ui.notify(sanitizeTerminalText(errorMessage(error)), "error");
      return { action: "handled" as const };
    }
    if (!attachment) return { action: "continue" as const };

    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current turn to finish, then send the video again.", "warning");
      return { action: "handled" as const };
    }
    if (!ctx.model || !isDirectKimi(ctx.model)) {
      ctx.ui.notify(
        "Video input requires moonshotai/kimi-k3 or moonshotai-cn/kimi-k3. Configure Moonshot with /login, then select Kimi K3 with /model.",
        "warning",
      );
      return { action: "handled" as const };
    }

    ctx.ui.setStatus("kimi-video", `Uploading ${singleLineTerminalText(basename(attachment.localPath))}…`);
    let operationSignal: AbortSignal | undefined;
    let timeoutMs: number | undefined;
    try {
      timeoutMs = parseTimeoutMs(process.env.PI_KIMI_VIDEO_TIMEOUT_MS);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      operationSignal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
      const asset = await prepareAsset(
        attachment.localPath,
        attachment.prompt,
        ctx,
        operationSignal,
      );
      const markerText = `${asset.marker}\nAttached video: ${asset.fileName}`;
      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: markerText,
        display: true,
        details: asset,
      });
      return event.images
        ? { action: "transform" as const, text: attachment.prompt, images: event.images }
        : { action: "transform" as const, text: attachment.prompt };
    } catch (error) {
      ctx.ui.notify(sanitizeTerminalText(operationErrorMessage(error, operationSignal, timeoutMs)), "error");
      return { action: "handled" as const };
    } finally {
      ctx.ui.setStatus("kimi-video", undefined);
    }
  });

  pi.on("before_provider_request", (event, ctx) =>
    rewriteChatCompletionsPayload(event.payload, getAssets(ctx), ctx.model),
  );
}

async function prepareAsset(
  localPath: string,
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<VideoAsset> {
  if (!ctx.model || !isDirectKimi(ctx.model)) {
    throw new Error("The selected model is no longer a supported direct Kimi K3 endpoint.");
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
    if (!auth.ok) throw new Error(`Moonshot authentication unavailable: ${auth.error}`);
    if (!auth.apiKey && !hasAuthorization(auth.headers)) {
      throw new Error(`Moonshot authentication is missing. Run /login ${ctx.model.provider} and try again.`);
    }
    const headers: Record<string, string> = { ...(auth.headers ?? {}) };
    if (auth.apiKey && !hasAuthorization(headers)) headers.Authorization = `Bearer ${auth.apiKey}`;
    [uploaded, media] = await Promise.all([
      uploadVideo(localPath, mimeType, ctx.model.baseUrl, headers, signal),
      inspectVideo(localPath, signal),
    ]);
  }

  return {
    marker: `[[pi-kimi-video:v1:${randomUUID()}]]`,
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
    prompt,
    createdAt: new Date().toISOString(),
  };
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
