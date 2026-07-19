import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import kimiVideoExtension from "../extensions/index.ts";
import type { ModelIdentity, VideoAsset } from "../src/types.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type ProviderRequestHandler = (
  event: { type: "before_provider_request"; payload: unknown },
  ctx: ExtensionContext,
) => unknown;

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

test("extension uploads, persists a custom message, and rewrites by selected model", async () => {
  const commands = new Map<string, CommandHandler>();
  let providerRequestHandler: ProviderRequestHandler | undefined;
  const sent: SentMessage[] = [];

  const pi = {
    registerMessageRenderer: () => {},
    registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
    on: (event: string, handler: ProviderRequestHandler) => {
      if (event === "before_provider_request") providerRequestHandler = handler;
    },
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push(options ? { message, options } : { message });
    },
  } as unknown as ExtensionAPI;
  kimiVideoExtension(pi);

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "file-extension-test" }));
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-kimi-video-extension-"));
  const videoPath = join(directory, "demo.mp4");
  await writeFile(videoPath, "small fake video payload");
  const port = await listen(server);
  const model: ModelIdentity = {
    provider: "moonshotai",
    id: "kimi-k3",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
  };
  let branch: Array<{ type: string; customType: string; details: VideoAsset }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
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
    },
  } as unknown as ExtensionContext;

  try {
    const videoCommand = commands.get("video");
    assert.ok(videoCommand);
    await videoCommand("demo.mp4 Explain the visible behavior.", context);
    assert.deepEqual(notifications, []);
    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first);
    assert.equal(first.message.customType, "kimi-video");
    assert.equal(first.message.display, true);
    assert.equal(first.options?.triggerTurn, true);
    assert.equal(typeof first.message.content, "string");
    const asset = first.message.details as VideoAsset;
    assert.equal(asset.msUri, "ms://file-extension-test");
    assert.equal(asset.localPath, videoPath);
    assert.doesNotMatch(JSON.stringify(first), /small fake video payload/);

    branch = [{ type: "custom_message", customType: "kimi-video", details: asset }];
    assert.ok(providerRequestHandler);
    const originalPayload = {
      messages: [{ role: "user", content: [{ type: "text", text: first.message.content }] }],
    };
    const kimiPayload = providerRequestHandler(
      { type: "before_provider_request", payload: originalPayload },
      context,
    );
    assert.match(JSON.stringify(kimiPayload), /ms:\/\/file-extension-test/);

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
