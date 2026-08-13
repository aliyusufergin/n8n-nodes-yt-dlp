# Runtime toolchain attestation

Accessed: 2026-07-17

## Runtime anchors

- n8n 2.0.0 official image: Node.js 22.21.0
- n8n 2.27.4 and 2.30.7 (previous frozen head) official images: Node.js 24.16.0
- n8n 2.34.5 (frozen head since 2026-08-13) official image: Node.js 24.18.0
- Existing product decisions: ADR 0013 Toolchain Lock, ADR 0020 process lifecycle, ADR 0028 Platform Gate

Re-verified on 2026-08-13 after the head advance. The new head moves the image
runtime one patch level, from Node.js 24.16.0 to 24.18.0; its base is still
Alpine 3.24 and the container still runs as `uid=1000(node)`. Source: [`2.34.5
n8n-base Dockerfile`](https://github.com/n8n-io/n8n/blob/f745babb4b5a72bdecf454f2cc81f0ba7d9c0e19/docker/images/n8n-base/Dockerfile),
which pins `node:24.18.0-alpine3.24`. Every API this document depends on is
present in both 24.x lines, so no finding changed. The findings below now cite
24.18.0 alongside the retained 24.16.0 and 22.21.0 links, because 24.16.0 still
covers the 2.27.4 acceptance anchor.

## Findings

1. **Kanıtlanmış platform gerçeği:** Node.js 22 and 24 expose `fs.open`/`FileHandle`, descriptor-based `stat`, and descriptor-backed read streams. Linux `O_NOFOLLOW` makes open fail when the final path component is a symbolic link. Sources: [Node.js 22.21.0 filesystem API](https://nodejs.org/download/release/v22.21.0/docs/api/fs.html), [Node.js 24.16.0 filesystem API](https://nodejs.org/download/release/v24.16.0/docs/api/fs.html), and [Node.js 24.18.0 filesystem API](https://nodejs.org/download/release/v24.18.0/docs/api/fs.html).

2. **Kanıtlanmış platform gerçeği:** Node.js `crypto.createHash()` supports streaming SHA-256 over large files rather than buffering them. Sources: [Node.js 22.21.0 crypto API](https://nodejs.org/download/release/v22.21.0/docs/api/crypto.html), [Node.js 24.16.0 crypto API](https://nodejs.org/download/release/v24.16.0/docs/api/crypto.html), and [Node.js 24.18.0 crypto API](https://nodejs.org/download/release/v24.18.0/docs/api/crypto.html).

3. **Kanıtlanmış platform gerçeği:** The supported Node.js runtimes expose shell-free `child_process.spawn(command, args, options)`. This supplies the mechanism for bounded, no-network version probes using absolute executable paths; it does not itself validate an executable. Sources: [Node.js 22.21.0 child-process API](https://nodejs.org/download/release/v22.21.0/docs/api/child_process.html), [Node.js 24.16.0 child-process API](https://nodejs.org/download/release/v24.16.0/docs/api/child_process.html), and [Node.js 24.18.0 child-process API](https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html).

4. **Ürün kararı:** ADR 0013 already requires the Toolchain Lock to pin upstream tags/commits, asset names, SHA-256 values, licenses, and source-bundle identity. Upstream signatures/checksums, clean build inputs, npm tarballs, provenance, and release E2E are publication gates; runtime checks do not replace them.

5. **Lisans/güvenlik riski:** Publication-only checks cannot detect an incomplete extraction, damaged worker-local package, or post-install file change. Conversely, hashing every large executable before every request adds repeated disk I/O and CPU cost and can materially delay queue work.

6. **Ürün kararı:** The selector embeds the exact platform package name/version and expected SHA-256 of a canonical execution-manifest file. That manifest lists every runtime executable/companion path, exact byte size, SHA-256, required mode constraints, and expected version probe result. A modified manifest cannot bless modified files unless the independently published selector is modified too.

7. **Ürün kararı:** On first use in each main/worker process, asynchronously and fail-closed: resolve the platform root; verify the manifest digest; require every path's realpath to remain inside that root; open each final component read-only with `O_NOFOLLOW`; require a regular, executable, non-group/world-writable file; stream and compare size/SHA-256; then run fixed, no-network, bounded version probes for yt-dlp, FFmpeg, FFprobe, and Deno under ADR 0020's environment/output/process controls. Do not perform synchronous hashing during module load.

8. **Ürün kararı:** Share one in-flight attestation promise per process. Cache a successful result against platform version/root plus each file's `dev`, `ino`, `size`, `mtimeNs`, and `ctimeNs`. Before every request, cheaply restat and compare all entries; any change forces full re-attestation before spawn. Cache a failure only while the same fingerprints remain. Never repair, chmod, redownload, or fall back.

9. **Ürün kararı:** Any manifest, file, digest, mode, path, or probe mismatch is a global toolchain invariant error and stops the execution before creating an Execution Workspace or starting a download. It never becomes a Failure Item and never includes paths or raw probe output in workflow-visible data.

10. **Lisans/güvenlik riski:** This attestation detects packaging/copy corruption and ordinary file replacement; it is not a sandbox, signature authority, or defense against an attacker controlling the worker UID/root. Metadata caching also leaves a path-to-spawn TOCTOU window. The operator must protect package directories/container filesystems and treat host compromise separately.

11. **E2E ile doğrulanacak varsayım:** On every release-gate anchor, measure first-use attestation, concurrent first calls, cached calls, worker recreation, hot package replacement, and cancellation. Mutate one disposable fixture at a time—manifest, content, mode, symlink, path, version output—and prove fail-closed behavior with no process/workspace. These are disposable CI fixtures, not acceptance-server mutations.

12. **Cevapsız soru:** Exact probe argv, expected output grammar, attestation timeout, and acceptable first-use latency remain **doğrulanmadı** until the frozen Toolchain Lock and official-image benchmarks exist. They must be fixed before implementation acceptance and cannot invoke network or user configuration.
