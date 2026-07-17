# npm license and Corresponding Source surface

Accessed: 2026-07-17

This note records technical and licensing evidence, not legal advice.

## Version anchors

- yt-dlp source tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/tree/2026.06.09); final binary will be a separately locked immutable nightly snapshot.
- Deno candidate tag: [`v2.9.3`](https://github.com/denoland/deno/tree/v2.9.3); the exact bundled version remains release-gated.
- yt-dlp FFmpeg-Builds candidate commit: [`832dd2f333d919790f117b054f628756c515adce`](https://github.com/yt-dlp/FFmpeg-Builds/tree/832dd2f333d919790f117b054f628756c515adce).
- FFmpeg candidate source commit embedded by the inspected asset: `a09be9b91e`.
- npm and GNU web documentation is unversioned current content, accessed 2026-07-17.

## Findings

1. **Kanıtlanmış platform gerçeği:** The yt-dlp 2026.06.09 source license is the Unlicense. The Deno v2.9.3 source license is MIT. Sources: [`yt-dlp/LICENSE`](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/LICENSE) and [`deno/LICENSE.md`](https://github.com/denoland/deno/blob/v2.9.3/LICENSE.md).

2. **Kanıtlanmış platform gerçeği:** The FFmpeg-Builds scripts are MIT-licensed, but the selected `gpl` variant configures FFmpeg with `--enable-gpl --enable-version3` and designates FFmpeg's `COPYING.GPLv3` as the output license. Sources: [`FFmpeg-Builds/LICENSE`](https://github.com/yt-dlp/FFmpeg-Builds/blob/832dd2f333d919790f117b054f628756c515adce/LICENSE) and [`variants/defaults-gpl.sh`](https://github.com/yt-dlp/FFmpeg-Builds/blob/832dd2f333d919790f117b054f628756c515adce/variants/defaults-gpl.sh).

3. **Lisans/güvenlik riski:** FFmpeg states that enabling GPL parts makes the complete FFmpeg build GPL and that distributors must audit all configured external libraries, retain notices, and provide exact corresponding source and build configuration. Source: [FFmpeg legal considerations](https://ffmpeg.org/legal.html), accessed 2026-07-17.

4. **Kanıtlanmış platform gerçeği:** GPLv3 section 6(d), as explained by the GNU GPL FAQ, permits Corresponding Source on a different server if clear directions accompany the object code, copying facilities are equivalent, and the exact source remains available for as long as the object code is distributed. The source must be complete, not merely upstream links or diffs. Source: [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#SourceAndBinaryOnDifferentSites), accessed 2026-07-17.

5. **Kanıtlanmış platform gerçeği:** The GNU FAQ treats simple fork/exec without intimate complex-data communication as evidence of separate programs, while stating that the combined-versus-separate boundary is ultimately a legal question. The node invokes standalone yt-dlp/FFmpeg/Deno processes with argv, files, stdin, and bounded text streams; it does not link their code into the JavaScript package. Source: [GNU GPL FAQ, plugins](https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins), accessed 2026-07-17.

6. **Kanıtlanmış platform gerçeği:** npm permits a normal SPDX identifier for a uniformly licensed package and `SEE LICENSE IN <filename>` when one top-level file must explain a custom or multi-component licensing situation. Source: [npm `package.json` license field](https://docs.npmjs.com/files/package.json/#license), accessed 2026-07-17.

7. **Ürün kararı:** ADR 0024 licenses original JavaScript/TypeScript, build orchestration, tests, and documentation under MIT. Set the main and selector packages' `license` metadata to `MIT`. Treat the executables as separately licensed aggregated works rather than claiming that the whole distribution is MIT or that the wrapper is necessarily GPL.

8. **Ürün kararı:** Set the Platform Package metadata to `SEE LICENSE IN LICENSES.md`. Its published tarball must include top-level `LICENSES.md`, `THIRD_PARTY_NOTICES.md`, `CORRESPONDING_SOURCE.md`, and `TOOLCHAIN.lock.json`, plus verbatim component license/notice files under `LICENSES/`. The MIT license for package glue, yt-dlp Unlicense, Deno MIT license, FFmpeg GPLv3 license, FFmpeg-Builds MIT license, and every statically linked library's required notice must be mapped to exact files/components.

9. **Ürün kararı:** Publish the exact Corresponding Source Bundle and its SHA-256 in the same versioned GitHub Release before publishing the Platform Package. `CORRESPONDING_SOURCE.md`, the platform README shown by npm, and `TOOLCHAIN.lock.json` must contain a direct immutable release-asset URL, digest, component/build identity, and extraction/rebuild instructions. Do not rely on an upstream URL or a source-on-request offer.

10. **Ürün kararı:** Keep the source asset available without an expiration for as long as any npm version containing the binary remains downloadable, including deprecated versions. A release or repository move must preserve or replace equivalent direct access before the old URL disappears.

11. **Ürün kararı:** The Corresponding Source Bundle must contain exact FFmpeg and statically linked dependency source trees, patches, generated/configuration inputs needed to rebuild, FFmpeg-Builds scripts at the locked commit, variant scripts, Dockerfile/container definition, compiler/build-tool manifest, and installation instructions. It must not contain only commit IDs or download scripts that depend on mutable upstream state.

12. **Ürün kararı:** Publication is blocked unless automation unpacks the final platform tarball, validates every binary and notice against the Toolchain Lock, compares `ffmpeg -buildconf` to the source manifest, verifies the source asset URL/digest, and maps every enabled external library to source and license. A clean isolated rebuild from the bundle and a manual license audit are required for each Toolchain Lock change; byte-identical output is not claimed.

13. **Lisans/güvenlik riski:** Different-server delivery through npm and GitHub appears compatible with the cited GPLv3 guidance only if access remains clear and equivalent. npm/GitHub availability, the aggregate/separate-work conclusion, component license compatibility, and Corresponding Source completeness remain legal/compliance judgments, not facts proven by tests.

14. **Cevapsız soru:** No final Toolchain Lock, external-library inventory, source archive, clean rebuild, or manual license review exists yet. Platform Package publication remains blocked until all are complete; if the review cannot support the MIT-wrapper/separate-work conclusion, the package license design must be revisited before publication.
