# yt-dlp 2026.06.09 v1 argument surface

Accessed: 2026-07-17

## Version anchor

- yt-dlp tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/tree/2026.06.09).

## Findings

1. **Kanıtlanmış platform gerçeği:** yt-dlp 2026.06.09 exposes format selection through `--format`, `--format-sort`, `--format-sort-force`, and `--merge-output-format`. The documented merge containers are avi, flv, mkv, mov, mp4, and webm. Source: [video format options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#video-format-options).

2. **Kanıtlanmış platform gerçeği:** `--playlist-items` accepts comma-separated indices and range/slice syntax; `--yes-playlist` and `--no-playlist` resolve URLs that refer to both a video and a playlist. Source: [video selection options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#video-selection).

3. **Kanıtlanmış platform gerçeği:** Subtitle options can write manual or automatic subtitles, select languages with regexes, prefer formats, and request subtitle conversion. Thumbnail options can write one or all thumbnails. Sources: [subtitle options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#subtitle-options) and [thumbnail options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#thumbnail-options).

4. **Kanıtlanmış platform gerçeği:** yt-dlp's post-processing options include audio extraction, audio format/quality conversion, remuxing, recoding, subtitle/thumbnail/metadata/chapter embedding, and much broader capabilities such as raw FFmpeg arguments, command execution, custom postprocessors, chapter manipulation, and SponsorBlock. Source: [post-processing options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#post-processing-options).

5. **Ürün kararı:** The exact v1 allowlist is the canonical option set recorded in ADR 0017. Only canonical long names and the explicitly named short aliases are accepted. Unknown options are not forwarded.

6. **Ürün kararı:** Repeated options are rejected rather than inheriting yt-dlp's option-specific repeat semantics. Conflicting booleans and missing dependencies are rejected before spawn. Formats, containers, quality values, playlist syntax, language/format expressions, and mini-language lengths receive option-specific validation.

7. **Lisans/güvenlik riski:** Options that delegate arbitrary arguments or commands, change executable/runtime/config/plugin discovery, select local paths, emit to stdout, alter network/auth behavior, enable self-update, or weaken bounded resource/error behavior are outside v1 even when upstream documents them.

8. **E2E ile doğrulanacak varsayım:** The allowlist must be generated or checked against the pinned yt-dlp help output so an upstream rename or semantic change fails release tests. Every accepted option needs positive, invalid-value, dependency/conflict, artifact, timeout, and cleanup coverage in the exact image.

9. **Cevapsız soru:** Artifact-count policy has not yet been selected. `--playlist-items`, subtitle language regexes, and thumbnail/media post-processing must additionally satisfy that later limit before the allowlist can be considered complete.
