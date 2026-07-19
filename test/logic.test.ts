import assert from "node:assert/strict";
import test from "node:test";
import {
  assetsFromBranch,
  findReusableAsset,
  isKimiVideoModel,
  parseMaxBytes,
  parseTimeoutMs,
  promptWithoutVideoReference,
  rewriteProviderPayload,
  sanitizeTerminalText,
  singleLineTerminalText,
  validateVideoFile,
  videoFilesBaseUrl,
  videoReferenceCandidates,
} from "../src/logic.ts";
import type { ModelIdentity, VideoAsset } from "../src/types.ts";

const marker = "[[pi-kimi-video:v1:123e4567-e89b-12d3-a456-426614174000]]";
const model: ModelIdentity = {
  provider: "kimi-coding",
  id: "kimi-for-coding",
  baseUrl: "https://api.kimi.com/coding",
  api: "anthropic-messages",
};

const asset: VideoAsset = {
  marker,
  version: "v1",
  fileId: "file-1",
  msUri: "ms://file-1",
  provider: "kimi-coding",
  baseUrl: model.baseUrl,
  fileName: "clip.mp4",
  localPath: "/tmp/clip.mp4",
  hash: "abc",
  mimeType: "video/mp4",
  size: 1024,
  duration: 2,
  width: 1920,
  height: 1080,
  thumbnailBase64: null,
  prompt: "Explain it",
  createdAt: "2026-01-01T00:00:00.000Z",
};


test("detects video references without exposing attachment commands", () => {
  const quoted = 'Explain @"/tmp/my clip.mp4" carefully';
  const [quotedCandidate] = videoReferenceCandidates(quoted);
  assert.deepEqual(quotedCandidate, {
    value: "/tmp/my clip.mp4",
    start: 8,
    end: quoted.indexOf(" carefully"),
  });
  assert.equal(
    promptWithoutVideoReference(quoted, quotedCandidate!),
    "Explain carefully",
  );

  assert.equal(
    videoReferenceCandidates("/tmp/my\\ clip.mp4 describe it")[0]?.value,
    "/tmp/my clip.mp4",
  );
  assert.equal(
    videoReferenceCandidates("C:\\videos\\clip.mp4 describe it")[0]?.value,
    "C:\\videos\\clip.mp4",
  );
  assert.equal(
    promptWithoutVideoReference("@clip.mp4", videoReferenceCandidates("@clip.mp4")[0]!),
    "Describe this video in detail.",
  );
});

test("validates formats and size limits", () => {
  assert.equal(validateVideoFile("MOVIE.MP4", 10, 20), "video/mp4");
  assert.equal(validateVideoFile("movie.3gpp", 10, 20), "video/3gpp");
  assert.throws(() => validateVideoFile("movie.mkv", 10, 20), /Unsupported/);
  assert.throws(() => validateVideoFile("movie.mp4", 21, 20), /exceeding/);
  assert.equal(parseMaxBytes(undefined), 512 * 1024 * 1024);
  assert.throws(() => parseMaxBytes("0"), /positive integer/);
});

test("parses the operation timeout", () => {
  assert.equal(parseTimeoutMs(undefined), 15 * 60 * 1000);
  assert.equal(parseTimeoutMs("12345"), 12345);
  for (const invalid of ["0", "-1", "1.5", "Infinity", "nope"]) {
    assert.throws(() => parseTimeoutMs(invalid), /positive integer/);
  }
});

test("injects native video and a clean prompt into Kimi Coding content", () => {
  const payload = { messages: [{ role: "user", content: `${marker}\nExplain it` }] };
  const result = rewriteProviderPayload(payload, [asset], model);
  assert.deepEqual(result, { messages: [{ role: "user", content: [
    { type: "video", source: { type: "url", url: "ms://file-1" } },
    { type: "text", text: "Explain it" },
  ] }] });
});

test("supports Kimi Coding video models through the Anthropic-compatible payload", () => {
  assert.equal(isKimiVideoModel(model), true);
  assert.equal(isKimiVideoModel({ ...model, id: "kimi-for-coding-highspeed" }), true);
  assert.equal(isKimiVideoModel({ ...model, id: "k3" }), true);
  assert.equal(isKimiVideoModel({ ...model, id: "k2p7" }), false);
  assert.equal(videoFilesBaseUrl(model), "https://api.kimi.com/coding/v1");

  const payload = { messages: [{ role: "user", content: [{ type: "text", text: `${marker}\nExplain it` }] }] };
  assert.deepEqual(rewriteProviderPayload(payload, [asset], model), {
    messages: [{ role: "user", content: [
      { type: "video", source: { type: "url", url: "ms://file-1" } },
      { type: "text", text: "Explain it" },
    ] }],
  });
});

