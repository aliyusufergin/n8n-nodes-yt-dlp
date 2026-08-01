# n8n agent control plane

How an agent may operate the n8n instance for this repository through the official n8n MCP.

This document is operational. The vocabulary lives in `CONTEXT.md`; the reasoning behind the model lives in `docs/adr/0034-operator-side-namespace-scoped-n8n-control-plane.md`.

## Scope

The MCP surface is **operator-side only**. It is never a dependency of the product or of CI:

- `nodes/`, `credentials/`, `test/`, `e2e/`, `scripts/` and GitHub Actions never connect to the MCP, and never carry an n8n endpoint, API key or credential reference.
- The published npm packages have no MCP runtime dependency.
- The hermetic release gates (ADR 0025, ADR 0030, ADR 0032) are unchanged. MCP evidence feeds only the explicitly approved narrow real acceptance lane of ADR 0032. **MCP evidence alone never promotes a release to `latest`.**

Setting up, authenticating or reconfiguring the MCP connection is the operator's job. Do not create `.mcp.json`, and do not modify the user-level MCP connection.

## Ownership marker

The instance has a single personal project (team projects are not licensed), so agent resources and the operator's production workflows share one namespace. Ownership is therefore carried by the resource itself, and it is **repo-scoped** — another repository's agent resources are not this agent's to touch.

A workflow is agent-owned only when **all three** markers carry the slug `n8n-nodes-yt-dlp`:

| Marker      | Value                                  | Purpose                                                         |
| ----------- | -------------------------------------- | --------------------------------------------------------------- |
| Name prefix | `agent/n8n-nodes-yt-dlp/<lane>/<name>` | Visible in every list and preview; the cheap pre-mutation check |
| Tag         | `agent:n8n-nodes-yt-dlp`               | Machine query via `search_workflows`                            |
| Folder      | `agent-owned/n8n-nodes-yt-dlp`         | Human-visible fence in the n8n UI                               |

The slug is derived from the git remote, never typed from memory.

### Guard

Before **any** mutating call, verify the marker:

- All three present and slug-matched → the resource is this agent's; mutation allowed.
- `agent-owned`-looking but the slug is absent or different → **another repository's agent owns it**. Hard read-only.
- Partial match (e.g. right name, missing tag) → **stop**. Do not mutate, do not silently repair the missing marker, report the exact state.
- No markers → an operator resource. Hard read-only.

## Lanes

The `<lane>` segment is `<purpose>/<issue>`.

- `purpose` comes from a fixed vocabulary: `dev` (exploration, disposable, never evidence) or `acceptance` (produces release-gate evidence).
- `issue` is the tracker issue the work belongs to, e.g. `issue-23`.
- There is **no `production` lane**. Production is the operator's own workflows, and they are read-only to the agent.

```
agent/n8n-nodes-yt-dlp/acceptance/issue-23/e2e-download
agent/n8n-nodes-yt-dlp/dev/issue-23/scratch-probe
```

## Authority

Inside the marked namespace the agent is free — including `publish_workflow` and `execute_workflow` — and does not ask per call:

- `create_workflow_from_code`, `update_workflow`, `archive_workflow`
- `test_workflow`, `execute_workflow`
- `publish_workflow`, `unpublish_workflow`
- `restore_workflow_version`

Outside the namespace **no mutation of any kind** is permitted. This includes `execute_workflow`: running an operator workflow is not a read, it produces real side effects.

## Reading outside the namespace

Reading operator resources is unrestricted — structure, tags, folders, pinned data and execution payloads via `search_executions` / `get_execution`. This is deliberate: it makes name collisions and existing patterns visible.

The redaction contract applies to **output**, not to reading. Nothing read from an operator resource is copied into the repository, into an issue comment, or into any published artifact.

## Credentials

The MCP exposes only `list_credentials` — there is no create, update or delete surface, so credentials are structurally operator-owned.

