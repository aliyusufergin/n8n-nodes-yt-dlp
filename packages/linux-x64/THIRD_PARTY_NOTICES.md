# Third-party notices

- yt-dlp nightly `2026.07.14.233956` was generated from source commit
  `aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8`. Its complete bundled notices are preserved in
  `LICENSES/yt-dlp-THIRD_PARTY_LICENSES.txt`.
- Deno `v2.9.3` was built from source commit
  `f39575ecd50602a5b42b1ba8e93849460de9fcf4`; its MIT license is preserved in
  `LICENSES/deno-MIT.txt`.
- yt-dlp-ejs `0.8.0` was built from source commit
  `4fb477f4af56880cfd324c48bd4294a2d2294e50`. Its self-contained library preserves the verbatim
  ISC notice for meriyah `6.1.4` and MIT notice for astring `1.9.0` in its generated header.
- FFmpeg/FFprobe `N-125551-ga09be9b91e-20260712` came from the dated FFmpeg-Builds release
  `autobuild-2026-07-12-15-07`, build-scripts commit
  `832dd2f333d919790f117b054f628756c515adce`, and FFmpeg commit
  `a09be9b91e8e1219f297586873b0d7322b47df96`. The build enables GPLv3-compatible features and
  statically links the 109 source components inventoried in `FFMPEG-SOURCE-MANIFEST.json`.
- The Linux runtime launcher is built from the project source at
  `toolchain/linux-x64/runtime-launcher.c` in the pinned
  `gcc@sha256:3e239a5ea77200b9163c825a0a5ebc17ca99f3bbb4d08241ee0fb9c174325880`
  image. It is distributed with the applicable GNU C Library and GCC Runtime Library notices.
- The package-relative compatibility runtime comes from the pinned Ubuntu Jammy image
  `ubuntu@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982`:
  glibc `2.35-0ubuntu3.13`, `libgcc-s1` `12.3.0-1ubuntu1~22.04.3`, and zlib
  `1:1.2.11.dfsg-2ubuntu9.2`. Their distribution copyright files are preserved under
  `LICENSES/runtime/`.
- The yt-dlp musllinux loader and zlib runtime come from the pinned n8n 2.27.4 image:
  musl `1.2.5-r12` and zlib `1.3.2-r0`. The musl copyright and zlib license material are
  preserved under `LICENSES/runtime/`.

Exact distributed-asset and source-bundle SHA-256 values are recorded in `TOOLCHAIN.lock.json`.
