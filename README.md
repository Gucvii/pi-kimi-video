# pi-kimi-video

A small [Pi](https://github.com/earendil-works/pi) package that uploads a local video to Moonshot and gives it to Kimi K3 without putting the original video bytes or base64 data in the Pi session.

## Compatibility

This package intentionally supports only the direct Pi providers `moonshotai` and `moonshotai-cn`, model `kimi-k3`, using OpenAI Chat Completions. It does not support proxy providers, audio, Google APIs, OpenAI Responses, or other models.

Requires Node.js 22 or later, Pi 0.80.10-compatible extension APIs, and a `MOONSHOT_API_KEY`.

## Install

```sh
pi install git:github.com/Gucvii/pi-kimi-video
```

Set the key before starting Pi:

```sh
export MOONSHOT_API_KEY="..."
pi
```

Use `/login` if needed to configure Moonshot authentication, then use `/model` to select `moonshotai/kimi-k3` or `moonshotai-cn/kimi-k3`.

## Usage

```text
/video <path> [prompt]
/video "path with spaces/demo.mp4" Summarize the main events.
/video-list
/video-recall <marker-id-or-prefix> [prompt]
```

The default prompt is `Describe this video in detail.` Paths are resolved against Pi's current working directory. Supported extensions are `mp4`, `mpeg`, `mpg`, `mov`, `avi`, `flv`, `webm`, `wmv`, `3gp`, and `3gpp`.

The default limit is 512 MiB. Override it with an integer byte count:

```sh
export PI_KIMI_VIDEO_MAX_BYTES=1073741824
```

Hashing, optional media inspection, and upload share a 15-minute operation timeout. Override it with a positive integer number of milliseconds:

```sh
export PI_KIMI_VIDEO_TIMEOUT_MS=1800000
```

`/video` is accepted only while the agent is idle and a supported direct Kimi model is selected. Within the active session branch, a file already uploaded with the same provider, base URL, and SHA-256 hash is reused. `/video-recall` creates a new prompt from an existing active-branch asset without uploading again.

## Switching models

Video messages remain usable when models are switched:

- On direct Moonshot Kimi K3, the package injects the saved `ms://` asset into every matching historical user message immediately before each Chat Completions request.
- On every other model, it replaces the marker with a readable text placeholder and preserves the prompt. An `ms://` URI is never sent to a non-Kimi provider.
- Switching back to supported Kimi K3 restores the video injection from the active branch.

## Display and metadata

The TUI shows a compact, expandable card. If `ffprobe` and `ffmpeg` are installed, the card also includes duration, resolution, and a static first-frame thumbnail rendered with Pi TUI. These programs are optional; missing or failed probes do not fail the upload. The thumbnail is a moderately compressed JPEG with a maximum 480-pixel side and bounded output size. The terminal displays a thumbnail, not video playback.

The original video is never stored as base64 in the session. The first `/video` message may store this small JPEG thumbnail as base64 for display; `/video-recall` does not copy the thumbnail into its new asset.

## Limits and lifecycle

- Moonshot controls uploaded asset retention and availability. An old `ms://` asset can expire even though its metadata remains in the Pi session.
- Session compaction may remove the original custom message from active model context. If the asset is still on the active branch, use `/video-recall` to create a fresh reference.
- Assets are reused only inside the current active branch. There is no global or cross-session upload cache.
- This package handles only Chat Completions payloads it recognizes. Unknown payload shapes are left unchanged.

## Security

The extension reads only the selected regular file and streams it to the current model's Moonshot `/files` endpoint. It validates extension and size before upload. Original video bytes and API keys are never written to the Pi session or logged by this package. Session metadata does include the resolved local path, SHA-256 hash, Moonshot file ID/URI, prompt, an optional small JPEG thumbnail on the first message, and media metadata. Review third-party Pi packages before installation because extensions run with your user permissions.

## Development

```sh
npm install --ignore-scripts
npm run check
```

Tests use Node's built-in TypeScript support and `node --test`; upload tests use only a loopback `node:http` server and never call Moonshot or another external network API.

## License

MIT