test("injects video into an Anthropic tool_result produced by read_video", () => {
  const payload = { messages: [{
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "call-1",
      content: [{ type: "text", text: `${marker}\nRead video file` }],
    }],
  }] };
  assert.deepEqual(rewriteProviderPayload(payload, [asset], model), {
    messages: [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "call-1",
      content: [
        { type: "video", source: { type: "url", url: "ms://file-1" } },
        { type: "text", text: "Read video file" },
      ],
    }] }],
  });
});

test("uses safe text placeholders for non-Kimi models and never emits ms URI", () => {
  const payload = { messages: [{ role: "user", content: `${marker}\nExplain it` }] };
  const result = rewriteProviderPayload(payload, [asset], undefined);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Video attachment unavailable/);
  assert.match(serialized, /Explain it/);
  assert.doesNotMatch(serialized, /ms:\/\//);
});

test("injects only when model and normalized Kimi Coding endpoint match", () => {
  const payload = { messages: [{ role: "user", content: `${marker}\nKeep this prompt` }] };
  const mismatches: ModelIdentity[] = [
    { ...model, id: "k2p7" },
    { ...model, baseUrl: "https://other.kimi.test/coding" },
  ];
  for (const mismatch of mismatches) {
    const result = rewriteProviderPayload(payload, [asset], mismatch);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /ms:\/\//);
    assert.match(serialized, /Video attachment unavailable/);
    assert.match(serialized, /Keep this prompt/);
  }

  const matched = JSON.stringify(rewriteProviderPayload(payload, [asset], model));
  assert.match(matched, /ms:\/\/file-1/);
});

test("rewrites text parts while preserving image and custom content parts", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,x" } };
  const tool = { type: "tool_result", value: 7 };
  const payload = { messages: [{ role: "user", content: [image, { type: "text", text: `${marker}\nPrompt` }, tool] }] };
  const result = rewriteProviderPayload(payload, [asset], model) as { messages: Array<{ content: unknown[] }> };
  assert.equal(result.messages[0]?.content[0], image);
  assert.deepEqual(result.messages[0]?.content[1], { type: "video", source: { type: "url", url: asset.msUri } });
  assert.equal(result.messages[0]?.content[3], tool);
});

test("reinjects every matching historical user message", () => {
  const payload = { messages: [
    { role: "user", content: `${marker}\nFirst` },
    { role: "assistant", content: "answer" },
    { role: "user", content: `${marker}\nSecond` },
  ] };
  const result = rewriteProviderPayload(payload, [asset], model) as { messages: Array<{ content: unknown }> };
  assert.ok(Array.isArray(result.messages[0]?.content));
  assert.ok(Array.isArray(result.messages[2]?.content));
  assert.equal(result.messages[1]?.content, "answer");
});

test("leaves unknown markers and unknown payload shapes unchanged", () => {
  const unknown = "[[pi-kimi-video:v1:00000000-0000-0000-0000-000000000000]]\nHello";
  const payload = { messages: [{ role: "user", content: unknown }] };
  assert.equal(rewriteProviderPayload(payload, [asset], model), payload);
  const other = { input: "not chat completions" };
  assert.equal(rewriteProviderPayload(other, [asset], model), other);
});

test("removes terminal control sequences and forces untrusted list values onto one line", () => {
  const malicious = "safe\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\nnext\u001b[31mred\u001b[0m\u009b2J";
  const cleaned = sanitizeTerminalText(malicious);
  assert.equal(cleaned, "safelink nextred");
  assert.doesNotMatch(cleaned, /[\u0000-\u001F\u007F-\u009F]/);
  assert.equal(singleLineTerminalText("file\nname\r\t.mp4"), "file name .mp4");
});

test("restores assets from explicit attachments and read_video results", () => {
  const entries = [
    { type: "custom_message", customType: "other", details: asset },
    { type: "message", details: asset },
    { type: "message", message: { role: "toolResult", toolName: "read_video", details: asset } },
    { type: "custom_message", customType: "kimi-video", details: asset },
    { type: "custom_message", customType: "kimi-video", details: { broken: true } },
  ];
  assert.deepEqual(assetsFromBranch(entries), [asset, asset]);
});

test("finds reusable uploads by provider, normalized base URL, and hash", () => {
  assert.equal(findReusableAsset([asset], "kimi-coding", "https://api.kimi.com/coding/", "abc"), asset);
  assert.equal(findReusableAsset([asset], "other-provider", asset.baseUrl, "abc"), undefined);
  assert.equal(findReusableAsset([asset], "kimi-coding", asset.baseUrl, "different"), undefined);
});
