# v0.2.1 Release Record

This is the published record for the `0.2.1` Release Candidate Chain: what the release covers, what
it does not, and what stays an operator responsibility after it. It records exactly what the gates
observed and claims nothing beyond that.

## Published chain

One lockstep version across three packages, published under `next` and promoted to `latest` in
dependency order.

| Package | Version | Tarball SHA-256 |
| --- | --- | --- |
| `n8n-nodes-yt-dlp-linux-x64` | 0.2.1 | `04acc71c79e71b8455a2660503c30f4cb9e84d8a127fcb71eb7763de47448a9a` |
| `n8n-nodes-yt-dlp-platform` | 0.2.1 | `cd116ec01875822a374de872702a4c8a47ab26cafef9b6b698bb454e9368c3a5` |
| `n8n-nodes-yt-dlp` | 0.2.1 | `d227b8abcaddf5abef269c7b1ea15da2e39492a8d715ea95b8b572a7f61d8df7` |

`0.2.0` stays published. `0.2.1` supersedes it with four fixes over the same packaged binaries.

## Evidence

`release-evidence-0.2.1.json` is attached to the `v0.2.1` GitHub Release. It binds candidate manifest
SHA-256 `036a5ae8d9fed314cc1ef465cc3e86ce52eb2562e468974528cd96792573eb47` at commit
`3515fff1954afceb74fae78109481cc58e5332ba`, and records nine gates — `source-delivery`, `hermetic`,
`three-anchor`, `multiworker`, `capacity`, `official-ejs`, `live-canary`, `registry-readback`, and
`acceptance-stack` — each `pass` and each `waived: false`. Every post-publication gate ran against the
public `next` tarball bytes read back from the registry, not against the checkout.

## Supported matrix

| Dimension | Exact supported value |
| --- | --- |
| Operating system | Linux only (`os: ["linux"]` on all three packages) |
| CPU architecture | x64 only (`cpu: ["x64"]`) |
| n8n | 2.x, verified at three pinned anchors (below) |
| Verified n8n anchors | `2.0.0` (2.x floor), `2.27.4` (acceptance), `2.34.5` (frozen stable head, frozen at 2026-08-13) |
| Acceptance stack | n8n 2.34.6, image `sha256:f5140088385af2d4e681e177d8264bcb41e8fe126062030c5c65cd8f3e1605e1` |
| Build toolchain | Node 24.16.0, npm 11.16.0, 7zip-bin 5.2.0 |
| Packaged yt-dlp | `2026.07.14.233956` (`yt-dlp_musllinux`) |
| Packaged FFmpeg | `autobuild-2026-07-12-15-07` (GPL build, FFmpeg commit `a09be9b9`) |
| Packaged Deno | `v2.9.3` |
| Packaged yt-dlp-ejs | `0.8.0` |
| Runtime downloads | None: `runtimeDownloads`, `runtimeSelfUpdate`, and `mutableAssets` are all false |

The GPL Corresponding Source bundles are unchanged from `0.2.0` and stay on the `v0.2.0` GitHub
Release, which the `0.2.1` candidate's source identity points at:
`n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz`
(`3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882`) and
`n8n-nodes-yt-dlp-linux-runtime-source-0.2.0.tar.xz`
(`9ffef7272744ddaa982cd960c95ae49a25bd4df689d3485f4b7e555759421ccc`).

## Known unverified facts

- The live canary proves that one frozen extractor and challenge path worked for one upstream test
  identity (`YE7VzlLtp-4`) at one recorded time from one recorded region. It is not a supported-site
  guarantee, and it exercises no media download.
- Only the three pinned n8n images above were exercised. Other 2.x versions are unverified, and n8n
  1.x is neither verified nor supported.
- The acceptance stack is one real deployment, not a fleet; it says nothing about other operators'
  configurations.
- The capacity and multiworker lanes were measured on the recorded release runners. They prove the
  bounded-resource and recovery contracts held there; they are not throughput guarantees.
- The gates ran from a single recorded region (`local-ankara`). Network-dependent behaviour elsewhere
  is unobserved.
- No architecture, operating system, or libc outside Linux x64 was tested, and none is claimed.
- yt-dlp's own supported-site list is upstream's, is unpinned by this release, and is untested here.

## Operator responsibilities

- Publish only through the stage-only path. `publish.yml` holds no npm token; each package's Trusted
  Publisher grants `npm stage publish` alone through the protected `npm-release` environment.
- Approve the `publish-next` deployment only after checking the exact commit and candidate digest,
  then review each staged tarball in npm and approve it with npm 2FA. That approval is what
  publishes.
- Promote `latest` in dependency order — Platform Package, Platform Selector, main package last — and
  only after the evidence job passes. Enable `promote_latest` so the read-back job confirms it.
- Keep `PUBLISHED_CANDIDATE_RUN_ID` and `PUBLISHED_CANDIDATE_SHA256` pointing at the staged candidate
  that was actually published; a stale pair fails closed.
- Delete `ACCEPTANCE_STACK_EVIDENCE_JSON` once its protected job has passed.
- Roll back by tag, main package first, then deprecate the bad lockstep versions and ship a new
  patch. Never run `npm unpublish`, never republish an existing version, and leave the preserved
  `v0.1.0` release and its sources untouched.
