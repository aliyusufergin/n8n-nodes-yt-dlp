# npm release bootstrap and promotion

Accessed: 2026-07-17

## Version anchors

- npm documentation is rolling current documentation. The CLI pages inspected select npm 11.18.0; minimum-version statements are recorded explicitly below.
- n8n tag: `n8n@2.27.4`, commit [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485).
- Acceptance image Node/npm: Node.js v24.16.0 and npm 11.16.0.
- GitHub repository: [`aliyusufergin/n8n-nodes-yt-dlp`](https://github.com/aliyusufergin/n8n-nodes-yt-dlp).

## Read-only registry evidence

Registry queries at 2026-07-17T15:01:28Z returned:

- `n8n-nodes-yt-dlp`: E404, fully unpublished at 2026-07-17T09:30:52.327Z.
- `n8n-nodes-yt-dlp-linux-x64`: E404, fully unpublished at 2026-07-17T09:32:11.969Z.
- `n8n-nodes-yt-dlp-platform`: E404 Not Found with no unpublished timestamp.

The failed `npm view` calls created three local npm debug logs. Only those exact logs were removed and absence was verified. No registry, GitHub, or server state changed.

## Findings

1. **Kanıtlanmış platform gerçeği:** npm's registry is immutable at the package-version level. A published `name@version` can never be reused even after unpublish. Fully unpublishing also prevents publishing any new version under that name for 24 hours. Source: [npm Unpublish Policy](https://docs.npmjs.com/policies/unpublish/), accessed 2026-07-17.

2. **Kanıtlanmış platform gerçeği:** Therefore `0.1.0` cannot be reused. The main and x64 names cannot accept a new version until their respective 24-hour blocks expire. Registry ownership after the block and the selector name's availability are not proven by unauthenticated E404 responses.

3. **Kanıtlanmış platform gerçeği:** Trusted publishing requires npm 11.5.1+, Node.js 22.14.0+, a supported cloud-hosted CI runner, and an existing package. GitHub configuration binds the owner/repository, exact workflow filename, optional environment, and allowed publish actions. Each package permits one trusted publisher. Sources: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/), accessed 2026-07-17.

4. **Kanıtlanmış platform gerçeği:** GitHub Actions OIDC trusted publishing automatically creates provenance for a public package from a public repository. It requires `id-token: write`; the package `repository.url` must exactly match the publishing repository. Self-hosted runners are unsupported. Source: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/), accessed 2026-07-17.

5. **Kanıtlanmış platform gerçeği:** Staged publishing requires npm 11.15.0+, Node.js 22.14.0+, 2FA, write access, and an existing package. A trusted publisher may be limited to `npm stage publish`; a human must inspect and approve the staged package with 2FA. A stage's dist-tag is fixed at staging time. Sources: [Staged publishing](https://docs.npmjs.com/staged-publishing/) and [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage/), accessed 2026-07-17.

6. **Kanıtlanmış platform gerçeği:** Publishing without an explicit tag sets `latest`; `npm install <name>` resolves `latest`. Publishing or staging with `--tag next` avoids changing `latest`, and `next` has no special registry semantics. Source: [`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/), accessed 2026-07-17.

7. **Kanıtlanmış platform gerçeği:** n8n 2.27.4's Community Packages service uses `latest` when no version is supplied, but its backend accepts an explicit version and passes that exact value to `npm pack`. Source: [`community-packages.service.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/modules/community-packages/community-packages.service.ts), n8n 2.27.4.

8. **Kanıtlanmış platform gerçeği:** OIDC trust tokens support publish/stage operations, not `dist-tag`, trust configuration, stage approval, or other package administration. These require interactive authentication or another explicitly authorized credential. Source: [Trusted publishing limitations](https://docs.npmjs.com/trusted-publishers/), accessed 2026-07-17.

9. **Ürün kararı:** ADR 0023 treats v0.2.0 as a one-time bootstrap exception because none of the three packages currently qualifies for trust or staging. After all pre-publication gates pass and both 24-hour blocks expire, publish with `--tag next --access public --provenance` from one protected GitHub-hosted workflow using a one-day granular token with read/write and bypass-2FA. Publish `linux-x64`, then selector, then main. The token's unavoidable all-package/new-package authority is a bootstrap security risk.

10. **Ürün kararı:** Put the bootstrap token only in a protected `npm-bootstrap` GitHub Environment, require a human approval, never print it, and delete the environment secret and revoke the token immediately after read-back verification of all three registry versions and provenance attestations. The user performs token creation, secret entry, approvals, revocation, and any OTP in official interfaces; no secret is sent through chat.

11. **Ürün kararı:** Before `latest`, install main `0.2.0` through the real n8n Community Packages backend using its explicit-version field and run the complete exact-image queue-mode release gate. Verify registry metadata, tarball contents/checksums, provenance, GPL Corresponding Source release assets, dependency closure, worker loading, executable selection, workflows, cleanup, and artifact storage.

12. **Ürün kararı:** After v0.2.0 exists, configure all three packages to the exact `publish.yml` workflow and protected `npm-release` GitHub Environment with only `npm stage publish` permission. Set package publishing access to disallow traditional tokens. Future releases stage `linux-x64`, selector, then main under `next`; the maintainer downloads/reviews and approves them with 2FA in the same order.

13. **Ürün kararı:** Promote only a fully accepted lockstep version by interactively moving `latest` for `linux-x64`, selector, then main last. The bare-name Community Packages GUI install is a post-promotion smoke test, not the first time the version is exercised.

14. **Ürün kararı:** Rollback never unpublishes. First move or remove the main package's `latest` and `next` tags, then selector and platform tags; deprecate all three bad versions with the replacement or incident reference. Publish a new lockstep patch version. If there is no earlier good release, remove `latest` rather than pointing it at a known-bad version.

15. **Lisans/güvenlik riski:** The v0.2.0 bootstrap token must be able to create or republish unscoped package names that do not yet have configurable trust relationships. npm documents granular tokens and bypass-2FA but does not prove through unauthenticated inspection that the current account owns the unpublished names or can claim the selector name.

16. **Lisans/güvenlik riski:** `next` versions are public and exactly installable even before `latest` promotion. Candidate publication is irreversible; a failed gate consumes `0.2.0` and requires `0.2.1` for all three packages.

17. **E2E ile doğrulanacak varsayım:** npm 11.16.0 satisfies the documented minimums, but the exact `npm stage publish --tag next`, OIDC, approval, automatic provenance, and tag-promotion behavior must be rehearsed with disposable package names before touching the canonical names. The rehearsal itself is a future state-changing operation requiring a separate plan and approval.

18. **Cevapsız soru:** Package ownership, npm account 2FA, GitHub Environment protection availability, and ability to create the required bootstrap token are user-controlled facts. They must be verified without exposing credentials immediately before the release operation.
