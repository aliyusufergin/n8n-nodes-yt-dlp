# FFmpeg GPL binary distribution

Accessed: 2026-07-17

This note records technical and licensing evidence, not legal advice.

## Version anchors

- yt-dlp tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/tree/2026.06.09).
- yt-dlp FFmpeg-Builds release: [`autobuild-2026-07-12-15-07`](https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-07-12-15-07).
- FFmpeg-Builds commit: [`832dd2f333d919790f117b054f628756c515adce`](https://github.com/yt-dlp/FFmpeg-Builds/tree/832dd2f333d919790f117b054f628756c515adce).
- Inspected Linux x64 asset: `ffmpeg-N-125551-ga09be9b91e-linux64-gpl.tar.xz`, SHA-256 `7a19456683e31d937ae48d51e23dfb869dbb9db1e4d6e1b6881d7fed168fa5cf`.

## Findings

1. **Kanıtlanmış platform gerçeği:** yt-dlp 2026.06.09 highly recommends FFmpeg and FFprobe for format merging and post-processing and points users to the official `yt-dlp/FFmpeg-Builds` project. It says those builds currently have no yt-dlp-specific patches and are equivalent to upstream FFmpeg. Source: [yt-dlp 2026.06.09 dependencies](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#dependencies).

2. **Kanıtlanmış platform gerçeği:** The inspected dated release provides static Linux x64 and arm64 GPL assets. The Linux x64 asset identifies FFmpeg source commit `a09be9b91e`; its release asset digest is recorded above. Source: [`autobuild-2026-07-12-15-07`](https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-07-12-15-07).

3. **Kanıtlanmış platform gerçeği:** The selected build variant sets `--enable-gpl --enable-version3`, uses FFmpeg's `master` branch, and names `COPYING.GPLv3` as its license file. Sources: [`linux64-gpl.sh`](https://github.com/yt-dlp/FFmpeg-Builds/blob/832dd2f333d919790f117b054f628756c515adce/variants/linux64-gpl.sh) and [`defaults-gpl.sh`](https://github.com/yt-dlp/FFmpeg-Builds/blob/832dd2f333d919790f117b054f628756c515adce/variants/defaults-gpl.sh), commit `832dd2f3`.

4. **Lisans/güvenlik riski:** FFmpeg is LGPL 2.1-or-later by default, but enabling GPL components applies the GPL to the complete FFmpeg build. FFmpeg's compliance guidance calls for exact corresponding source, changes, build configuration, and review of every external library compiled into FFmpeg. Source: [FFmpeg legal considerations](https://ffmpeg.org/legal.html).

5. **Lisans/güvenlik riski:** Redistributing an unchanged downloaded GPL binary still requires complete corresponding source. GNU's FAQ says the source must correspond to the binary, be as easy to access as the object code, and remain available while the object code is distributed; upstream availability alone is insufficient. Source: [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#UnchangedJustBinary).

6. **Ürün kararı:** v1 uses a dated, digest-pinned official yt-dlp Linux x64 GPL static build and includes only FFmpeg and FFprobe executables plus required notices in the Platform Package. A custom minimal/LGPL build and FFplay are outside v1 scope.

7. **E2E ile doğrulanacak varsayım:** The inspected asset is a candidate, not the final release pin. Its executables must run inside the exact supported n8n image and pass required merge, remux, audio extraction, subtitle, metadata, and probe scenarios before selection.

8. **Cevapsız soru:** No complete Corresponding Source Bundle for the candidate binary has yet been assembled or audited. Release tooling must enumerate every statically linked component and archive the exact sources, patches, configuration, and build scripts. Platform-package publication remains blocked until automated manifest checks and a manual license review prove that bundle complete.
