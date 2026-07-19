import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { uploadVideo } from "../src/io.ts";

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("uploadVideo sends an authenticated multipart video upload with a FormData boundary", async () => {
  let captured: CapturedRequest | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured = {
        url: request.url ?? "",
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks),
      };
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ id: "file-local" }));
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-kimi-video-upload-"));
  const path = join(directory, "tiny clip.mp4");
  await writeFile(path, "local-video-bytes");
  const port = await listen(server);
  try {
    const result = await uploadVideo(
      path,
      "video/mp4",
      `http://127.0.0.1:${port}/v1`,
      { Authorization: "Bearer local-token", "Content-Type": "application/json" },
      undefined,
    );
    assert.deepEqual(result, { fileId: "file-local", msUri: "ms://file-local" });
    assert.ok(captured);
    assert.equal(captured.url, "/v1/files");
    assert.equal(captured.authorization, "Bearer local-token");
    assert.match(captured.contentType ?? "", /^multipart\/form-data; boundary=/);
    assert.notEqual(captured.contentType, "application/json");
    const multipart = captured.body.toString("utf8");
    assert.match(multipart, /name="purpose"\r\n\r\nvideo/);
    assert.match(multipart, /name="file"; filename="tiny clip\.mp4"/);
    assert.match(multipart, /Content-Type: video\/mp4/i);
    assert.match(multipart, /local-video-bytes/);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("uploadVideo reports the HTTP status when an error response is not JSON", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain", connection: "close" });
    response.end("temporarily unavailable");
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-kimi-video-error-"));
  const path = join(directory, "tiny.mp4");
  await writeFile(path, "x");
  const port = await listen(server);
  try {
    await assert.rejects(
      uploadVideo(path, "video/mp4", `http://127.0.0.1:${port}/v1`, {}, undefined),
      /Moonshot video upload failed \(HTTP 503\)/,
    );
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
