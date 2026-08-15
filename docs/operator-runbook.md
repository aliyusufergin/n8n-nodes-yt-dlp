# Operator runbook

This node relies on n8n and the worker platform for capacity, queue, storage, and health
monitoring. Its Resource Envelope limits one execution; those hard caps are not sizing guidance
for a deployment.

The v0.2.1 supported topology is official n8n Docker Linux x64, queue mode, `database` binary
storage, and worker concurrency 1. Set `N8N_REINSTALL_MISSING_PACKAGES=true` on every worker as a
missing-package recovery aid. It is not a readiness check: verify the exact package chain and run
an authorized node execution before a worker accepts production traffic.

## Queue and worker monitoring

Monitor and alert on:

- active, waiting, completed, failed, retried, and stalled execution trends;
- queue wait time and end-to-end execution latency, including p50/p95/p99;
- online, busy, restarting, and missing worker counts;
- each worker's configured concurrency and the number of concurrent yt-dlp executions;
- install/update propagation of exact
  `n8n-nodes-yt-dlp` → `n8n-nodes-yt-dlp-platform` →
  `n8n-nodes-yt-dlp-linux-x64` versions; and
- node readiness proved by an authorized first-Artifact execution on every worker.

Worker `/healthz/readiness` establishes only n8n's documented database and Redis readiness. It
does not establish Community Package presence, exact package version, Toolchain Attestation, temp
capacity, or node execution readiness.

If queue depth or latency grows, stop admitting new download work before increasing worker
concurrency. Check worker CPU/RSS, event-loop lag, temp free space, Postgres, Redis, and binary
growth together. Do not raise the node Resource Envelope hard caps to treat a deployment capacity
problem.

## Container and host monitoring

For n8n main and each worker, record:

- process and container CPU;
- process RSS, container memory, cgroup limit/headroom, OOM kills, and restart count;
- event-loop lag and unresponsive-worker signals;
- host CPU saturation, load, available memory, and swap pressure;
- container writable-layer consumption; and
- yt-dlp/FFmpeg process counts, with FFmpeg threads and yt-dlp fragment concurrency remaining one.

Correlate container restarts or exit code 137 with the affected execution, worker, OOM events, and
owned temporary workspaces. A healthy host average can conceal one saturated worker; retain
per-worker measurements.

## Temp storage monitoring

The node creates owned Execution Workspaces under
`${os.tmpdir()}/n8n-nodes-yt-dlp` in the worker-local temporary layer. It does not write downloads
to the shared `.n8n` package volume.

Monitor each worker's temp filesystem and writable layer for:

- free bytes and free inodes;
- growth rate and peak usage during downloads/post-processing;
- filesystem errors, read-only remounts, and quota/cgroup limits; and
- workspaces older than the three-hour stale threshold.

Workspace usage is checked at least once per second and each request is bounded at twice its
configured final Artifact total plus 64 MiB, but filesystem accounting can overshoot between
samples. Keep operational headroom above that request boundary and account for concurrent n8n
workloads. Never use a general temporary-directory or Docker prune as node recovery.

## Postgres, Redis, and binary-storage monitoring

V0.2.1 Doğrulanmış Destek requires queue mode with `database` binary storage. Queue-mode
`filesystem` storage is unsupported and S3 is unverified.

Monitor Postgres for:

- connectivity, connection-pool saturation, query latency, locks, errors, and restarts;
- database and `binary_data` row/byte growth;
- execution retention, hard-delete, and pruning completion; and
- free storage, WAL growth, backup health, and restore capacity.

Monitor Redis for:

- connectivity, command latency, used memory, maxmemory headroom, and evictions;
- queue keys, waiting/active work, stalled jobs, and retry/failure trends; and
- persistence/restart events that correlate with queue anomalies.

Artifacts cross the public n8n binary helper one file at a time. Workflow output is atomic, but
the backend writes are not a transaction: if a later transfer fails, earlier writes may remain
unreferenced until normal execution hard-delete and pruning. Monitor that lifecycle through public
n8n operations. Do not use an internal binary deletion API.

## Frozen-head v0.2.1 capacity decision

