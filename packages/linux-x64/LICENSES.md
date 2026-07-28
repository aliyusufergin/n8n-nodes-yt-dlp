# Component licenses

This package contains components under different licenses. Its package metadata therefore uses
`SEE LICENSE IN LICENSES.md` rather than describing the whole tarball as MIT.

| Packaged path                                      | Component                                                              | License material                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/yt-dlp.musl`                                  | yt-dlp musllinux `2026.07.14.233956`                                   | `LICENSES/yt-dlp-Unlicense.txt`, `LICENSES/yt-dlp-THIRD_PARTY_LICENSES.txt`                                                                 |
| `bin/deno.gnu`                                     | Deno `v2.9.3`                                                          | `LICENSES/deno-MIT.txt`                                                                                                                     |
| `assets/ejs/yt.solver.core.js`                     | yt-dlp-ejs `0.8.0`                                                     | `LICENSES/ejs-Unlicense.txt`                                                                                                                |
| `assets/ejs/yt.solver.lib.js`                      | yt-dlp-ejs `0.8.0`, meriyah `6.1.4`, astring `1.9.0`                   | `LICENSES/ejs-Unlicense.txt` and the verbatim ISC/MIT notices embedded at the start of the asset                                            |
| `bin/ffmpeg.gnu`, `bin/ffprobe.gnu`                | FFmpeg `N-125551-ga09be9b91e-20260712`, statically linked dependencies | `LICENSES/FFmpeg-GPLv3.txt`, `LICENSES/FFmpeg-Builds-MIT.txt`, and the component-indexed verbatim materials under `LICENSES/ffmpeg-static/` |
| `bin/yt-dlp`, `bin/deno`, `bin/ffmpeg`, `bin/ffprobe` | Project runtime launcher with statically linked GNU C Library       | `LICENSES/runtime/launcher-libc6-copyright`, `LICENSES/runtime/launcher-libgcc-s1-copyright`                                                 |
| `runtime/musl/`                                    | musl `1.2.5-r12` and zlib `1.3.2-r0`                                  | `LICENSES/runtime/musl-COPYRIGHT`, `LICENSES/runtime/zlib1g-copyright`                                                                      |
| `runtime/glibc/`                                   | Ubuntu Jammy glibc, GCC runtime, and zlib compatibility runtime        | `LICENSES/runtime/libc6-copyright`, `LICENSES/runtime/libgcc-s1-copyright`, `LICENSES/runtime/zlib1g-copyright`                              |
| GCC runtime portions in FFmpeg and runtime launcher | GCC runtime libraries                                                  | `LICENSES/FFmpeg-GPLv3.txt`, `LICENSES/GCC-Runtime-Library-Exception-3.1.txt`, and the runtime copyright files above                         |

`FFMPEG-SOURCE-MANIFEST.json` maps each of the 109 exact static dependency source archives to its
packaged license, notice, or license-header material. Its rav1e entry additionally maps every
vendored Cargo package's name, version, SPDX expression, source path, exact packaged `Cargo.toml`
license declaration, and any crate-local verbatim license files. A crate without a bundled license
text is not mapped to another crate's copyright notice.
The source-bundle identity and complete corresponding-source instructions are in
`CORRESPONDING_SOURCE.md` and `TOOLCHAIN.lock.json`.

The exact pinned builder/runtime image digests, package versions, launcher source digest, and
corresponding-source archive digests for the packaged compatibility runtime are recorded in
`TOOLCHAIN.lock.json`. The launcher uses only package-relative paths and replaces itself with the
packaged GNU loader; it does not discover or fall back to host libraries.
