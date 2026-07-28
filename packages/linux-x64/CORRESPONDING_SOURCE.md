# Source inputs and delivery gates

The exact upstream and distribution source inputs identified for the real components in this
package are listed below. Their SHA-256 values are also recorded in `TOOLCHAIN.lock.json`.

| Component                                                          | Exact source bundle                                                                                                      | SHA-256                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| yt-dlp `2026.07.14.233956`                                         | <https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.07.14.233956/yt-dlp.tar.gz>                      | `07e2aec9b176ce346d5dd96aa4ade127add1ee88a297129e5bad854be2170dab` |
| Deno `v2.9.3`                                                      | <https://github.com/denoland/deno/releases/download/v2.9.3/deno_src.tar.gz>                                              | `58da10e48968a80a6c205b31584d1f1f4583226e59ebb08cb3783b12e7f22d4d` |
| yt-dlp-ejs `0.8.0`                                                 | <https://github.com/yt-dlp/ejs/releases/download/0.8.0/yt_dlp_ejs-0.8.0.tar.gz>                                          | `d5fa1639f63b5c4af8d932495f60689d5370f1a095782c944f7f62a303eb104e` |
| FFmpeg `N-125551-ga09be9b91e-20260712` and all static dependencies | <https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz> | `3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882` |
| Runtime glibc `2.35-0ubuntu3.13` upstream                           | <https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/glibc/2.35-0ubuntu3.13/glibc_2.35.orig.tar.xz>                | `5123732f6b67ccd319305efd399971d58592122bcc2a6518a1bd2510dd0cf52e` |
| Runtime glibc `2.35-0ubuntu3.13` packaging                          | <https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/glibc/2.35-0ubuntu3.13/glibc_2.35-0ubuntu3.13.debian.tar.xz> | `28173285cf885df068374baf9b513ede397988ea3f93a1377f0268fe257a62f4` |
| Launcher glibc `2.36-9+deb12u14` upstream                           | <https://snapshot.debian.org/archive/debian/20260503T204801Z/pool/main/g/glibc/glibc_2.36.orig.tar.xz>                   | `a543c02070d46ccaf866957efd13f10c924daa74c86a90a0254db09a92a708ee` |
| Launcher glibc `2.36-9+deb12u14` packaging                          | <https://snapshot.debian.org/archive/debian/20260503T204801Z/pool/main/g/glibc/glibc_2.36-9%2Bdeb12u14.debian.tar.xz>  | `cf4ac9cd98185452cae3ef34e2e4ee12753e3d93fd0c62c61396d4a47eec902f` |
| Runtime GCC `12.3.0-1ubuntu1~22.04.3` upstream                      | <https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/gcc-12/12.3.0-1ubuntu1~22.04.3/gcc-12_12.3.0.orig.tar.gz>   | `62b0fc89b6d41f9df2470d0fb4995f6ff5885f910518a2c6a44a6888ea5a9ea1` |
| Runtime GCC `12.3.0-1ubuntu1~22.04.3` packaging                     | <https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/gcc-12/12.3.0-1ubuntu1~22.04.3/gcc-12_12.3.0-1ubuntu1~22.04.3.debian.tar.xz> | `44074c3d5e7d97365f1f7b45291ade2ee40ed6300176530d912e7cc0ceba77ab` |
| Runtime zlib `1:1.2.11.dfsg-2ubuntu9.2` upstream                    | <https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/zlib/1:1.2.11.dfsg-2ubuntu9.2/zlib_1.2.11.dfsg.orig.tar.gz> | `80c481411a4fe8463aeb8270149a0e80bb9eaf7da44132b6e16f2b5af01bc899` |
| Runtime zlib `1:1.2.11.dfsg-2ubuntu9.2` packaging                   | <https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/zlib/1:1.2.11.dfsg-2ubuntu9.2/zlib_1.2.11.dfsg-2ubuntu9.2.debian.tar.xz> | `5678d0b3d1e609297e5a3dedfcb3474bab1cafe82c0c29aec2cef01e49a88d39` |
| musl `1.2.5-r12` upstream                                          | <https://musl.libc.org/releases/musl-1.2.5.tar.gz>                                                                                   | `a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4` |
| musl-side zlib `1.3.2-r0` upstream                                 | <https://zlib.net/fossils/zlib-1.3.2.tar.gz>                                                                                         | `bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16` |

The FFmpeg bundle is self-contained: it includes the exact FFmpeg and FFmpeg-Builds snapshots, all
109 static dependency source archives, including rav1e's locked vendored Cargo graph, build/install
inputs, the digest-pinned dependency Dockerfile, complete linker inventory, expected configuration
evidence, and a network-isolated rebuild script. The rav1e entry records the original upstream
archive identity separately from the reproducible vendored-source augmentation. After extraction,
follow `toolchain/README.md` and run `toolchain/rebuild.sh`.

`toolchain/linux-x64/build-runtime.sh` reproduces the packaged runtime bytes from pinned container
images: it compiles `toolchain/linux-x64/runtime-launcher.c` in the pinned compiler image and copies
only the enumerated runtime libraries from the pinned Ubuntu and n8n images. The image digests,
source/script digests, binary package versions, and identified source archive digests are frozen in
`TOOLCHAIN.lock.json`.

The listed runtime source inputs do not yet constitute ADR 0024's complete Source Delivery Gate.
Platform publication is intentionally blocked until one immutable, versioned runtime Corresponding
Source Bundle includes the exact distribution source trees and patches, generated/configure inputs,
and build/install scripts, and until clean isolated-rebuild evidence and maintainer license-review
approval are bound to that bundle. `TOOLCHAIN.lock.json` records this gate as `pending`; the release
verification command fails closed while it remains pending. The local n8n 2.27.4 acceptance lane
does not claim public-registry or release readiness.

The versioned source bundle must be uploaded and its SHA-256 verified before this platform package
is published. Upstream repositories, mutable branches, downloader scripts, or source-on-request are
not substitutes for that release asset. The package's automated prepack gate reads the GitHub
Release asset digest back and also requires approved maintainer license-review evidence plus a
persisted successful isolated-rebuild record bound to the frozen inputs.
