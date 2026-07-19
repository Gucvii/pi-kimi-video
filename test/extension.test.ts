import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import kimiVideoExtension from "../extensions/index.ts";
import type { ModelIdentity, VideoAsset } from "../src/types.ts";

type ProviderRequestHandler = (
  event: { type: "before_provider_request"; payload: unknown },
  ctx: ExtensionContext,
) => unknown;

type VideoTool = {
  name: string;
  description: string;
  promptGuidelines?: string[];
  renderShell?: string;
  renderResult?: (
    result: { details?: unknown },
    options: { expanded: boolean },
    theme: { fg: (_name: string, text: string) => string; bold: (text: string) => string },
  ) => unknown;
  execute: (
    toolCallId: string,
    params: { path: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
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

test("read_video uploads, renders, and injects a top-level native video block", async () => {
  let providerRequestHandler: ProviderRequestHandler | undefined;
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let modelSelectHandler: ((event: { model: ModelIdentity }) => void) | undefined;
  let videoTool: VideoTool | undefined;
  let activeTools = ["read", "bash", "read_video"];

  const pi = {
    registerTool: (tool: VideoTool) => { videoTool = tool; },
    on: (event: string, handler: unknown) => {
      if (event === "before_provider_request") providerRequestHandler = handler as ProviderRequestHandler;
      if (event === "session_start") sessionStartHandler = handler as typeof sessionStartHandler;
      if (event === "model_select") modelSelectHandler = handler as typeof modelSelectHandler;
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as unknown as ExtensionAPI;
  kimiVideoExtension(pi);

  let uploadPath: string | undefined;
  const server = createServer((request, response) => {
    uploadPath = request.url;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "file-extension-test" }));
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
    assert.equal(videoTool.name, "read_video");
    assert.match(videoTool.description, /Read a local video/);
    assert.match(videoTool.promptGuidelines?.join(" ") ?? "", /instead of inferring/);
    const readResult = await videoTool.execute(
      "read-call",
      { path: videoPath },
      undefined,
      undefined,
      context,
    );
    const readAsset = readResult.details as VideoAsset;
    assert.equal(readAsset.msUri, "ms://file-extension-test");
    assert.equal(uploadPath, "/coding/v1/files");
    assert.match(readResult.content[0]?.text ?? "", /Analyze the video directly/);
    assert.doesNotMatch(readResult.content[0]?.text ?? "", /demo clip/);

    assert.ok(providerRequestHandler);
    const payload = { messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "read-call",
        content: readResult.content,
      }],
    }] };
    const injected = providerRequestHandler(
      { type: "before_provider_request", payload },
      context,
    ) as { messages: Array<{ content: unknown[] }> };
    assert.deepEqual(injected.messages[0]?.content, [
      {
        type: "tool_result",
        tool_use_id: "read-call",
        content: [{
          type: "text",
          text: "Native video content is attached to this request. Analyze the video directly. If its content is unavailable, state that explicitly; never infer content from the file name.",
        }],
      },
      { type: "video", source: { type: "url", url: "ms://file-extension-test" } },
    ]);
    assert.doesNotMatch(JSON.stringify(injected), /pi-kimi-video/);

    assert.equal(videoTool.renderShell, "self");
    assert.ok(videoTool.renderResult);
    const rendered = videoTool.renderResult(
      { details: { ...readAsset, thumbnailBase64: "AA==" } },
      { expanded: false },
      { fg: (_name, text) => text, bold: (text) => text },
    ) as { children: unknown[] };
    assert.equal(rendered.children.length, 2);
    assert.equal(rendered.children[1]?.constructor.name, "Image");
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
