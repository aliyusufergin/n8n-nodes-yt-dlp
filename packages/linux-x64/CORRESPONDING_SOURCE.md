# Source delivery

The exact source inputs for the real components in this package are immutable, versioned release
assets. Their SHA-256 values are also recorded in `TOOLCHAIN.lock.json`.

| Component                                                          | Exact source bundle                                                                                                      | SHA-256                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| yt-dlp `2026.07.14.233956`                                         | <https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.07.14.233956/yt-dlp.tar.gz>                      | `07e2aec9b176ce346d5dd96aa4ade127add1ee88a297129e5bad854be2170dab` |
| Deno `v2.9.3`                                                      | <https://github.com/denoland/deno/releases/download/v2.9.3/deno_src.tar.gz>                                              | `58da10e48968a80a6c205b31584d1f1f4583226e59ebb08cb3783b12e7f22d4d` |
| yt-dlp-ejs `0.8.0`                                                 | <https://github.com/yt-dlp/ejs/releases/download/0.8.0/yt_dlp_ejs-0.8.0.tar.gz>                                          | `d5fa1639f63b5c4af8d932495f60689d5370f1a095782c944f7f62a303eb104e` |
| FFmpeg `N-125551-ga09be9b91e-20260712` and all static dependencies | <https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz> | `6576eef8e990c7da69b18d37f17f318ebc832365c50fd62a8a473240a6e62d54` |

The FFmpeg bundle is self-contained: it includes the exact FFmpeg and FFmpeg-Builds snapshots, all
109 static dependency source archives, build/install inputs, the digest-pinned dependency
Dockerfile, complete linker inventory, expected configuration evidence, and a network-isolated
rebuild script. After extraction, follow `toolchain/README.md` and run `toolchain/rebuild.sh`.

The versioned source bundle must be uploaded and its SHA-256 verified before this platform package
is published. Upstream repositories, mutable branches, downloader scripts, or source-on-request are
not substitutes for that release asset; the package's automated prepack gate rejects an unfrozen or
incomplete source identity.
