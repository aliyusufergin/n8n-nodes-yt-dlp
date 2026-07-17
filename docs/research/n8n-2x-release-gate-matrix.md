# n8n 2.x release-gate matrix

Accessed: 2026-07-17

## Version anchors

| Role | n8n tag | Source commit | Official Linux amd64 manifest |
|---|---|---|---|
| 2.x floor | [`n8n@2.0.0`](https://github.com/n8n-io/n8n/tree/a8ecda44f7627630bc8b78cf671405157ad41c4f) | `a8ecda44f7627630bc8b78cf671405157ad41c4f` | `sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795` |
| Acceptance deployment | [`n8n@2.27.4`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485) | `a4d0dfce294064026be1a6a246e6da348fea1485` | `sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d` |
| Current release head | [`n8n@2.30.7`](https://github.com/n8n-io/n8n/tree/1e2d027d6d239a55fc95598179e2a25d47e78c9b) | `1e2d027d6d239a55fc95598179e2a25d47e78c9b` | `sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060` |

The release-head tag was the newest non-draft, non-prerelease 2.x GitHub release at inspection time. It is a moving fact and must be frozen again at release-candidate cut.

## Findings

1. **Kanıtlanmış platform gerçeği:** The official Linux amd64 images exist for all three anchors. The 2.0.0 Docker source uses Node.js 22.21.0 on Alpine 3.22; 2.30.7 uses Node.js 24.16.0 on Alpine 3.24. The inspected 2.27.4 deployment uses Node.js 24.16.0 on Alpine 3.22. Sources: [`2.0.0 n8n-base Dockerfile`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/docker/images/n8n-base/Dockerfile), [`2.30.7 n8n-base Dockerfile`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/docker/images/n8n-base/Dockerfile), official registry manifests, and the read-only acceptance inspection.

2. **Kanıtlanmış platform gerçeği:** n8n 2.0.0 already exposes `getExecutionCancelSignal()`, `onExecutionCancellation()`, and stream-capable `prepareBinaryData()`. Sources: [`base-execute-context.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/core/src/execution-engine/node-execution-context/base-execute-context.ts) and [`interfaces.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/workflow/src/interfaces.ts), n8n 2.0.0.

3. **Kanıtlanmış platform gerçeği:** At both 2.0.0 and 2.30.7, Community Packages accepts an explicit package version, removes the main package's direct optional/dev/peer dependencies, and installs remaining dependencies with shallow strategy, scripts ignored, and bin links disabled. Sources: [`2.0.0 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/cli/src/modules/community-packages/community-packages.service.ts) and [`2.30.7 CommunityPackagesService`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/cli/src/modules/community-packages/community-packages.service.ts).

4. **Ürün kararı:** ADR 0025 keeps `>=2 <3` as the Uyumluluk Hedefi, but makes v0.2.0 Doğrulanmış Destek exactly the three frozen tags/digests in the table. Documentation must never collapse the two terms into a claim that every 2.x patch was tested.

5. **Ürün kararı:** Run the full public-package E2E independently against each exact image: Postgres, Redis, main, one worker, queue mode, database binary storage, manual execution offload, production execution, explicit-version Community Packages install, worker event propagation, node loading, yt-dlp/Deno/FFmpeg/FFprobe execution, artifact round-trip, limits, cancellation, and cleanup.

6. **Ürün kararı:** Add one scale/recovery lane at the frozen release head with two workers. It must install while both are online, route executions to both, recreate one worker without package files, add a late worker, and prove exact-version recovery/readiness before work is accepted.

7. **Ürün kararı:** Run the real acceptance deployment's 2.27.4 smoke/E2E only after a separate state-change plan and approval. CI/disposable environments supply the destructive matrix; read-only server facts alone do not count as workflow acceptance.

8. **Ürün kararı:** Freeze the newest stable 2.x tag and image digest when the Release Candidate Zinciri is cut. A later n8n release before npm `latest` promotion is documented as unverified and does not create an endlessly moving gate; the next node release advances the head.

9. **Ürün kararı:** Any failure at the floor, acceptance version, or frozen release head blocks `latest`. Do not silently narrow the 2.x Uyumluluk Hedefi or label a failing version supported; fix it or reopen the compatibility decision explicitly.

10. **Lisans/güvenlik riski:** Three points do not prove every intermediate 2.x version. They provide floor/current/head and Node/Alpine variance, while exact source review and issue reports may still reveal an affected intermediate version.

11. **E2E ile doğrulanacak varsayım:** Source compatibility does not prove the selector's nested optional dependency, packaged executable ABI, queue event timing, binary backend, or cancellation behavior in any image. None of the three complete release lanes has run for the new design.

12. **Cevapsız soru:** The disposable CI topology, test media/endpoints, deterministic challenge fixture, and credentials required for authentication tests remain to be designed. Tests must not depend solely on mutable third-party media sites.
