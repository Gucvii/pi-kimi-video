import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import kimiVideoExtension from "../extensions/index.ts";
import type { ModelIdentity, VideoAsset } from "../src/types.ts";

type InputHandler = (
  event: { text: string; images?: unknown[]; source: string },
  ctx: ExtensionContext,
) => Promise<{ action: string; text?: string; images?: unknown[] }>;
type ProviderRequestHandler = (
  event: { type: "before_provider_request"; payload: unknown },
  ctx: ExtensionContext,
) => unknown;
type MessageRenderer = (
  message: { content: string; details?: VideoAsset },
  options: { expanded: boolean },
  theme: { bg: (_name: string, text: string) => string; fg: (_name: string, text: string) => string; bold: (text: string) => string },
) => unknown;
type ReadOverride = {
  name: string;
  description: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { path: string; offset?: number; limit?: number },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
};

interface SentMessage {
  message: {
    customType: string;
    content: string | unknown[];
    display: boolean;
    details?: unknown;
  };
  options?: { triggerTurn?: boolean };
}

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

test("extension turns a normal video attachment into persisted Kimi context", async () => {
  let inputHandler: InputHandler | undefined;
  let messageRenderer: MessageRenderer | undefined;
  let providerRequestHandler: ProviderRequestHandler | undefined;
  let readOverride: ReadOverride | undefined;
  const sent: SentMessage[] = [];

  const pi = {
    registerMessageRenderer: (_type: string, renderer: MessageRenderer) => { messageRenderer = renderer; },
    registerTool: (tool: ReadOverride) => { readOverride = tool; },
    on: (event: string, handler: InputHandler | ProviderRequestHandler) => {
      if (event === "input") inputHandler = handler as InputHandler;
      if (event === "before_provider_request") providerRequestHandler = handler as ProviderRequestHandler;
    },
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push(options ? { message, options } : { message });
    },
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
  let branch: Array<Record<string, unknown>> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const context = {
    cwd: directory,
    model,
    signal: undefined,
    isIdle: () => true,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "local-test-key" }),
    },
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as unknown as ExtensionContext;

  try {
    assert.ok(readOverride);
    assert.equal(readOverride.name, "read");
    assert.match(readOverride.description, /Video files/);
    assert.match(readOverride.promptGuidelines?.join(" ") ?? "", /Use read on a video path/);
    const readResult = await readOverride.execute(
      "read-call",
      { path: videoPath },
      undefined,
      undefined,
      context,
    );
    const readAsset = readResult.details as VideoAsset;
    assert.equal(readAsset.msUri, "ms://file-extension-test");
    assert.match(readResult.content[0]?.text ?? "", /Read video file/);
    branch = [{
      type: "message",
      message: { role: "toolResult", toolName: "read", details: readAsset },
    }];
    assert.ok(inputHandler);
    const image = { type: "image", data: "base64-image", mimeType: "image/png" };
    const result = await inputHandler(
      { text: '@"demo clip.mp4" Explain the visible behavior.', images: [image], source: "interactive" },
      context,
    );
    assert.deepEqual(result, {
      action: "transform",
      text: "Explain the visible behavior.",
      images: [image],
    });
    assert.deepEqual(notifications, []);
    assert.equal(statuses.at(-1), undefined);
    assert.equal(uploadPath, "/coding/v1/files");
    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first);
    assert.equal(first.message.customType, "kimi-video");
    assert.equal(first.message.display, true);
    assert.equal(first.options, undefined);
    assert.equal(typeof first.message.content, "string");
    const asset = first.message.details as VideoAsset;
    assert.equal(asset.msUri, "ms://file-extension-test");
    assert.equal(asset.localPath, videoPath);
    assert.doesNotMatch(JSON.stringify(first), /small fake video payload/);

    assert.ok(messageRenderer);
    const rendered = messageRenderer(
      { content: "", details: { ...asset, thumbnailBase64: "AA==" } },
      { expanded: false },
      {
        bg: (_name, text) => text,
        fg: (_name, text) => text,
        bold: (text) => text,
      },
    ) as { children: unknown[] };
    assert.equal(rendered.children.length, 2);
    assert.equal(rendered.children[1]?.constructor.name, "Image");

    branch = [{ type: "custom_message", customType: "kimi-video", details: asset }];
    assert.ok(providerRequestHandler);
    const originalPayload = {
      messages: [{ role: "user", content: [{ type: "text", text: first.message.content }] }],
    };
    const kimiPayload = providerRequestHandler(
      { type: "before_provider_request", payload: originalPayload },
      context,
    );
    assert.deepEqual(
      (kimiPayload as { messages: Array<{ content: unknown[] }> }).messages[0]?.content[0],
      { type: "video", source: { type: "url", url: "ms://file-extension-test" } },
    );

    const textContext = {
      ...context,
      model: { provider: "openai", id: "text-only", api: "openai-completions", baseUrl: "https://example.test/v1" },
    } as unknown as ExtensionContext;
    const textPayload = providerRequestHandler(
      { type: "before_provider_request", payload: originalPayload },
      textContext,
    );
    const serializedTextPayload = JSON.stringify(textPayload);
    assert.match(serializedTextPayload, /Video attachment unavailable/);
    assert.doesNotMatch(serializedTextPayload, /ms:\/\//);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
