# pi-kimi-video

Native-feeling local video attachments for direct Kimi K3 models in [Pi](https://github.com/earendil-works/pi).

No video commands, asset IDs, or original-video base64 blobs in the session. Drop or reference a local video in the normal editor, add your question, and send.

## Install

```bash
pi install git:github.com/Gucvii/pi-kimi-video@v0.2.0
pi
```

Inside Pi:

1. Run `/login` and choose **Moonshot AI** or **Moonshot AI CN**.
2. Run `/model` and select `moonshotai/kimi-k3` or `moonshotai-cn/kimi-k3`.

`MOONSHOT_API_KEY` remains a supported Pi credential fallback, but it is not required by this package and is not the primary setup path.

## Use

Use the same editor you already use for prompts:

```text
@./demo.mp4 Explain what changes over time.
```

You can also drag a video file into the terminal or paste a local file path, type the question beside it, and press Enter. Quoted paths, escaped spaces, `@` references, and `file://` URLs are recognized automatically.

The attachment path disappears from the model prompt. Pi shows a video card and thumbnail, uploads the file to the selected Moonshot endpoint, and sends the clean question normally.

One video is accepted per message. Supported formats: MP4, MPEG/MPG, MOV, AVI, FLV, WebM, WMV, 3GP, and 3GPP.

### Clipboard boundary

Pi currently exposes image bytes and plain text through its clipboard action, not raw video-file bytes. Therefore this extension can handle a path inserted by drag/drop, `@` reference, terminal paste, or a clipboard `file://` URL, but it cannot read an opaque video blob directly from the OS clipboard without a new Pi attachment hook.

## Behavior

- Uploads through Moonshot Files API as `purpose=video`.
- Injects `{ "type": "video_url", "video_url": { "url": "ms://<file-id>" } }` only for the matching direct Kimi K3 endpoint.
- Stores metadata, the `ms://` reference, and an optional small JPEG thumbnail in the Pi session; original video bytes/base64 are never persisted.
- Reuses an upload for the same file hash, provider, and normalized endpoint.
- Preserves video context across session reloads and model switches.
- Gives non-Kimi models a safe text placeholder; switching back to the original Kimi endpoint restores the native video part.
- Shows an ffmpeg thumbnail and ffprobe metadata when those tools are installed. Both are optional.

## Advanced limits

```bash
export PI_KIMI_VIDEO_MAX_BYTES=$((512 * 1024 * 1024))
export PI_KIMI_VIDEO_TIMEOUT_MS=$((15 * 60 * 1000))
```

These controls are optional. Defaults are 512 MiB and 15 minutes.

## Scope

Supported:

- `moonshotai/kimi-k3`
- `moonshotai-cn/kimi-k3`
- OpenAI Chat Completions-compatible Kimi payloads

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