The [n8n 2.34.5 / node 0.2.1 capacity record](capacity/n8n-2.34.5-node-0.2.1.json)
classifies worker concurrency 10 as unsafe on its exact four-CPU, 16 GB disposable topology. Two of
the ten concurrent worst-allowed requests completed; seven were lost to `BINARY_TRANSFER_FAILED`
and one to an unclassified failure, and event-loop lag peaked at 2.68 seconds against a one-second
gate. Keep the v0.2.1 supported scope at worker concurrency 1 until a lower-concurrency disposable
lane passes. Do not raise the node Resource Envelope hard caps.

The verdict is stable across the spread rather than resting on one run. The same anchor's node
0.2.0 record, [n8n 2.34.5 / node 0.2.0](capacity/n8n-2.34.5-node-0.2.0.json), completed all ten
requests and still failed the lane on a 1.25-second lag peak; runs before it lost five or six.
Request loss at this concurrency varies widely on this topology and is not by itself the deciding
signal — the lag gate is.

The previous frozen head kept its own record, [n8n 2.30.7 / node
0.2.0](capacity/n8n-2.30.7-node-0.2.0.json). It reached the same decision from five of ten failed
requests and is retained as historical evidence for that image only. Read thresholds from the
record matching your n8n version; they are not interchangeable.

For that exact measured topology, alert when:

| Signal | Recorded threshold (n8n 2.34.5) |
| --- | ---: |
| Event-loop maximum lag | greater than 1 second |
| Queue-latency p95 | greater than 30 seconds |
| Worker container memory | greater than 4,368,367,616 bytes |
| Host available memory | less than 2 GiB |
| Worker temp free space | less than 6 GiB |

On n8n 2.30.7 the corresponding worker-container-memory threshold was 4,627,365,888 bytes, and on
this anchor under node 0.2.0 it was 4,354,736,128. These are measured per run, so use the row from
the record matching the anchor and node version you run, not this table.

Every record sets `ffmpegThreadRestrictionProven` to `true`, but only the 2.34.5 records prove it
from FFmpeg itself. Issue #68 found why no earlier run ever sampled FFmpeg: the observer named
processes by `comm`, and a packaged tool never reports its own name there. Each tool is launched
through the bundled loader, so a packaged FFmpeg reports `ld-linux-x86-64` and a packaged yt-dlp
reports `ld-musl-x86_64.`; yt-dlp was counted only through the child its PyInstaller bootloader
forks. The observer now resolves the executable from the argv, and the lane refuses to prove the
restriction unless it sampled a packaged FFmpeg process that worked on media and whose readable
argv carried `-threads 1`.

The 0.2.1 record carries that observation: three such FFmpeg processes under load and one in the
dedicated `--recode-video` probe that runs after the load's measurements are taken, every one of
them restricted, with `ffmpegUnrestrictedCommandLines` empty across 297 process observations in 21
samples. The 0.2.0 record on this anchor reached the same result independently, from 436
observations in 28 samples, so the observation survives a change of node version rather than
resting on a single run.

The 2.30.7 record has no `measurements.ffmpegThreadRestrictionProbe` block, which is how you tell a
record written under the older rule: its boolean is yt-dlp-side evidence only, and it would not
earn the flag today. Read its `processObserver.ffmpegEvidenceLimit` before citing it as FFmpeg
evidence. Do not compare `ytDlpProcessPeak` across that change either: it now counts the yt-dlp
bootloader and its child, so 20 is ten concurrent requests. An FFmpeg that only reports its version
does no media work and is counted apart as `ffmpegWithoutMediaInputTotal`; the node's own
attestation probe is the usual source of those.

An earlier 2.34.5 run recorded `false` because one process observation out of 437 read a yt-dlp
process mid-`execve`, while `/proc/<pid>/cmdline` was still unwritten and there was no argv to
check. The observer now marks such a read as an unwritten argv and reports it as
`ytDlpArgvUnwrittenTotal`, `ffmpegArgvUnwrittenTotal`, or `unattributedArgvUnwrittenTotal` when the
read names a loader rather than a tool, excluded from the restriction counts in both directions.
That run is superseded in place, as is the one after it, and the chain is kept in the current
record's `supersedes` block. The invariant is unchanged: the kernel publishes a process's argument vector
in one step, so a real invocation is always measurable on the sample that saw it, and a genuinely
unrestricted process still fails the lane however briefly it runs. Do not relax the node's FFmpeg
thread restriction on the strength of either record.

