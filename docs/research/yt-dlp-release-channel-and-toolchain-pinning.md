# yt-dlp release channel and toolchain pinning

Accessed: 2026-07-17

## Version anchors

- yt-dlp stable tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09).
- Inspected yt-dlp nightly tag: [`2026.07.14.233956`](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/2026.07.14.233956).
- Inspected Deno tag: [`v2.9.3`](https://github.com/denoland/deno/releases/tag/v2.9.3).

## Findings

1. **Kanıtlanmış platform gerçeği:** yt-dlp defines stable, nightly, and master binary channels. Its 2026.06.09 documentation says stable is mostly monthly and often stale because sites change, while nightly is the recommended channel for regular users. Binary self-update remains within the current channel unless `--update-to` selects another channel or tag. Source: [yt-dlp 2026.06.09 update channels](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#update-channels).

2. **Kanıtlanmış platform gerçeği:** The stable 2026.06.09 release is marked immutable by GitHub and provides SHA-256/SHA-512 manifests with GPG signatures. Its musllinux x64 executable has GitHub asset digest `sha256:74b20e9e0d8948cccd81004cb64576293cd41b8f4e7f5b6bdc4a253c3bb9b79a`. Source: [`2026.06.09` release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09).

3. **Kanıtlanmış platform gerçeği:** The inspected nightly `2026.07.14.233956` release is marked immutable and provides a signed SHA-256 manifest. Its musllinux x64 executable has GitHub asset digest `sha256:8f5d14830ffcfc2a45de3c13b0e5158bc228d8d00bc58df2196d0d14e01d7023`. This is evidence for the mechanism, not the final release pin. Source: [`2026.07.14.233956` release](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/2026.07.14.233956).

4. **Kanıtlanmış platform gerçeği:** yt-dlp documents a GPG public key and verification commands for its signed checksum manifests. The release process must pin the reviewed key material rather than fetch mutable `master` during verification. Source: [yt-dlp 2026.06.09 release files](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#release-files).

5. **Kanıtlanmış platform gerçeği:** Deno v2.9.3 is marked immutable and publishes per-asset checksums plus `deno_src.tar.gz`. The x64 GNU Linux zip has GitHub asset digest `sha256:8101865641cbede56f08ad19c0a67a87df84bce127fee0d3e3e1f7467717ffa6`. Source: [`v2.9.3` release](https://github.com/denoland/deno/releases/tag/v2.9.3).

6. **Ürün kararı:** A release candidate selects one exact yt-dlp nightly snapshot and records every executable and companion asset in the Toolchain Lock. No executable may update itself or download a replacement/component at runtime. Any Toolchain Lock change requires a new exact lockstep version of all three npm packages.

7. **Lisans/güvenlik riski:** Nightly can regress despite being upstream's recommended channel. Signature and digest verification prove provenance/integrity, not suitability. Exact-image, extractor, post-processing, license, Community Packages, and queue-mode acceptance tests remain mandatory.

8. **Ürün kararı:** There is no automatic update cadence. Site breakage, a security fix, or planned maintenance may create a release candidate. A bad npm release is deprecated rather than overwritten, and a dist-tag may return to a previously verified exact version.
