# Release Candidate Chain

`.github/workflows/publish.yml` is the only publication path for v0.2.0. Run it from the exact
release commit. The `candidate` job performs a clean npm install and build, packs the Platform
Package, Platform Selector, and main package once in dependency order, then records every tarball
digest, file digest/mode, package metadata, Toolchain Lock identity, Corresponding Source identity,
and rollback policy in `release-candidate.json`. GitHub build provenance and the checked
`build-provenance.json` bind the same three package subjects.

The bootstrap run stops after public registry read-back and credential retirement. A later
`verify-existing` run performs every disposable E2E job for the published-byte ticket. Each job
downloads that candidate artifact and sets both `E2E_RELEASE_CANDIDATE_ROOT` and
`E2E_REQUIRE_PUBLISHED_NEXT`. Preparation fetches the exact version from public npm, requires all
three `next` tags to identify it, compares the public tarball integrity and SHA-256 to the candidate,
and only then mirrors those public bytes into the network-isolated Community Packages test stack.
The checkout is never repacked for release evidence.

## Blocking statuses

The workflow exposes independent `source-delivery`, `hermetic`, `three-anchor`, `multiworker`,
`capacity`, `official-ejs`, `live-canary`, and `acceptance-stack` statuses. `source-delivery` and
`prepublication` gate the irreversible `next` publication. All release-readiness statuses run only
after registry read-back; bootstrap runs additionally wait for credential retirement. No job uses
`continue-on-error`, and every recorded gate has `waived: false`.

The `hermetic` status verifies the candidate manifest, then runs the candidate-bound suite inside
the pinned Linux x64 Node image with Docker networking disabled, all capabilities dropped, a
read-only container root, and no-new-privileges. Its evidence records that exact image digest and
`network: none`; an ordinary hosted-runner test cannot satisfy this lane.

The live canary uses the frozen yt-dlp upstream test identity `YE7VzlLtp-4`, disables media
downloads and remote components, and must record actual packaged-Deno challenge execution.
`inconclusive` is blocking, including network and rate-limit outcomes.

`source-delivery` runs the release verifier before `publish-next`. It checks the direct versioned
GitHub source assets, their exact `.sha256` sidecar contents, clean isolated-rebuild evidence,
manual license-review bindings, component inventory, notices, licenses, and the passed Linux
runtime source gate.

The narrow real acceptance environment is approval-protected and uses a dedicated self-hosted
runner. Its operator places already-completed, candidate-bound evidence in the protected
`ACCEPTANCE_STACK_EVIDENCE_JSON` secret. The job validates that the evidence is a clean pass; it
does not treat environment approval alone as test proof. Its `identities` object must contain the
candidate's exact `packages`, `source`, and `toolchain` values, a non-empty `test.id`, and the exact
official acceptance image reference in `images`. The acceptance test identity is exactly
`n8n-2.27.4-acceptance-stack`, and the only accepted image is the ADR 0032 n8n 2.27.4 digest.

## Publish and continuation

Before the one-time bootstrap, the operator must record this exact plan:

- This token exception exists only because new package names cannot yet configure npm Trusted
  Publisher or staged publishing. After bootstrap, those tokenless mechanisms replace it.
- GitHub source assets:
  `n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz` with SHA-256
  `3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882`, and
  `n8n-nodes-yt-dlp-linux-runtime-source-0.2.0.tar.xz` with SHA-256
  `9ffef7272744ddaa982cd960c95ae49a25bd4df689d3485f4b7e555759421ccc`.
  Each asset and its `<asset>.sha256` sidecar uses the direct
  `https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/`
  prefix.
- npm targets, in order: `n8n-nodes-yt-dlp-linux-x64@0.2.0`,
  `n8n-nodes-yt-dlp-platform@0.2.0`, and `n8n-nodes-yt-dlp@0.2.0`.
- Candidate construction recompresses the unchanged Platform Package tar members with exact
  `7zip-bin@5.2.0` gzip settings and fails closed unless the Base64 tarball plus a 1 MiB metadata
  budget fits within a 250 MiB publish-request envelope.
- In npm's Access Tokens UI, create a one-day granular token named
  `n8n-nodes-yt-dlp-bootstrap-0.2.0`, with bypass-2FA, read/write access to all
  packages, and no organization access. All-package access is the minimum available authority
  because these package names do not exist yet. Do not put the token in chat, issues, commands,
  shell history, or logs.
- In GitHub, open Settings → Environments → `npm-bootstrap`, verify that a required reviewer
  protects the environment, and add the token only as `NPM_BOOTSTRAP_TOKEN`. The reviewer approves
  the protected `publish-next` job only after checking the exact commit and candidate digest. Then
  dispatch:
  `gh workflow run publish.yml --ref <exact-release-ref> -f publish_mode=bootstrap
  -f promote_latest=false`.
