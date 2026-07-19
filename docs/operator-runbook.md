# Operator runbook

This node relies on n8n and the worker platform for capacity and health monitoring. Its Resource
Envelope limits one execution; those hard caps are not sizing guidance for a deployment.

## Monitor

- n8n main and worker health, plus active, waiting, and failed queue trends
- worker and container CPU and RSS
- free space in each worker writable layer and temporary filesystem
- Postgres and Redis health
- binary-storage and database growth

Alert thresholds and safe worker topology are deployment-specific. Do not infer them from the node
defaults. Production sizing requires load evidence from the exact deployed topology described by
ADR 0019.

Worker `/healthz/readiness` establishes only the documented database and Redis readiness. It does
not establish Community Package availability or Toolchain Attestation. Verify each worker with a
real node execution during release and deployment checks.

## Diagnose

The node emits one terminal event per Download Request and one execution summary through n8n's
public logger. Use the execution ID, zero-based input index, outcome, and stable error code for
correlation. Logs intentionally omit Source URL, Arguments, Artifact filename, credentials, proxy,
argv, environment, process output, workspace paths, stacks, and multiline user content.

## Recover worker-local space

Catchable outcomes remove request workspaces automatically. A later execution examines at most 100
owned roots under `${os.tmpdir()}/n8n-nodes-yt-dlp` and removes verified roots whose owner-marker
heartbeat is more than three hours old. Ambiguous roots are left untouched.

SIGKILL, OOM, runtime crash, and host failure cannot guarantee immediate cleanup. If the node will
not run again to perform stale recovery, recreate only the affected worker container. Do not use a
general temporary-directory or Docker prune as node recovery.
