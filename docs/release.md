# Release Candidate Chain

Everything below is release-only. The cheap per-pull-request gate — `typecheck`, `lint`, `test` —
lives in `docs/ci.md` and never touches these workflows.

`.github/workflows/publish.yml` is the normal publication path for v0.2.1. Run it from the exact
release commit. The `candidate` job performs a clean npm install and build, packs the Platform
Package, Platform Selector, and main package once in dependency order, then records every tarball
digest, file digest/mode, package metadata, Toolchain Lock identity, Corresponding Source identity,
and rollback policy in `release-candidate.json`. Candidate construction recompresses the unchanged
Platform Package tar members with exact `7zip-bin@5.2.0` gzip settings and fails closed unless the
Base64 tarball plus a 1 MiB metadata budget fits within a 250 MiB publish-request envelope. GitHub
build provenance and the checked `build-provenance.json` bind the same three package subjects.

A `stage` run stops right after `publish-next`: `registry-readback` runs only under
`verify-existing`, and the staged packages are not public until a maintainer reviews each tarball and
approves it with npm 2FA. A later `verify-existing` run performs every disposable E2E job for the
published-byte ticket. Its
`candidate` job downloads the exact `release-candidate-0.2.1` artifact from the run that built it,
named by `PUBLISHED_CANDIDATE_RUN_ID`, and requires the manifest SHA-256 in
`PUBLISHED_CANDIDATE_SHA256`. For 0.2.1 those are stage run `31880525687` and
`036a5ae8d9fed314cc1ef465cc3e86ce52eb2562e468974528cd96792573eb47`. Replace both whenever a new
candidate is published; a stale pair fails the checksum check instead of verifying the wrong bytes.
Registry read-back then
verifies all three public `next` identities, metadata, provenance, integrity, and tarball SHA-256
values while writing the fetched bytes to `published-candidate-0.2.1`. Every post-publication gate
downloads that public-byte artifact; the checkout and original candidate tarballs are never used as
release evidence.

Each n8n anchor also sets `E2E_REQUIRE_PUBLISHED_NEXT`. Preparation re-fetches the explicit exact
version from public npm, compares the bytes with the same candidate evidence, and only then mirrors
them into the Community Packages registry. During workflow execution both `e2e` and `control`
networks are internal, so the full node contract can reach only the prepared registry and fixture
services.

## Blocking statuses

The workflow exposes independent `source-delivery`, `hermetic`, `three-anchor`, `multiworker`,
`capacity`, `official-ejs`, `live-canary`, and `acceptance-stack` statuses. `source-delivery` and
`prepublication` gate the irreversible `next` publication. All release-readiness statuses run only
after registry read-back. No job uses `continue-on-error`, and every recorded gate has
`waived: false`.

The `hermetic` status verifies the candidate manifest, then runs the candidate-bound suite inside
the pinned Linux x64 Node image with Docker networking disabled, all capabilities dropped, a
read-only container root, and no-new-privileges. Its evidence records that exact image digest and
`network: none`; an ordinary hosted-runner test cannot satisfy this lane.

That isolation removes three things the suite needs, so the lane restores each one without widening
it. The container runs as the runner's own uid to keep the bind-mounted workspace ownership intact,
and the image's passwd database does not name that uid, so the lane mounts a read-only passwd file
that adds it ahead of the image's own entries; otherwise `os.userInfo()` fails and the release build
never starts. `HOME` is the
writable `/tmp` tmpfs, and the packaged Deno is given an explicit `DENO_DIR`, because Deno resolves
its global cache directory before it evaluates anything and there is no home directory to infer one
from. The container gets a reaping PID 1 through `--init`; without it the descendants killed by the
process-group timeout test are reparented to `npm`, which never reaps them, and the supervisor reads
the resulting zombies as a group that survived SIGKILL. The read-only root leaves the `/tmp` tmpfs as
the container's scratch space, carrying the candidate tarballs, the extracted packages, the temporary
workspaces, and the npm cache at the same time; a measured run peaks at 2.43 GiB there, and a smaller
tmpfs fails the lane late with `ENOSPC` rather than on the candidate.

The live canary uses the frozen yt-dlp upstream test identity `YE7VzlLtp-4`, disables media
downloads and remote components, and must record actual packaged-Deno challenge execution. Its
evidence is bound to the public registry read-back and records the exact packaged yt-dlp, FFmpeg,
Deno, and EJS versions from the Toolchain Lock. It records no credential or raw unbounded process
output. `inconclusive` is blocking, including network and rate-limit outcomes. A clean result proves
only that one frozen extractor/challenge path worked at the recorded URL, time, and region; it is not
a supported-site guarantee.

