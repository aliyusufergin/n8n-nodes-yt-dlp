# Component licenses

This package contains components under different licenses. Its package metadata therefore uses
`SEE LICENSE IN LICENSES.md` rather than describing the whole tarball as MIT.

| Packaged path                  | Component                                                              | License material                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/yt-dlp`                   | yt-dlp `2026.07.14.233956`                                             | `LICENSES/yt-dlp-Unlicense.txt`, `LICENSES/yt-dlp-THIRD_PARTY_LICENSES.txt`                                                                 |
| `bin/deno`                     | Deno `v2.9.3`                                                          | `LICENSES/deno-MIT.txt`                                                                                                                     |
| `assets/ejs/yt.solver.core.js` | yt-dlp-ejs `0.8.0`                                                     | `LICENSES/ejs-Unlicense.txt`                                                                                                                |
| `assets/ejs/yt.solver.lib.js`  | yt-dlp-ejs `0.8.0`, meriyah `6.1.4`, astring `1.9.0`                   | `LICENSES/ejs-Unlicense.txt` and the verbatim ISC/MIT notices embedded at the start of the asset                                            |
| `bin/ffmpeg`, `bin/ffprobe`    | FFmpeg `N-125551-ga09be9b91e-20260712`, statically linked dependencies | `LICENSES/FFmpeg-GPLv3.txt`, `LICENSES/FFmpeg-Builds-MIT.txt`, and the component-indexed verbatim materials under `LICENSES/ffmpeg-static/` |

`FFMPEG-SOURCE-MANIFEST.json` maps each of the 109 exact static dependency source archives to its
packaged license, notice, or license-header material. The source-bundle identity and complete
corresponding-source instructions are in `CORRESPONDING_SOURCE.md` and `TOOLCHAIN.lock.json`.
