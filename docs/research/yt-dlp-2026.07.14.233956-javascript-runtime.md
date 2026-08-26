# yt-dlp 2026.07.14.233956 JavaScript runtime isolation

Accessed: 2026-07-17. Re-anchored to the packaged nightly and re-verified: 2026-08-26

## Version anchors

- Packaged yt-dlp nightly tag: [`2026.07.14.233956`](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/2026.07.14.233956), source commit [`aefce1ee`](https://github.com/yt-dlp/yt-dlp/tree/aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8) as recorded in the Toolchain Lock.
- Deno release candidate inspected: [`v2.9.3`](https://github.com/denoland/deno/releases/tag/v2.9.3), published 2026-07-15. The exact bundled version remains a separate release decision.
- Host runtime bounds inspected: Node.js [`v22.16.0`](https://nodejs.org/download/release/v22.16.0/docs/api/permissions.html) and the acceptance worker's Node.js v24.16.0.

## Findings

1. **Kanıtlanmış platform gerçeği:** yt-dlp 2026.07.14.233956 requires Node.js 22 or newer for its Node runtime provider. The provider invokes Node with `--permission` (or `--experimental-permission` before Node 23.5) and does not grant filesystem, child-process, worker, addon, or WASI permissions. Sources: [`_jsruntime.py`](https://github.com/yt-dlp/yt-dlp/blob/aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8/yt_dlp/utils/_jsruntime.py) and [`node.py`](https://github.com/yt-dlp/yt-dlp/blob/aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8/yt_dlp/extractor/youtube/jsc/_builtin/node.py), commit `aefce1ee`.

2. **Lisans/güvenlik riski:** Node.js v22.16.0 documents its permission model as a defense against accidental access, not a security guarantee for malicious code. Its documented restricted capabilities do not include network access. The same absence was observed in the v24.16.0 versioned documentation. Source: [Node.js v22.16.0 permission model](https://nodejs.org/download/release/v22.16.0/docs/api/permissions.html).

3. **Kanıtlanmış platform gerçeği:** yt-dlp 2026.07.14.233956 requires Deno 2.3.0 or newer. Its Deno provider invokes `deno run` with `--no-prompt`, `--no-remote`, `--no-lock`, `--node-modules-dir=none`, and `--no-config`, and grants no filesystem, network, environment, subprocess, FFI, or system-information permission. Sources: [`_jsruntime.py`](https://github.com/yt-dlp/yt-dlp/blob/aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8/yt_dlp/utils/_jsruntime.py) and [`deno.py`](https://github.com/yt-dlp/yt-dlp/blob/aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8/yt_dlp/extractor/youtube/jsc/_builtin/deno.py), commit `aefce1ee`.

4. **Kanıtlanmış platform gerçeği:** Deno denies filesystem, network, environment, and subprocess access unless explicitly granted. `--no-prompt` prevents an interactive permission escalation prompt. Source: [Deno security and permissions](https://docs.deno.com/runtime/fundamentals/security/), rolling official documentation accessed 2026-07-17.

5. **Ürün kararı:** The first release bundles Deno in the Platform Package and exposes no runtime choice. The node supplies its absolute packaged path, disables remote component selection, sanitizes the yt-dlp environment, and disables Deno update checks. Node.js runtime support is outside v1 scope.

6. **E2E ile doğrulanacak varsayım:** The official Deno `x86_64-unknown-linux-gnu` executable has not yet been executed inside the exact supported Alpine-based n8n image. The acceptance worker has no Deno executable and does contain a glibc compatibility loader, but that is not proof of compatibility. Release acceptance must checksum the pinned asset, execute it inside the exact image digest, solve a real challenge without remote components, and prove filesystem/network/environment/subprocess denial.
