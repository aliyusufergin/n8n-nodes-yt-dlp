# Source delivery

The exact source inputs for the real components in this package are immutable, versioned release
assets. Their SHA-256 values are also recorded in `TOOLCHAIN.lock.json`.

| Component | Exact source bundle | SHA-256 |
| --- | --- | --- |
| yt-dlp `2026.07.14.233956` | <https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.07.14.233956/yt-dlp.tar.gz> | `07e2aec9b176ce346d5dd96aa4ade127add1ee88a297129e5bad854be2170dab` |
| Deno `v2.9.3` | <https://github.com/denoland/deno/releases/download/v2.9.3/deno_src.tar.gz> | `58da10e48968a80a6c205b31584d1f1f4583226e59ebb08cb3783b12e7f22d4d` |
| yt-dlp-ejs `0.8.0` | <https://github.com/yt-dlp/ejs/releases/download/0.8.0/yt_dlp_ejs-0.8.0.tar.gz> | `d5fa1639f63b5c4af8d932495f60689d5370f1a095782c944f7f62a303eb104e` |

`bin/ffmpeg` and `bin/ffprobe` are short project-owned synthetic placeholders whose source is the
packaged file itself. They are not distributed GPL FFmpeg binaries. Real FFmpeg/FFprobe packaging
requires the separately gated complete Corresponding Source Bundle before publication.
