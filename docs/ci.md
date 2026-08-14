# Pull request verification gate

`.github/workflows/pr-verification.yml` is the only automatic check on `main`. It runs on every
`pull_request` event and executes, in one `verify` job on `ubuntu-24.04` with Node 24.16.0:

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`

Lint and test run under `if: ${{ !cancelled() }}`, so a single run reports every failing command
instead of stopping at the first one.

The job checks out with `lfs: true` because the suite packs and inspects the real toolchain
binaries in `packages/linux-x64/bin`. `npm ci` installs from the committed lockfile. The runner is
fixed to `ubuntu-24.04`: the root `package.json` declares `"os": ["linux"], "cpu": ["x64"]`.

## What the gate deliberately does not do

- **No `test:e2e:*` lane.** Those need Docker, pinned images, and minutes of wall clock. They stay
  in the release gates described in `docs/release.md` (ADR 0025, 0030, 0032 are unchanged).
- **No secrets, no environments, no `id-token`.** `permissions` is `contents: read` only, so a pull
  request from any branch cannot reach publication credentials.
- **No tight time budget.** `timeout-minutes: 30` is deliberately loose. The suite runs ~5 minutes,
  nearly all of it in `test/release-candidate.test.ts`, which builds, packs three packages, and
  recompresses a 187 MB tarball with 7-Zip `-mx=9`. A narrow budget would make the gate flaky.

`test/pr-verification-workflow.test.ts` asserts these invariants, so the gate guards its own shape.

## Branch protection

`main` requires the `verify` status check:

```bash
gh api repos/aliyusufergin/n8n-nodes-yt-dlp/branches/main/protection --jq \
  '{checks: .required_status_checks.checks, strict: .required_status_checks.strict,
    admins: .enforce_admins.enabled}'
```

- `required_status_checks.checks` — `verify`
- `strict: false` — a PR does not have to be rebased onto the newest `main` before merging; with a
  five-minute suite the re-run cost outweighs the narrow race it would close.
- `enforce_admins: false` — the repository owner keeps a manual escape hatch. Everything else merges
  only on green.

`publish.yml` and `recover-bootstrap.yml` stay `workflow_dispatch`-only and are unaffected.

## Recorded proof that the gate blocks

A green check proves the workflow runs; it does not prove the gate stops anything. Both states were
observed under the settings above:

| Pull request | `verify` | `mergeStateStatus` |
| --- | --- | --- |
| #63 (clean) | success | `CLEAN` |
| #64 (head commit red on purpose) | failure | `BLOCKED` |

`mergeable` was `MERGEABLE` in both cases, so the block came from the required check, not from a
conflict or a missing base. #64 failed all three commands in a single run — the `!cancelled()`
guard is what makes typecheck, lint, and test each report instead of only the first one. It was
closed without merging.

## Re-verifying that the gate actually blocks

A green check proves the workflow runs; it does not prove the gate blocks. To re-prove the block,
open a throwaway PR whose head commit breaks one command on purpose (for example an unused import
that fails `npm run lint`), then confirm the PR reports `verify` as failing and that
`gh pr merge` is refused with a required-check error. Close the PR without merging.