These are versioned release gates for the recorded image, package bytes, four-CPU/16 GB host,
Postgres 16, Redis 7, database binary storage, and capacity workload. They are not universal
defaults for another deployment. Production sizing requires disposable load evidence from the
exact deployed topology. Preserve the raw evidence digest and a versioned decision record when
establishing different thresholds.

## Diagnose

The node emits one terminal event per İndirme İsteği and one execution summary through n8n's
public logger. Correlate by execution ID and zero-based input index. Stable fields include schema,
package/toolchain version, outcome/error code, duration, Artifact count, and final byte total.

Logs intentionally omit Source URL, Arguments, Artifact filename, credentials, proxy, argv,
environment, process output, workspace paths, stacks, and multiline user content. Do not weaken
this boundary to troubleshoot; reproduce with authorized synthetic media and use the stable error
code.

| Symptom | Checks and response |
| --- | --- |
| Node missing on one worker | Remove the worker from traffic. Check its exact three-package state and install/update event history. Confirm `N8N_REINSTALL_MISSING_PACKAGES=true`; restart or recreate only that worker if recovery is required, then run a real node probe. |
| Toolchain/global invariant failure | Stop routing work to the worker. Do not install a `PATH` tool, modify package bytes, run chmod, or enable runtime downloads. Compare exact package state and recreate the affected worker from the supported image. |
| Queue backlog or event-loop lag | Pause new download work. Check per-worker CPU/RSS, temp, Postgres, Redis, and binary growth. Keep concurrency at 1; scale only after equivalent disposable evidence. |
| `RESOURCE_LIMIT` or `REQUEST_TIMEOUT` | Check the input and configured request limits. Reduce the request or split inputs. Do not increase a field above its hard cap. |
| `BINARY_TRANSFER_FAILED` | Check Postgres health, free storage, database limits, and pruning. No Artifact Item was published for that request, but monitor for unreferenced writes until public execution hard-delete/pruning completes. |
| Cancellation or timeout appears stuck | Check the worker for the managed yt-dlp/FFmpeg/Deno process group and wait through the bounded SIGTERM/SIGKILL closure period. A termination invariant failure stops the execution globally. |
| Temp usage remains after a crash | Use the verified stale sweep below. If the node cannot run or the sweep fails, use targeted worker recreation. |

## Recover stale workspaces

Catchable completion, error, timeout, cancellation, and binary-transfer failure remove the current
request workspace automatically after process and stream closure.

After SIGKILL, OOM, runtime crash, or host failure:

1. Identify the affected worker from execution, container-exit, and temp metrics.
2. If the worker can run safely, route one authorized small probe to that same worker. At execution
   start, the node examines at most 100 direct children with its exact package prefix.
3. Confirm that owner-marker heartbeats older than three hours are removed and temp usage returns
   to baseline.
4. If the sweep reports `STALE_WORKSPACE_CLEANUP_FAILED`, stop routing work to that worker and use
   targeted recreation.

The sweep removes only roots verified as real directories owned by the current UID, with no
symlink path and with a regular, single-link, owner-only marker. Ambiguous roots are intentionally
left untouched. Do not manually broaden the match, recursively delete the temp root, or prune
unrelated container data.

## Targeted worker recreation

Use targeted recreation when an affected worker cannot run the stale sweep, cannot restore its
exact package/toolchain state, or has an uncatchable failure that leaves owned temp data:

1. Drain or remove only the affected worker from queue traffic.
2. Capture its exact image/package versions, exit/OOM evidence, execution ID, temp usage, and
   bounded node error code.
3. Recreate only that worker container from the supported exact n8n image with its normal isolated
   package volume and `N8N_REINSTALL_MISSING_PACKAGES=true`. Do not recreate Postgres, Redis, main,
   or healthy workers, and do not run a general Docker prune.
4. Wait for database/Redis readiness, then separately verify the exact three-package version.
5. Run an authorized first-Artifact execution on the recreated worker and confirm database binary
   round-trip, Toolchain Attestation, and owned-temp cleanup.
6. Return the worker to traffic only after both infrastructure readiness and the real node probe
   pass.

The disposable v0.2.0 recovery evidence confirms that targeted recreation replaced only the
affected worker, preserved unrelated containers, recovered the exact package, passed a real
execution, and left no owned Execution Workspaces.
