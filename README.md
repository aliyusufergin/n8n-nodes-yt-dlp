# n8n-nodes-yt-dlp

Self-hosted n8n community node that runs a packaged [yt-dlp](https://github.com/yt-dlp/yt-dlp) toolchain without requiring a custom n8n image.

The node accepts the arguments that normally follow `yt-dlp`. It invokes a pinned executable directly—never through a shell—and returns two outputs:

1. `Result`: exit status, bounded/redacted stdout and stderr, duration, and toolchain versions.
2. `Artifacts`: every finalized regular output file as n8n binary property `data`.

## Status

The repository currently contains the `0.1.0` implementation and release preparation tooling. The npm packages have not yet been published. The prepared packages pass the official n8n 2.31.1 Docker E2E locally on native x64 and emulated arm64; hosted native-architecture CI and the tagged source-bundle workflow must still pass before a real release.

## Compatibility

- Self-hosted n8n 2.x, starting at 2.0.0.
- Official n8n Docker image, single-instance mode.
- Linux x64 and Linux arm64 with musl.
- Unverified community-node installation only.

n8n Cloud, queue mode, native/bare-metal installs, other container bases, Windows, macOS, and AI-tool use are not supported in v1.

## Intended installation

After publication, install only the main package in **Settings → Community Nodes**:

```text
n8n-nodes-yt-dlp
```

npm selects the exact-version x64 or arm64 toolchain optional dependency. No install or runtime script downloads an executable.

## Usage

Enter only the part after the executable:

```text
--format "bv*+ba/b" --output "downloads/%(title)s.%(ext)s" https://example.com/video
```

Do not include `yt-dlp`. The field supports a POSIX-like quoting subset but is not a shell: pipes, redirects, substitutions, environment expansion, globbing, and command chaining are rejected.

The versioned option catalog is deny-by-default and covers the pinned yt-dlp version's aliases and actual value arity. Unknown options and capabilities that escape the node boundary—such as `--exec`, external downloaders, plugins, config files, arbitrary paths, self-update, browser cookie stores, local files, and raw page dumps—are rejected before spawn. Fixed preset expansions are recursively validated, and compat options use a versioned value allowlist.

## yt-dlp Secrets credential

Use the optional `yt-dlp Secrets` credential for:

- Netscape cookie-file content.
- Sensitive yt-dlp options such as username, password, proxy, or headers.

Sensitive options cannot contain positional inputs. Credential values are redacted from captured text on a best-effort basis, but downloaded artifacts are not scanned or modified.

## Security and capacity

This node intentionally starts an OS process and is for trusted workflow authors only. It is not eligible for n8n Cloud verification. Operators should enforce outbound network policy and are responsible for temporary disk, n8n binary storage, workflow concurrency, playlist size, and execution time.

Each invocation has an isolated mode-0700 workspace. stdin is closed, the child environment is allowlisted, output is bounded to the first and last 512 KiB per stream, timeout/cancellation terminates the Linux process group, artifacts are transferred before cleanup, and partial/symlink/special files are excluded. An owner marker lets a bounded later run reclaim only conclusively abandoned workspaces.

## Development

The npm workspace contains mutually incompatible `os/cpu/libc` packages, so repository bootstrap requires:

```bash
npm install --force
npm run verify
```

Prepare a platform toolchain only for release/integration work:

```bash
npm run prepare-toolchain --workspace n8n-nodes-yt-dlp-linux-x64
```

The preparation script downloads immutable manifest URLs and copies FFmpeg/FFprobe from a digest-pinned multi-architecture OCI image. It verifies individual SHA-256 digests, verifies yt-dlp against its GPG-signed checksum list and pinned signing-key fingerprint, and copies the checked-in option catalog and license material. Docker is required only for release preparation. `vendor/` is ignored by Git, and preparation never runs during installation or node execution.

The platform CI jobs also compare the catalog with the pinned executable before packing. The final matrix installs the tarballs into clean official n8n 2.x images and exercises a local split-stream DASH download plus FFmpeg merge on x64 and arm64.

Build and independently verify the release-specific Corresponding Source Bundle with:

```bash
npm run source:plan
npm run source:bundle
node toolchain/verify-corresponding-source.mjs \
  dist/n8n-nodes-ytdlp-0.1.0-sources.tar.gz 0.1.0
```

The full build downloads and verifies all pinned Wader archives and git revisions, selected Alpine APKBUILD sources and distfiles, hidden Meson/libjxl inputs, locked Cargo dependencies, top-level tool sources, build recipes, and license material. It requires Git, curl, GNU tar/gzip, and Docker with amd64 and arm64 support. `.source-cache/` makes retries resumable; generated work and release archives are ignored by Git. The tagged workflow rebuilds and verifies the archive before attaching it at the immutable URL recorded by each platform package.

The bundle provides complete source material but does not claim bit-for-bit reproducibility. Historical Alpine APK bytes are no longer all mirrored, and GLib's original mutable libffi Meson branch can only be pinned from build-time chronology; both limits are recorded in the bundle's `PROVENANCE.md`.

## Design and licensing

The implementation contract is in [`docs/specification.md`](docs/specification.md); design rationale is in [`docs/adr`](docs/adr).

- `n8n-nodes-yt-dlp`: MIT.
- Architecture toolchain packages: GPL-3.0-or-later, with full license, component notices, manifest, and Corresponding Source direction in each package.
