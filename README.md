# pi-kimi-video

Native-feeling local video attachments for Pi's existing Kimi Coding provider.

No video commands, asset IDs, or original-video base64 blobs in the session. Drop or reference a local video in the normal editor, add your question, and send.

## Install

```bash
pi install git:github.com/Gucvii/pi-kimi-video@v0.4.1
pi
```

Inside Pi:

1. Run `/login` and choose **Kimi For Coding**.
2. Run `/model` and select `kimi-coding/kimi-for-coding` or `kimi-coding/kimi-for-coding-highspeed`.

This reuses the normal Kimi Coding credential and subscription path. It does not require a separate Moonshot Open Platform account.


## Use

There are two native paths:

```text
@./demo.mp4 Explain what changes over time.
```

An explicit `@` attachment or dropped path is uploaded before the turn. A normal natural-language reference also works:

```text
Tell me what this video shows: /Users/me/Downloads/demo.mp4
```

For a normal path reference, the model calls the package's internal `read_video` tool. The user never needs to know or type the tool name, and existing `read` overrides remain untouched.

One video is accepted per message. Supported formats: MP4, MPEG/MPG, MOV, AVI, FLV, WebM, WMV, 3GP, and 3GPP.

### Clipboard boundary

Pi currently exposes image bytes and plain text through its clipboard action, not raw video-file bytes. Therefore this extension can handle a path inserted by drag/drop, `@` reference, terminal paste, or a clipboard `file://` URL, but it cannot read an opaque video blob directly from the OS clipboard without a new Pi attachment hook.

## Behavior

- Registers a conflict-free `read_video` tool that turns local video paths into native Kimi video tool results.
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
