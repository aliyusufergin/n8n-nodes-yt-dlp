# n8n 2.x Release Gate Matrix

This disposable matrix installs the exact locally packed `0.2.0` package chain
through n8n's real Community Packages REST controller. Every anchor runs the
same unmodified n8n main and worker topology with Postgres, Redis, queue mode,
offloaded manual executions, production executions, and database binary
storage.

These official Linux x64 images are frozen for the matrix. The floor and acceptance
rows were frozen at the 2026-07-17 release-candidate cut; the stable-head row was
refrozen on 2026-08-13 (see the note below the table):

| Role               | Exact n8n version | Exact Linux x64 image digest                                              |
| ------------------ | ----------------- | ------------------------------------------------------------------------- |
| 2.x floor          | 2.0.0             | `sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795` |
| Acceptance         | 2.27.4            | `sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1` |
| Frozen stable head | 2.34.5            | `sha256:7e82936bc03d310ddb8759c361f4e225412f0c3daad8d4b4e0d10c7e034c1b11` |

The stable-head row was advanced on 2026-08-13 under ADR 0025's own advance
clause, from 2.30.7
(`sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060`) to
2.34.5, and refrozen at that date. The floor and acceptance rows are unchanged.

The Uyumluluk Hedefi remains `>=2.0.0 <3.0.0`. Doğrulanmış Destek is limited
to the exact anchors above after all three lanes pass; the matrix does not
claim that every intermediate 2.x patch was tested. Every n8n release after
2.34.5 is unverified for `0.2.0`, as is every intermediate patch between the
anchors. A later node release must advance and refreeze the stable-head anchor.

The hermetic registry is available only inside the disposable Docker network.
It presents the exact packed tarballs at n8n's default
`https://registry.npmjs.org` address using a run-specific CA. This exercises
the normal unlicensed registry path without publishing, unpacking packages
into n8n volumes, changing the n8n image, or enabling lifecycle scripts.

Run:

```bash
npm run test:e2e:release-gate
```

Run only the acceptance anchor while developing:

```bash
npm run test:e2e:n8n-2.27.4
```

The lane requires Linux x64, OpenSSL, and a Docker daemon. It uses ports 15678
and 18080 by default; override them with `E2E_N8N_PORT` and
`E2E_FIXTURE_PORT`.

On success, bounded evidence is written under
`.generated/<version>/evidence/n8n-<version>.json`. Each anchor records:

- the exact n8n version, role, Linux x64 image digest, and image-index digest;
- SHA-256 and sizes for the main, selector, and Linux-x64 tarballs;
- exact package state in main and every worker used by the anchor;
- frozen-head online propagation, recreated/late-worker recovery, isolated
  package mounts, queue-versus-node readiness, and fail-closed toolchain
  evidence;
- production/manual Result equivalence and database binary IDs;
- direct, FFmpeg, playlist, credential/proxy, Continue On Fail, error-output
  branching, cancellation, resource/output limit, Nth-transfer, pruning, log,
  and cleanup outcomes.

