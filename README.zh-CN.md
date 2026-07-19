# pi-kimi-video

[English](README.md) · [最新版本：v0.6.1](https://github.com/Gucvii/pi-kimi-video/releases/tag/v0.6.1)

## 效果

模型会自动调用 `read_video`，上传视频，并通过 Pi 原生图片结果显示首帧缩略图：

![read_video 工具调用与原生缩略图](docs/read-video-tool.png)

工具会返回 Kimi 对视频的真实分析，而不是根据文件名猜测：

![Kimi 视频分析结果](docs/video-analysis-result.png)

## 安装

```bash
pi install git:github.com/Gucvii/pi-kimi-video@v0.6.1
pi
```

进入 Pi 后：

1. 执行 `/login`，选择 **Kimi For Coding**。
2. 执行 `/model`，选择 `kimi-coding/kimi-for-coding` 或 `kimi-coding/kimi-for-coding-highspeed`。

## 使用

直接描述需求并附上本地路径：

```text
用中文说明这个视频里发生了什么：/Users/me/Downloads/demo.mp4
```

如果一条消息里有多个视频，模型可以逐个调用 `read_video`。扩展不会扫描、改写或拦截用户输入；在不支持的模型下，视频路径仍然只是普通文本。

## 工作方式

- 仅在支持的 `kimi-coding` 模型下启用独立的 `read_video` 工具。
- 使用现有 Kimi Coding 凭据上传到 Kimi Files。
- 通过官方 OpenAI 兼容端点的 `video_url` 格式分析 `ms://<file-id>`。
- 将分析文本作为普通工具结果返回，因此切换模型或恢复会话后仍可保留。
- 相同文件会按哈希、provider 和端点复用上传结果。
- 可选使用 ffmpeg 提取首帧，并交给 Pi 原生图片渲染链路显示。
- 可选使用 ffprobe 显示时长与分辨率。
- 会话不会保存原始视频字节或视频 base64。

## 支持范围

支持模型：

- `kimi-coding/kimi-for-coding`
- `kimi-coding/kimi-for-coding-highspeed`
- `kimi-coding/k3`

支持格式：MP4、MPEG/MPG、MOV、AVI、FLV、WebM、WMV、3GP、3GPP。

当前仅支持本地文件，不支持网络视频 URL。默认最大文件大小为 512 MiB，操作超时为 15 分钟，可通过以下可选环境变量调整：

```bash
export PI_KIMI_VIDEO_MAX_BYTES=$((512 * 1024 * 1024))
export PI_KIMI_VIDEO_TIMEOUT_MS=$((15 * 60 * 1000))
```

## 安全说明

- 上传前检查文件格式、大小和本地文件类型。
- 视频从磁盘流式上传，不会整体读入内存。
- 上传资源只在相同 provider 与规范化端点下复用。
- 文件名和 API 错误中的终端控制字符会在显示前清理。

许可证：[MIT](LICENSE)