- The irreversible risk is a public partial or bad `0.2.0` chain. Do not unpublish. Remove or move
  affected `next` tags, deprecate exact published names, and release a new lockstep patch. Any
  permission or unexpected result stops the run without increasing token scope. The
  `partial-publish-audit` artifact reports exact published, missing, and unexpected package names.
- Temporary resources are the one-day token, two environment secrets, hosted-runner workspaces,
  and retention-bounded workflow artifacts. Verification reads back both GitHub source sidecars,
  every npm `next` tag, metadata, dependency graph, tarball integrity, and Sigstore provenance;
  it also confirms that `latest` did not move.

For the one-time v0.2.0 bootstrap, choose `bootstrap`. The protected `npm-bootstrap` environment
supplies the short-lived granular token. The workflow publishes with provenance under `next` in
Platform Package → Platform Selector → main order, then reads registry metadata, provenance, and
tarball bytes back. The read-back fetches each DSSE provenance statement and compares its subject
digest, release workflow/repository, Git commit, and GitHub-hosted builder identity to the expected
candidate manifest. Before trusting those fields, Sigstore verifies the bundle signature,
transparency material, GitHub Actions issuer, and the exact `publish.yml@<release-ref>` certificate
identity.

Immediately after bootstrap read-back, revoke the granular npm token and delete
`NPM_BOOTSTRAP_TOKEN` from the `npm-bootstrap` Environment. Then place a separate proof in the
protected `npm-bootstrap-retirement` Environment as `BOOTSTRAP_RETIREMENT_EVIDENCE_JSON`:

```json
{
	"schemaVersion": 1,
	"candidateSha256": "<sha256 of release-candidate.json>",
	"completedAt": "2026-07-29T12:00:00.000Z",
	"actor": "<reviewed operator identity>",
	"bypassTwoFactorAuthentication": true,
	"environment": "npm-bootstrap",
	"environmentSecretDeleted": true,
	"organizationPermissions": "no-access",
	"packageAccess": "all-packages",
	"packagePermissions": "read-write",
	"secretName": "NPM_BOOTSTRAP_TOKEN",
	"tokenCreatedAt": "2026-07-29T11:00:00.000Z",
	"tokenExpiresAt": "2026-07-30T11:00:00.000Z",
	"tokenName": "n8n-nodes-yt-dlp-bootstrap-0.2.0",
	"tokenRevoked": true,
	"tokenType": "granular",
	"verificationMethod": "operator-ui-read-back",
	"waived": false
}
```

The bootstrap workflow completes after that protected proof passes. Public-package tests run later
under `verify-existing`; promotion never receives or reuses the bootstrap token. Delete
`BOOTSTRAP_RETIREMENT_EVIDENCE_JSON` after the protected job passes. Hosted-runner workspaces are
ephemeral, and workflow artifacts expire under their configured retention periods.

For later Trusted Publisher releases, choose `stage`. The protected `npm-release` environment uses
OIDC and `npm stage publish`; the workflow stops after staging so a maintainer can inspect and
approve each package with 2FA. After approval, rerun the same release commit with
`verify-existing`. That mode does not publish again: it starts at registry read-back, then requires
acceptance and generates `release-evidence-0.2.0.json`.

Every lane must carry candidate-matching package, source, and tool identities plus a test/vector
identity; n8n lanes must also carry exact official image digests. The versioned evidence contains
those identities, the candidate commit, per-gate time and region, and only bounded redacted
diagnostics. Empty or mismatched identity objects, waivers, failures, and `inconclusive` results are
blocking. `RUNNER_REGION` must be a concrete configured region; empty, `unknown`, `unset`, and
`n/a` values fail closed. The evidence is uploaded once to the matching GitHub Release. An
existing asset is not overwritten.

## Promotion and rollback

After the evidence job passes, interactively move `latest` with npm 2FA in dependency order:
Platform Package, Platform Selector, then the main package last. Enable `promote_latest` while the
workflow waits at its protected `npm-promotion` Environment. The job performs unauthenticated
registry read-back and passes only if all three `latest` tags identify the accepted version; it has
no publication or tag-changing credential.

Rollback is tag-based and starts with the main package first so new installs stop selecting the bad
chain. Move or remove its `latest` and `next` tags, then do the same for the Platform Selector and
Platform Package. Mark every bad lockstep package version with `npm deprecate`, publish a new patch,
run the complete chain again, and promote that patch.

Never use `npm unpublish` for rollback.
