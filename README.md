# pi-kimi-video

Native-feeling local video reading for Pi's existing Kimi Coding provider.

No video commands, attachment syntax, asset IDs, or original-video base64 blobs in the session. Mention a local video path naturally and let the model read it.

## Install

```bash
pi install git:github.com/Gucvii/pi-kimi-video@v0.5.0
pi
```

Inside Pi:

1. Run `/login` and choose **Kimi For Coding**.
2. Run `/model` and select `kimi-coding/kimi-for-coding` or `kimi-coding/kimi-for-coding-highspeed`.

This reuses the normal Kimi Coding credential and subscription path. It does not require a separate Moonshot Open Platform account.


## Use

Reference a local path in natural language:

```text
Tell me what this video shows: /Users/me/Downloads/demo.mp4
```

The model calls the package's internal `read_video` tool. The user never needs to know or type the tool name, and existing `read` overrides remain untouched.

Supported formats: MP4, MPEG/MPG, MOV, AVI, FLV, WebM, WMV, 3GP, and 3GPP.

## Behavior

- Registers a conflict-free `read_video` tool only while a supported `kimi-coding` model is selected.
- Injects the Kimi Anthropic-compatible `{ "type": "video", "source": { "type": "url", "url": "ms://<file-id>" } }` block for `kimi-coding`.
- Stores metadata, the `ms://` reference, and an optional small JPEG thumbnail in the Pi session; original video bytes/base64 are never persisted.
- Reuses an upload for the same file hash, provider, and normalized endpoint.
- Preserves video context across session reloads and model switches.
- Gives unsupported models a safe text placeholder; switching back to the original Kimi endpoint restores the native video part.
- Shows an ffmpeg thumbnail and ffprobe metadata when those tools are installed. Both are optional.

## Advanced limits

```bash
export PI_KIMI_VIDEO_MAX_BYTES=$((512 * 1024 * 1024))
export PI_KIMI_VIDEO_TIMEOUT_MS=$((15 * 60 * 1000))
```

These controls are optional. Defaults are 512 MiB and 15 minutes.

## Scope

Supported models:

- `kimi-coding/kimi-for-coding`
- `kimi-coding/kimi-for-coding-highspeed`
- `kimi-coding/k3`


Not supported:

- Generic third-party Kimi-compatible providers
- OpenAI Responses API
- Google APIs
- Audio attachments
- Multiple videos in one message
- Inline MP4 playback in a terminal

## Development

```bash
npm install
npm test
npm run check
```

CI covers Node.js 22 and 26.

## Security

- Local paths are resolved before upload.
- File size and format are validated.
- Upload streams from disk rather than buffering the whole video.
- Uploads are scoped to the selected provider and exact normalized base URL.
- Terminal control characters from file names and API errors are stripped before display.

License: MIT