The lane also decides *which* challenge solver source won. yt-dlp tries the installed `yt_dlp_ejs`
python package, its own cache, the vendored builtin, and finally a web download, and only the first
of those is frozen into the packaged executable; picking any other one still extracts today and
breaks silently the day that source goes away. The canary therefore runs its own invocation with
`--verbose` and requires both the `lib` and the `core` `Using challenge solver … script v… (source:
…)` line to name `python package` at exactly the Toolchain Lock's `yt-dlp-ejs` tag, read from the
packaged lock rather than a fixed string, and requires the absence of any `Remote component … was
skipped` or `No usable challenge solver …` line. The evidence carries this as the `solver-source`,
`solver-version`, and `solver-fallback` diagnostics.

A contradicting observation — the wrong source, the wrong version, or a skipped remote component —
is `fail`, and it outranks the transient reading, because re-running the lane reproduces it and a
live run routinely carries retry noise that would otherwise downgrade it to a retryable
`inconclusive`. A run that never logged a solver line at all is missing evidence rather than
contradicting it, so the transient branch still applies there and the lane stays retryable.

The version is compared against the Toolchain Lock rather than against the executable, and those are
pinned independently: the lock's `yt-dlp-ejs` tag describes the EJS release assets the `official-ejs`
gate runs, while the version yt-dlp reports comes from the `yt_dlp_ejs` package that upstream's own
requirements pin bundles into the executable. The gate at `test/platform-packages.test.ts` proves
that package is present but not which version it is, so a divergence surfaces here first and reads
as what it is: the Toolchain Lock no longer describes the solver the shipped executable runs.

`--verbose` belongs to the lane's own invocation only: it is never added to the node's production
argv, and the asserted text stays inside the lane, so ADR 0031's bar on reflecting process output to
the operator is unchanged.

`source-delivery` runs the release verifier before `publish-next`. It checks the direct versioned
GitHub source assets, their exact `.sha256` sidecar contents, clean isolated-rebuild evidence,
manual license-review bindings, component inventory, notices, licenses, and the passed Linux
runtime source gate.

The narrow real acceptance environment is approval-protected. Its operator runs the test on the
ADR 0033 acceptance stack and places the already-completed, candidate-bound evidence in the
protected `ACCEPTANCE_STACK_EVIDENCE_JSON` secret. The job itself runs no test and therefore needs
no privileged runner: it validates that the evidence is a clean pass, and it does not treat
environment approval alone as test proof. What binds the evidence to this release is its
`candidateSha256`, its `identities`, and the environment's required reviewer -- never the identity
of the machine that read the secret. Its `identities` object must contain the
candidate's exact `packages`, `source`, and `toolchain` values, a non-empty `test.id`, and the exact
official acceptance image reference in `images`. The acceptance test identity is exactly
`n8n-2.34.6-acceptance-stack`, and the only accepted image is the ADR 0033 n8n 2.34.6 digest
`sha256:f5140088385af2d4e681e177d8264bcb41e8fe126062030c5c65cd8f3e1605e1`.

## Publish and continuation

Publication is stage-only. Each of the three packages configures an npm Trusted Publisher that names
`publish.yml` in `aliyusufergin/n8n-nodes-yt-dlp` with the protected `npm-release` environment, and
that publisher is granted `npm stage publish` alone. The workflow therefore holds no npm token of any
kind and cannot publish directly; `publish_mode` offers `stage` and `verify-existing` and nothing
else. The long-lived granular token that published `0.2.0` existed only because package names that do
not exist yet cannot configure a Trusted Publisher. All three names are configured, the token is
revoked, and its environment is retired.

Dispatch with `main` at the exact release commit:

`gh workflow run publish.yml --ref main -f publish_mode=stage -f promote_latest=false`

The ref is not free: the environment's deployment branch policy admits `main` only, and
`RELEASE_WORKFLOW_REF` bakes it into the candidate's expected `publish.yml@<ref>` certificate
identity, so a tag ref both stalls at the environment gate and produces provenance the read-back will
not match. The `npm-release` environment's required reviewer approves `publish-next` only after
checking the exact commit and candidate digest.
The job stages the three candidate tarballs with provenance under `--tag next --access public` in
Platform Package → Platform Selector → main order. Staged versions are not public. A maintainer then
reviews each staged tarball in npm and approves it with npm 2FA; that human approval, not the
workflow run, is what publishes.

Those three approvals are separate, so a public partial or bad chain is the irreversible risk. Do not
unpublish. Remove or move the affected `next` tags, deprecate the exact published names, and release
a new lockstep patch. Any permission or unexpected result stops the release. When `publish-next`
itself fails, the `partial-publish-audit` artifact reports the exact published, missing, and
unexpected package names. Read it against where the run failed: on a first stage run nothing has been
approved yet, so all three read as missing and that is not a partial publication. It names a real
partial chain on a retry, where an already-approved package is public.

