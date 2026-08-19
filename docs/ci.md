# Pull request verification gate

ADR 0035 records the decision behind this gate.

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
- `enforce_admins: false` — an explicit owner decision (ADR 0035): the repository owner keeps a
  manual escape hatch, so the gate makes an accidental merge onto red impossible without claiming to
  stop a deliberate one. Everything else merges only on green.

`publish.yml` stays `workflow_dispatch`-only and is unaffected.

## Proof that the gate blocks

A green check proves the workflow runs; it does not prove the gate stops a merge. Both were observed
under the settings above:

| Pull request | `verify` | `mergeStateStatus` | merge API |
| --- | --- | --- | --- |
| #63 (clean) | success | `CLEAN` | not attempted |
| #64 (head commit red on purpose) | failure | `BLOCKED` | not attempted |
| #65 (head commit red on purpose) | failure | `BLOCKED` | refused, HTTP 405 |

`mergeable` was `MERGEABLE` throughout, so the block came from the required check, not from a
conflict or a missing base. #64 failed all three commands in one run — the `!cancelled()` guard is
what makes typecheck, lint, and test each report instead of only the first. On #65 the merge API was
called directly, with `enforce_admins` temporarily on so the owner's bypass could not mask the
result:

```text
PUT /repos/aliyusufergin/n8n-nodes-yt-dlp/pulls/65/merge
HTTP/2.0 405 Method Not Allowed
{"message":"Required status check \"verify\" is failing."}
```

`main` stayed on the same commit. Both throwaway pull requests were closed unmerged and
`enforce_admins` was restored to `false`.

To re-prove this later, open a throwaway PR whose head commit breaks one command on purpose (an
unused binding fails `npm run lint`; `expect(1).toBe(2)` fails `npm test`), turn `enforce_admins` on,
call the merge API, and read the refusal. Restore `enforce_admins` and close the PR without merging.
Do not attempt the merge with `enforce_admins` off: admin bypass would merge the red commit for
real.
