# Third-party notices

This package combines the components pinned in `toolchain-manifest.json`.

- **yt-dlp musllinux executable**: yt-dlp is dedicated to the public domain, while its bundled executable contains third-party components under additional licenses and is distributed here under GPL-3.0-or-later. Its upstream executable embeds `THIRD_PARTY_LICENSES.txt`.
- **FFmpeg and FFprobe**: the selected wader/static-ffmpeg build is distributed under GPL-3.0-or-later. The complete GPL text is in `LICENSE`.
- **Node.js**: Node.js is MIT-licensed and includes third-party components. The exact archive's combined notices are copied to `vendor/licenses/node-LICENSE` during release preparation.
- **yt-dlp EJS**: the pinned solver asset is dedicated to the public domain. Its notice is copied to `vendor/licenses/ejs-LICENSE` during release preparation.

Exact versions, digests, and corresponding-source locations are recorded in `toolchain-manifest.json` and `SOURCE_OFFER.md`.
