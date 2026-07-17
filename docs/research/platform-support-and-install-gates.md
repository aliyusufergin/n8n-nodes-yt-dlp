# Platform support and install gates

Accessed: 2026-07-17

## Version anchors

- n8n 2.0.0: [`a8ecda44f7627630bc8b78cf671405157ad41c4f`](https://github.com/n8n-io/n8n/tree/a8ecda44f7627630bc8b78cf671405157ad41c4f)
- n8n 2.27.4: [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485)
- n8n 2.30.7: [`1e2d027d6d239a55fc95598179e2a25d47e78c9b`](https://github.com/n8n-io/n8n/tree/1e2d027d6d239a55fc95598179e2a25d47e78c9b)
- n8n docs snapshot: [`c130d433dff64e1ece2e84cfa4658ccad127794e`](https://github.com/n8n-io/n8n-docs/tree/c130d433dff64e1ece2e84cfa4658ccad127794e)

## Findings

1. **Ürün kararı:** ADR 0007 already limits v0.2.0 Doğrulanmış Destek to official n8n Docker images on Linux x64. Linux arm64 has upstream assets but lacks the complete package, queue, executable, and source-bundle E2E, so it is not a supported architecture in this release.

2. **Kanıtlanmış platform gerçeği:** npm package metadata can allow/block host operating systems through `os`, resolved from `process.platform`, and CPU architectures through `cpu`, resolved from `process.arch`. The `libc` field applies only on Linux and expresses libc compatibility. Source: [npm CLI v11 `package.json` documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#os), version shown as 11.18.0 at access time.

3. **Kanıtlanmış platform gerçeği:** At the three n8n anchors, Community Packages extracts the requested main tarball, removes its direct optional/dev/peer dependencies, and installs remaining dependencies shallowly with scripts and bin links disabled. A normal main-to-selector dependency is therefore retained, while a direct main-to-platform optional dependency is not. Sources: [`2.0.0 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/cli/src/modules/community-packages/community-packages.service.ts), [`2.27.4 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/modules/community-packages/community-packages.service.ts), and [`2.30.7 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/cli/src/modules/community-packages/community-packages.service.ts).

4. **E2E ile doğrulanacak varsayım:** Giving the selector normal dependency `os: ["linux"]` and `cpu: ["x64"]` should make npm reject unsupported hosts before the node can be loaded, while its exact-version optional platform dependency should install only on Linux x64. npm documents the fields, but the complete result through n8n's extracted-package/shallow installer is not guaranteed until tested on exact images and representative nonmatching hosts.

5. **Kanıtlanmış platform gerçeği:** The versioned n8n docs say installing unverified npm community nodes is available only on self-hosted instances; unverified community nodes are unavailable on n8n Cloud. Sources: [`installation-and-management/README.md`](https://github.com/n8n-io/n8n-docs/blob/c130d433dff64e1ece2e84cfa4658ccad127794e/docs/integrations/community-nodes/installation-and-management/README.md) and [`gui-installation.md`](https://github.com/n8n-io/n8n-docs/blob/c130d433dff64e1ece2e84cfa4658ccad127794e/docs/integrations/community-nodes/installation-and-management/gui-installation.md), docs commit `c130d433`.

6. **Kanıtlanmış platform gerçeği:** Verified community nodes can be installed through the nodes panel, including on n8n Cloud when enabled, but verification is a separate n8n program. Nothing inspected proves this package is verified, eligible, installed, or executable on n8n Cloud. Source: [`install-verified-community-nodes.md`](https://github.com/n8n-io/n8n-docs/blob/c130d433dff64e1ece2e84cfa4658ccad127794e/docs/integrations/community-nodes/installation-and-management/install-verified-community-nodes.md), docs commit `c130d433`.

7. **Ürün kararı:** Put `os: ["linux"]` and `cpu: ["x64"]` on the v0.2.0 main, selector, and Linux x64 platform packages. Publish no arm64, Windows, or macOS platform package. Do not set `libc` until exact tool ABI requirements and npm detection are proven; the official Alpine images' complete compatibility environment cannot be represented by a libc label alone.

8. **Ürün kararı:** Treat npm metadata as the early install gate, not the only security boundary. The selector resolver must independently require `process.platform === "linux"`, `process.arch === "x64"`, the exact platform package, expected manifest/digests, and executable probes before any spawn. It must never search `PATH`, fall back to host yt-dlp/FFmpeg/Deno, download a package, or repair permissions. Unsupported platform and missing/corrupt toolchain are global invariant errors, never Failure Items.

9. **Ürün kararı:** Keep Doğrulanmış Destek exactly official n8n Docker Linux x64. Other Linux x64 containers, bare-metal/npm installations, alternative bases, Windows, macOS, Linux arm64, and n8n Cloud are explicitly out of support for v0.2.0. Do not attempt to identify or enforce the official image through filesystem branding; compatible non-official Linux x64 may install or run, but remains **doğrulanmadı** and receives no support claim.

10. **Ürün kararı:** Document unsupported-platform behavior in the package README and node description without suggesting custom images or manual executable installation. A user on an unsupported host must use a future platform package/release, not bypass the selector with system binaries.

11. **E2E ile doğrulanacak varsayım:** Before `latest`, test exact tarballs through the real Community Packages backend on all three official Linux x64 anchors; prove only the x64 platform package exists, exact executable paths are selected, and all probes pass. In isolated disposable lanes, prove installation fails or resolver fails closed on Linux arm64, Windows, and macOS, and prove a removed/corrupt platform package never falls back to `PATH`.

12. **Cevapsız soru:** Whether the packaged yt-dlp, Deno, FFmpeg, and FFprobe set runs on any particular non-official Linux x64 distribution is **doğrulanmadı**. Passing such a host does not expand the release's support matrix without a new exact-image E2E and product decision.
