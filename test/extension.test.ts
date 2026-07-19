import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import kimiVideoExtension, { createVideoToolContent } from "../extensions/index.ts";
import type { ModelIdentity, VideoAsset } from "../src/types.ts";

type VideoTool = {
  name: string;
  description: string;
  promptGuidelines?: string[];
  renderResult?: (
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    options: { expanded: boolean },
    theme: { fg: (_name: string, text: string) => string; bold: (text: string) => string },
  ) => unknown;
  execute: (
    toolCallId: string,
    params: { path: string; prompt?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }>;
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind to a port.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("read_video uploads and analyzes through Kimi's OpenAI video endpoint", async () => {
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let modelSelectHandler: ((event: { model: ModelIdentity }) => void) | undefined;
  let videoTool: VideoTool | undefined;
  let activeTools = ["read", "bash", "read_video"];
  let inputHandlerRegistered = false;

  const pi = {
    registerTool: (tool: VideoTool) => { videoTool = tool; },
    on: (event: string, handler: unknown) => {
      if (event === "input") inputHandlerRegistered = true;
      if (event === "session_start") sessionStartHandler = handler as typeof sessionStartHandler;
      if (event === "model_select") modelSelectHandler = handler as typeof modelSelectHandler;
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as unknown as ExtensionAPI;
  kimiVideoExtension(pi);
  assert.equal(inputHandlerRegistered, false);

  const requestPaths: string[] = [];
  let analysisRequest: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.endsWith("/chat/completions")) {
        analysisRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.end(JSON.stringify({
          choices: [{ message: { content: "The video visibly shows a football detection demo." }, finish_reason: "stop" }],
        }));
      } else {
        response.end(JSON.stringify({ id: "file-extension-test" }));
      }
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-kimi-video-extension-"));
  const videoPath = join(directory, "demo clip.mp4");
  await writeFile(videoPath, "small fake video payload");
  const port = await listen(server);
  const model: ModelIdentity = {
    provider: "kimi-coding",
    id: "kimi-for-coding",
    api: "anthropic-messages",
    baseUrl: `http://127.0.0.1:${port}/coding`,
  };
  const context = {
    cwd: directory,
    model,
    signal: undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "local-test-key" }),
    },
    sessionManager: { getBranch: () => [] },
    ui: {},
  } as unknown as ExtensionContext;

  try {
    assert.ok(sessionStartHandler);
    sessionStartHandler({}, { ...context, model: { ...model, id: "unsupported" } } as ExtensionContext);
    assert.doesNotMatch(activeTools.join(" "), /read_video/);
    assert.ok(modelSelectHandler);
    modelSelectHandler({ model });
    assert.match(activeTools.join(" "), /read_video/);

    assert.ok(videoTool);
    assert.match(videoTool.description, /analyze one local video/);
    assert.match(videoTool.promptGuidelines?.join(" ") ?? "", /once for each video/);
    const readResult = await videoTool.execute(
      "read-call",
      { path: videoPath, prompt: "What happens?" },
      undefined,
      undefined,
      context,
    );
    const readAsset = readResult.details as VideoAsset;
    assert.equal(readAsset.msUri, "ms://file-extension-test");
    assert.deepEqual(requestPaths, ["/coding/v1/files", "/coding/v1/chat/completions"]);
    assert.equal(readResult.content[0]?.text, "The video visibly shows a football detection demo.");
    assert.doesNotMatch(JSON.stringify(readResult.content), /pi-kimi-video|demo clip/);

    const messages = analysisRequest?.messages as Array<{ content: unknown[] }>;
    assert.deepEqual(messages[0]?.content, [
      { type: "video_url", video_url: { url: "ms://file-extension-test" } },
      { type: "text", text: "What happens?" },
    ]);

    await videoTool.execute(
      "read-call-2",
      { path: videoPath, prompt: "Focus on the labels." },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(requestPaths, [
      "/coding/v1/files",
      "/coding/v1/chat/completions",
      "/coding/v1/chat/completions",
    ]);
    const secondMessages = analysisRequest?.messages as Array<{ content: unknown[] }>;
    assert.deepEqual(secondMessages[0]?.content, [
      { type: "video_url", video_url: { url: "ms://file-extension-test" } },
      { type: "text", text: "Focus on the labels." },
    ]);

    assert.deepEqual(createVideoToolContent({ ...readAsset, thumbnailBase64: "AA==" }, "analysis"), [
      { type: "text", text: "analysis" },
      { type: "image", data: "AA==", mimeType: "image/jpeg" },
    ]);

    assert.ok(videoTool.renderResult);
    const renderedError = videoTool.renderResult(
      { content: [{ type: "text", text: "specific failure" }] },
      { expanded: true },
      { fg: (_name, text) => text, bold: (text) => text },
    ) as { render: (width: number) => string[] };
    assert.match(renderedError.render(80).join("\n"), /specific failure/);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