After the approvals, rerun the same release commit with `verify-existing`. That mode does not publish
again: it starts at registry read-back, then requires acceptance and generates
`release-evidence-0.2.1.json`. Read-back verifies all three public `next` identities, metadata,
dependency graph, tarball integrity, and Sigstore provenance. It fetches each DSSE provenance
statement and compares its subject digest, release workflow/repository, Git commit, and
GitHub-hosted builder identity to the expected candidate manifest. Before trusting those fields,
Sigstore verifies the bundle signature, transparency material, GitHub Actions issuer, and the exact
`publish.yml@<release-ref>` certificate identity.

Temporary resources are the protected environment secrets, hosted-runner workspaces, and
retention-bounded workflow artifacts. Delete `ACCEPTANCE_STACK_EVIDENCE_JSON` once the protected job
has passed.

Every lane must carry candidate-matching package, source, and tool identities plus a test/vector
identity; n8n lanes must also carry exact official image digests. The versioned evidence contains
those identities, the candidate commit, per-gate time and region, and only bounded redacted
diagnostics. Empty or mismatched identity objects, waivers, failures, and `inconclusive` results are
blocking. `RUNNER_REGION` must be a concrete configured region; empty, `unknown`, `unset`, and
`n/a` values fail closed. The evidence is uploaded once to the matching GitHub Release. An
existing asset is not overwritten.

## Promotion and rollback

Promotion is interactive and needs npm 2FA; no workflow holds a tag-changing credential. After the
evidence job passes, move `latest` in dependency order:
Platform Package, Platform Selector, then the main package last.
Main moves last because an install that resolves the main package mid-promotion
must never reach a selector or platform build that `latest` does not yet name.

```sh
npm dist-tag add n8n-nodes-yt-dlp-linux-x64@0.2.1 latest
npm dist-tag add n8n-nodes-yt-dlp-platform@0.2.1 latest
npm dist-tag add n8n-nodes-yt-dlp@0.2.1 latest
```

Then rerun the release commit once more with `verify-existing` and `promote_latest` enabled. That
run verifies the promotion rather than the staging that preceded it: registry read-back is given
`--promoted` and now requires all three `latest` tags to identify the candidate, where a run without
the flag refuses a candidate that `latest` already names. Promotion therefore happens before this
dispatch, never during it. The `promote-latest` job waits at the protected `npm-promotion`
Environment, performs unauthenticated read-back, and has no publication or tag-changing credential. `verify-promotion` verifies
the published-byte candidate directory first, so what it compares against the registry is the
read-back artifact rather than the checkout. For each of the three packages it records the full
dist-tag set, requires `latest` to identify the accepted version, and re-reads the registry metadata,
the tarball SHA-256 and integrity, and the Sigstore provenance. It then re-reads the Corresponding
Source offer that promoted installs inherit: each versioned GitHub asset URL must still resolve, and
each `<asset>.sha256` sidecar must still name the digest the candidate recorded. The result is
uploaded as `gate-promote-latest`.

Rollback is tag-based and starts with the main package first so new installs stop selecting the bad
chain. Move or remove its `latest` and `next` tags, then do the same for the Platform Selector and
Platform Package. Mark every bad lockstep package version with `npm deprecate`, publish a new patch,
run the complete chain again, and promote that patch.

### Rollback rehearsal

The rehearsal runs before promotion, reads the live registry, and changes nothing. It runs no
`npm dist-tag`, no `npm deprecate`, and no `npm publish`. Record, in rollback order — main first —
what each restore would name, and confirm every one resolves:

```sh
for package in n8n-nodes-yt-dlp n8n-nodes-yt-dlp-platform n8n-nodes-yt-dlp-linux-x64; do
	npm view "$package" dist-tags --json
	npm view "$package@<previous>" version dist.integrity
done
```

The rehearsal passes when each package reports the exact version its `latest` would be moved back to,
that version is still installable, and the deprecation text and new patch version are written down
with the exact bad version strings.

### Executing a rollback

Run these only to roll a bad chain back — never as part of the rehearsal, and never before a bad
chain exists.

```sh
npm dist-tag add n8n-nodes-yt-dlp@<previous> latest
npm dist-tag add n8n-nodes-yt-dlp-platform@<previous> latest
npm dist-tag add n8n-nodes-yt-dlp-linux-x64@<previous> latest
npm deprecate n8n-nodes-yt-dlp@<bad> "Superseded by <patch>; see the release record."
```

Never use `npm unpublish` for rollback.
