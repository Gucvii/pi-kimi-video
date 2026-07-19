import assert from "node:assert/strict";
import test from "node:test";
import {
  assetsFromBranch,
  findReusableAsset,
  isKimiVideoModel,
  isVideoAsset,
  parseMaxBytes,
  parseTimeoutMs,
  sanitizeTerminalText,
  singleLineTerminalText,
  validateVideoFile,
  videoFilesBaseUrl,
} from "../src/logic.ts";
import type { ModelIdentity, VideoAsset } from "../src/types.ts";

const model: ModelIdentity = {
  provider: "kimi-coding",
  id: "kimi-for-coding",
  baseUrl: "https://api.kimi.com/coding",
  api: "anthropic-messages",
};

const asset: VideoAsset = {
  marker: "[[pi-kimi-video:v1:123e4567-e89b-12d3-a456-426614174000]]",
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

test("recognizes supported Kimi Coding models and endpoints", () => {
  assert.equal(isKimiVideoModel(model), true);
  assert.equal(isKimiVideoModel({ ...model, id: "kimi-for-coding-highspeed" }), true);
  assert.equal(isKimiVideoModel({ ...model, id: "k3" }), true);
  assert.equal(isKimiVideoModel({ ...model, id: "other" }), false);
  assert.equal(isKimiVideoModel({ ...model, provider: "other" }), false);
  assert.equal(videoFilesBaseUrl(model), "https://api.kimi.com/coding/v1");
});

test("validates and restores read_video assets", () => {
  assert.equal(isVideoAsset(asset), true);
  assert.equal(isVideoAsset({ ...asset, msUri: "https://wrong" }), false);
  const entries = [
    { type: "message", details: asset },
    { type: "message", message: { role: "toolResult", toolName: "read_video", details: asset } },
    { type: "message", message: { role: "toolResult", toolName: "other", details: asset } },
  ];
  assert.deepEqual(assetsFromBranch(entries), [asset]);
});

test("reuses uploads only for the same provider, endpoint, and hash", () => {
  assert.equal(findReusableAsset([asset], "kimi-coding", "https://api.kimi.com/coding/", "abc"), asset);
  assert.equal(findReusableAsset([asset], "other-provider", asset.baseUrl, "abc"), undefined);
  assert.equal(findReusableAsset([asset], "kimi-coding", asset.baseUrl, "different"), undefined);
});

test("sanitizes terminal-controlled file names and errors", () => {
  const malicious = "safe\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\nnext\u001b[31mred\u001b[0m\u009b2J";
  const cleaned = sanitizeTerminalText(malicious);
  assert.equal(cleaned, "safelink nextred");
  assert.doesNotMatch(cleaned, /[\u0000-\u001F\u007F-\u009F]/);
  assert.equal(singleLineTerminalText("file\nname\r\t.mp4"), "file name .mp4");
});