The agent must not scan `list_credentials` and attach whatever looks right. When a workflow needs a credential, the agent stops and asks which one; the operator names it in that session, and only that credential ID is wired. Credential **values** are never requested, read, logged or written to the repository.

## Data Tables

Data Tables carry no tag or folder surface, so the name is the only marker:

```
agent__n8n-nodes-yt-dlp__<lane>__<name>
```

The agent creates and writes only tables matching that pattern. Every other table is hard read-only — no row inserts, no column add/rename/delete, no table rename.

The MCP has no delete-table tool. When a lane closes the agent cannot remove its tables; it leaves a note on the issue that manual cleanup is required.

## Lifecycle

- **Session start** — list the agent's own slug-scoped resources. Report anything unexpectedly published; do not silently correct it.
- **Session end** — `unpublish_workflow` every agent-owned workflow the session published. No unattended trigger, webhook or schedule is left firing. The workflow body stays, so the next session builds on it.
- **Lane close** — when the lane's issue closes, `archive_workflow` the lane's workflows. Data Tables are flagged for manual cleanup.

## Evidence

An **acceptance** run leaves durable evidence as a fixed-format comment on the lane's GitHub issue. n8n executions may be pruned by retention settings, so the comment transcribes the facts rather than pointing at an execution ID alone.

```
### Acceptance run — <lane>
workflow:   <workflowId> @ <versionId>
execution:  <executionId>
result:     pass | fail | inconclusive
started:    <iso>  finished: <iso>
stack:      n8n <version> @ <image digest>  (main + worker)
nodes:      <node name> pass|fail  (one line each)
digests:    <tarball / image digests relevant to the gate>
```

Never copied into the comment: request or response payloads, binary data, raw stderr, worker paths, credential names or values.

A `dev` run produces no durable evidence.

`docs/release.md` or an ADR is updated only when a gate **outcome** or its wording actually changes — not per run.

## Failure behaviour

Fail-closed. On any unexpected result, error or permission failure:

1. Stop.
2. Report the exact remaining state: which call, which resource, what changed, what was left half-done.
3. No automatic retry, no workaround, no `sudo`, no permission repair.

Per ADR 0030, an acceptance run is classified `pass`, `fail` or `inconclusive` (external-service outage). The agent reports the classification it observed and must never convert one into another — a silent retry that turns `inconclusive` into `pass` invalidates the gate.

Rollback is not automatic. `restore_workflow_version` runs only when the operator asks for it.

## Server fallback

Some evidence the release gates need is outside the MCP: the running image digest (ADR 0033 rejects the mutable `stable` tag as evidence), container state, worker logs, published tarball bytes.

Acceptance stack, verified 2026-08-01 — n8n 2.32.7 at digest `sha256:882b126a8ddd0646e7d17ec47630e7704615e4647f3363471859fddc3f8946e2` on both main and worker, matching ADR 0033:

| Role         | Target                                        |
| ------------ | --------------------------------------------- |
| SSH host     | `sunucumweb`                                  |
| Main         | `n8n`                                         |
| Worker       | `n8n-n8n-worker-1`                            |
| Task runners | `n8n-n8n-runner-1`, `n8n-n8n-worker-runner-1` |
| Redis        | `n8n-redis-1`                                 |
| Postgres     | `n8n-postgres-1`                              |

### Allowed commands

A fixed, read-only list. The agent may not extend it on its own.

```
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect <container> --format '{{index .RepoDigests 0}}'
docker image ls --digests
docker logs --tail <n> <container>
docker exec <container> n8n --version
npm view <package>@<version> dist.integrity
git and gh read-only commands
```

### Forbidden

`restart`, `up`, `down`, `pull`, `prune`, `rm`, interactive `exec -it`, `sudo`, `chmod`, `chown`, and any permission repair. Any command outside the list requires an exact preview and fresh approval before it runs.

Command output is recorded as a bounded, redacted summary. Raw logs are not pasted into the repository or into an issue.
