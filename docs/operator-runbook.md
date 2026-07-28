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

## Frozen-head v0.2.0 capacity decision

The [n8n 2.30.7 / node 0.2.0 capacity record](capacity/n8n-2.30.7-node-0.2.0.json)
classifies worker concurrency 10 as unsafe on its exact four-CPU, 16 GB disposable topology. Five
of ten concurrent worst-allowed requests failed and event-loop lag crossed the one-second gate.
Keep the v0.2.0 supported scope at worker concurrency 1 until a lower-concurrency disposable lane
passes. Do not raise the node Resource Envelope hard caps.

For that exact measured topology, alert when event-loop max lag exceeds 1 second, queue-latency p95
exceeds 30 seconds, worker container memory exceeds 4,627,365,888 bytes, host available memory
falls below 2 GiB, or worker temp free space falls below 6 GiB. These are versioned release gates
for the recorded topology, not universal defaults for other deployments.

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