The error-output scenario pins what `onError: continueErrorOutput` really does.
n8n's engine owns that output: `handleNodeErrorOutput` overwrites it with the
items it recognises as errors on the earlier outputs, so a node cannot write it
and the three-field Failure Item is never recognised. The lane runs the node in
that mode with its **Error** output wired to a downstream node and asserts that
the Failure Item stays on the regular output, that the error branch is empty and
its handler never ran, and that the node emitted the dead-branch warning hint
(issue #44).

The output-limit proof is the approved controlled-process seam because the V1
workflow surface cannot intentionally make the immutable packaged yt-dlp emit
eight MiB of process output. The Nth-transfer proof adds a disposable Postgres
constraint at the real `binary_data` boundary because n8n 2.0.0 cannot parse
its numeric database-size environment setting; the constraint is removed in
`finally`. All other listed scenarios run through the real queue worker. The
stack and all named volumes are removed in `finally`; the ignored versioned
`.generated` directories contain only local tarballs, fixtures, run-specific
certificates, registry request logs, and evidence.

The frozen-head anchor also runs the scale/recovery lane reserved by ADR 0025.
Two online workers receive the install event and each accepts a forced queue
execution. One worker is then recreated with an empty, isolated package volume,
and a third worker joins late with another empty volume. Both recover the
database-recorded exact package version through
`N8N_REINSTALL_MISSING_PACKAGES=true` before their node executions pass. The
lane separately records worker `/healthz/readiness` as
`database-and-redis-only` and records exact package plus real execution proof as
node readiness; the health endpoint is never treated as toolchain readiness.
Corrupt, wrong-version, and missing packaged toolchains must remain global
failures, make no fixture-media request, and leave a PATH fallback sentinel
unused. Worker package volumes are distinct, and media crosses only the
database binary-data boundary rather than a shared worker directory or
container.

The frozen-head anchor also runs the issue-18 capacity/failure lane. One worker
accepts ten concurrent requests whose first Artifact reaches the 256 MiB
individual hard cap and whose second Artifact exercises packaged FFmpeg with
the forced one-thread restriction. The lane samples worker/main/Postgres/Redis
container CPU and memory, worker-process RSS, host CPU and memory, temp disk,
event-loop metrics, queue latency, logical binary growth, Postgres size, and
Redis memory. It then hard-deletes the executions through n8n's public REST
surface and verifies pruning without an internal deletion API.

The lane's process observer reads `docker top` every 100 ms and requires every
packaged yt-dlp and FFmpeg process to carry the forced one-thread restriction.
A process sampled inside its execve window already reports its new `comm` while
`/proc/<pid>/cmdline` is still unwritten, which `ps` renders as the bracketed
comm. That read carries no argv to check, and counting it produced a false
violation at 2.34.5. The observer now marks such a row as an unwritten argv and
reports it as `ytDlpArgvUnwrittenTotal` or `ffmpegArgvUnwrittenTotal`, never as
a violation and never as a pass — it is excluded from the restriction counts in
both directions.

This does not relax the invariant. The kernel publishes the argument vector in
one step, so a sampled row is either bracketed or complete and never half a
command line; a real invocation of either program always carries a full
argument vector. The restriction is an unconditional argv the node builds on
its only spawn path, so a genuinely unrestricted process is measurable the
first time it is sampled and still fails the lane, however briefly it runs.
Only a process the observer cannot measure at all is excluded, and an
unmeasured process is not evidence of a violation.

Refusing violations is not the same as proving the restriction. Every capacity
run recorded `ffmpegProcessPeak: 0`, and the cause was the observer, not the
sampling rate: it named processes by `comm`, which never says `ffmpeg` here.
The Platform Paketi ships each tool as a launcher at `bin/<tool>` that execs
the bundled loader with the real payload, so the kernel takes the name from the
loader — a packaged FFmpeg reports `ld-linux-x86-64` and a packaged yt-dlp
reports `ld-musl-x86_64.`. yt-dlp was visible only by accident, through the
child its PyInstaller bootloader forks, which does report `yt-dlp`. The single
FFmpeg observation an earlier run recorded was the launcher caught inside its
own execve window, not FFmpeg. Observed with `docker top` inside the pinned
image, the postprocessor row is:

```text
ld-linux-x86-64  …/runtime/glibc/ld-linux-x86-64.so.2 --library-path …/runtime/glibc …/bin/ffmpeg.gnu … -threads 1 …
```

The observer now resolves the executable from the argv instead: a bundled
loader names the payload it is about to run, after an optional `--library-path`
pair, and every other process names its executable in the first token. Reading
the executable rather than scanning the command line also keeps a yt-dlp
process from being read as FFmpeg because its own argv carries
`--ffmpeg-location`. Two consequences are worth reading in the evidence. One
packaged invocation is more than one process — the yt-dlp bootloader and its
PyInstaller child both count — so `ytDlpProcessPeak` is about twice the request
count and is not comparable with records written before this change. And a
loader read whose argv the kernel had not published yet cannot be attributed to
either tool, so it is reported as `unattributedArgvUnwrittenTotal` rather than
folded into a program's counts or dropped silently.

Not every packaged FFmpeg process does media work. The Toolchain Attestation
probes the binary with `-version` on first use in each main and worker process,
and yt-dlp asks it which bitstream filters it carries; both print and exit
without touching media, so ADR 0019's thread bound does not reach them and
counting them as violations would fail the lane on the node's own attestation.
An FFmpeg that works on media always names its input with `-i`, so a process
with no input is excluded from the restriction counts in both directions and
reported as `ffmpegWithoutMediaInputTotal` instead of being dropped.

ADR 0019 bounds FFmpeg's own threads, so the verdict now also requires a
packaged FFmpeg process that was sampled, whose argv was readable, that worked
on media, and that carried `-threads 1`. Sampling no such FFmpeg leaves
`ffmpegThreadsRestricted` false instead of passing on an inference, and a failed
verdict reports the offending command lines under
`ffmpegUnrestrictedCommandLines` rather than only a count — every argument
vector the node builds is secret-free, because secrets reach yt-dlp through its
stdin config.

A dedicated request makes that observation reliable rather than lucky. After
the load's measurements are taken, the lane re-encodes a twenty-second fixture
into another container with `--recode-video mkv` — the one postprocessing path
that cannot be a stream copy — and process-observes it. Six hundred frames
through one x264 thread keep FFmpeg alive for seconds rather than the tens of
milliseconds a merge of the one-second fixtures takes, so the evidence rests on
the frame count rather than on how fast the host's disk is, and the recorded
capacity envelope is unchanged because the load window has already closed. The
probe reports its own peak, unwritten-argv totals, and observation count under
`measurements.ffmpegThreadRestrictionProbe`, and its observations join the
load's for the verdict, so an unrestricted process fails the lane wherever it
was sampled.

Every resource sample reads the worker's `/metrics` endpoint from inside the
worker container, one second apart plus the latency of the sample's own Docker
commands. That endpoint returned a single `500` at 2.34.5 immediately after
`capacity:start` and threw away a whole 25-minute run before any evidence
existed. A single failed reading now costs its sample the `metrics` key alone:
the sample's container, host, process, storage, and temp-disk measurements come
from other sources and are kept, the status code and response body are reported
on the lane output as `capacity:metrics-reading-skipped`, and sampling
continues. The bounded evidence records every skipped reading, the longest
consecutive failure run, and the enforced budget under
`measurements.metricsSampling`.

This does not weaken the measurement. Nothing that decides the lane is
discarded: the host-memory, temp-disk, container, and worker-process extrema of
a skipped reading's own second are still sampled, which matters because the
endpoint is likeliest to fail exactly when the load is heaviest. Skipping is
bounded by both a consecutive budget of five readings and a whole-run budget of
fifteen, so the sixth consecutive or the sixteenth total failed reading fails
the lane rather than thinning the event-loop series indefinitely. A reading
that returns successfully but exposes no event-loop measurement counts as a
failed reading under the same budgets. Only a failure the endpoint itself
reported is tolerated — a served error status, an endpoint not yet listening,
or a reading without an event-loop measurement; a reading that fails because
the command or the worker container failed still fails the lane at once, so a
worker dying under load stays a headline result. The summary additionally
refuses to judge a run that retained no sample or no event-loop lag
measurement, so a degraded endpoint cannot silently produce an empty
measurement instead of a verdict.

Two slow requests are separately interrupted with SIGKILL. The first proves
that an aged, owner-verified workspace is removed by the next execution's stale
sweep without replacing the worker container. The second proves that targeted
worker recreation replaces only the affected container and restores exact
package/execution readiness. The bounded result is committed under
`docs/capacity/`; raw samples remain in the ignored generated evidence.

The release command runs every frozen anchor even if an earlier anchor fails,
then exits unsuccessfully with the complete failed-anchor list. Any failed or
skipped anchor blocks `latest` promotion; the Uyumluluk Hedefi must not be
silently narrowed around a failure.

This matrix does not claim public-registry acceptance. Issue #21 publishes the
immutable chain under `next`; issue #22 reruns the release matrix against those
public bytes.
