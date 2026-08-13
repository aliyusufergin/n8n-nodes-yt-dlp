# n8n 2.x release-gate matrix

Accessed: 2026-07-17

## Version anchors

| Role | n8n tag | Source commit | Official Linux amd64 manifest |
|---|---|---|---|
| 2.x floor | [`n8n@2.0.0`](https://github.com/n8n-io/n8n/tree/a8ecda44f7627630bc8b78cf671405157ad41c4f) | `a8ecda44f7627630bc8b78cf671405157ad41c4f` | `sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795` |
| Acceptance deployment | [`n8n@2.27.4`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485) | `a4d0dfce294064026be1a6a246e6da348fea1485` | `sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d` |
| Current release head | [`n8n@2.34.5`](https://github.com/n8n-io/n8n/tree/f745babb4b5a72bdecf454f2cc81f0ba7d9c0e19) | `f745babb4b5a72bdecf454f2cc81f0ba7d9c0e19` | `sha256:7e82936bc03d310ddb8759c361f4e225412f0c3daad8d4b4e0d10c7e034c1b11` |

The release-head tag was the newest non-draft, non-prerelease 2.x GitHub release at inspection time. It is a moving fact and must be frozen again at release-candidate cut.

Head advanced 2026-08-13, per ADR 0025's own advance clause, from 2.30.7
(`1e2d027d6d239a55fc95598179e2a25d47e78c9b`, `sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060`)
to 2.34.5. The 2.34.5 image index digest is
`sha256:d91033b4fac2f7b75c5c4007e10824c66147f7d7a3cccb488720e97452ee7dc7`, which is the
same image ADR 0033 records for the acceptance deployment. Findings below still carry
their 2026-07-17 access date against the previous head unless a finding names 2.34.5.

## Head re-verification (2026-08-13)

Every head-dependent research document was re-read against the 2.34.5 source
`f745babb4b5a72bdecf454f2cc81f0ba7d9c0e19`, not merely relinked. Result: **no
behavior changed**. `community-packages.service.ts` and
`binary-helper-functions.ts` are byte-identical to 2.30.7. `interfaces.ts` keeps
`IBinaryData`, `INodeExecutionData`, `usableAsTool`, and `Logger` in the shapes
the contracts depend on; only declaration lines moved.
`get-input-connection-data.ts` still discards binary from AI-tool responses, and
`node-execution-context.ts` still returns the process logger unchanged — both
files differ from 2.30.7 only outside the paths these documents cite. The single
substantive difference is the image runtime: Node.js 24.16.0 to 24.18.0 on the
same hardened Alpine 3.24 base and the same UID.

Both head-only lanes were rerun at the new anchor on 2026-08-13: the `capacity`
lane and the `multiworker` lane. Each completed its scenario set without a lane
failure, which is what Finding 9 gates on. That is not the same as a clean
capacity verdict — the capacity lane's job is to produce a bounded record, and
this record again reports the load workload as unsafe. The bounded capacity
result is
committed as `docs/capacity/n8n-2.34.5-node-0.2.0.json`; the previous head's
`docs/capacity/n8n-2.30.7-node-0.2.0.json` is retained as historical evidence
for that image and is not superseded in place. The decision is unchanged from
the previous head: worker concurrency 10 is unsafe on the measured disposable
topology, so the supported scope stays at concurrency 1 and no node hard cap
moves. One recorded field differs: `ffmpegThreadRestrictionProven` is `false` at
2.34.5 because a single process sample out of 437 reported a yt-dlp command line
without the FFmpeg thread flag. The node builds that argv unconditionally and the
same run directly observed a restricted FFmpeg process, so this is tracked as an
observer-robustness defect in the lane rather than a platform or node change.

Nothing found contradicts ADR 0025. The `>=2 <3` Uyumluluk Hedefi, the
three-anchor structure, and the head's exact-digest freeze all still hold, and
no finding required reopening a product decision. Documents re-verified:
`workflow-result-contract.md`, `n8n-ai-tool-binary-boundary.md`,
`platform-support-and-install-gates.md`, `operator-observability-boundary.md`,
`runtime-toolchain-attestation.md`,
`n8n-2.27.4-community-packages-queue-mode.md`, and this file.

## Findings

1. **Kanıtlanmış platform gerçeği:** The official Linux amd64 images exist for all three anchors. The 2.0.0 Docker source uses Node.js 22.21.0 on Alpine 3.22; 2.30.7 uses Node.js 24.16.0 on Alpine 3.24. The inspected 2.27.4 deployment uses Node.js 24.16.0 on Alpine 3.22. Sources: [`2.0.0 n8n-base Dockerfile`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/docker/images/n8n-base/Dockerfile), [`2.30.7 n8n-base Dockerfile`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/docker/images/n8n-base/Dockerfile), official registry manifests, and the read-only acceptance inspection.

   Head advance, measured 2026-08-13 by running the pinned amd64 image itself: 2.34.5 reports `Docker Hardened Images (Alpine)` 3.24, Node.js 24.18.0, npm 11.18.0, and runs as `uid=1000(node)`. The previous head 2.30.7 reports the same hardened Alpine 3.24 base and the same UID with Node.js 24.16.0 and npm 11.17.0, so the head advance changes the Node.js and npm patch levels and nothing else about the base.

2. **Kanıtlanmış platform gerçeği:** n8n 2.0.0 already exposes `getExecutionCancelSignal()`, `onExecutionCancellation()`, and stream-capable `prepareBinaryData()`. Sources: [`base-execute-context.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/core/src/execution-engine/node-execution-context/base-execute-context.ts) and [`interfaces.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/workflow/src/interfaces.ts), n8n 2.0.0.

3. **Kanıtlanmış platform gerçeği:** At both 2.0.0 and 2.30.7, Community Packages accepts an explicit package version, removes the main package's direct optional/dev/peer dependencies, and installs remaining dependencies with shallow strategy, scripts ignored, and bin links disabled. Sources: [`2.0.0 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/cli/src/modules/community-packages/community-packages.service.ts) and [`2.30.7 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/cli/src/modules/community-packages/community-packages.service.ts).

   Head advance, re-verified 2026-08-13: [`2.34.5 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/f745babb4b5a72bdecf454f2cc81f0ba7d9c0e19/packages/cli/src/modules/community-packages/community-packages.service.ts) is byte-identical to the 2.30.7 file, so the head advance changes nothing about the install path.

4. **Ürün kararı:** ADR 0025 keeps `>=2 <3` as the Uyumluluk Hedefi, but makes v0.2.0 Doğrulanmış Destek exactly the three frozen tags/digests in the table. Documentation must never collapse the two terms into a claim that every 2.x patch was tested.

5. **Ürün kararı:** Run the full public-package E2E independently against each exact image: Postgres, Redis, main, one worker, queue mode, database binary storage, manual execution offload, production execution, explicit-version Community Packages install, worker event propagation, node loading, yt-dlp/Deno/FFmpeg/FFprobe execution, artifact round-trip, limits, cancellation, and cleanup.

6. **Ürün kararı:** Add one scale/recovery lane at the frozen release head with two workers. It must install while both are online, route executions to both, recreate one worker without package files, add a late worker, and prove exact-version recovery/readiness before work is accepted.

7. **Ürün kararı:** Run the real acceptance deployment's 2.27.4 smoke/E2E only after a separate state-change plan and approval. CI/disposable environments supply the destructive matrix; read-only server facts alone do not count as workflow acceptance.

8. **Ürün kararı:** Freeze the newest stable 2.x tag and image digest when the Release Candidate Zinciri is cut. A later n8n release before npm `latest` promotion is documented as unverified and does not create an endlessly moving gate; the next node release advances the head.

9. **Ürün kararı:** Any failure at the floor, acceptance version, or frozen release head blocks `latest`. Do not silently narrow the 2.x Uyumluluk Hedefi or label a failing version supported; fix it or reopen the compatibility decision explicitly.

10. **Lisans/güvenlik riski:** Three points do not prove every intermediate 2.x version. They provide floor/current/head and Node/Alpine variance, while exact source review and issue reports may still reveal an affected intermediate version.

11. **E2E ile doğrulanacak varsayım:** Source compatibility does not prove the selector's nested optional dependency, packaged executable ABI, queue event timing, binary backend, or cancellation behavior in any image. None of the three complete release lanes has run for the new design.

12. **Cevapsız soru:** The disposable CI topology, test media/endpoints, deterministic challenge fixture, and credentials required for authentication tests remain to be designed. Tests must not depend solely on mutable third-party media sites.
