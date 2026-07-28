# n8n 2.x Release Gate Matrix

This disposable matrix installs the exact locally packed `0.2.0` package chain
through n8n's real Community Packages REST controller. Every anchor runs the
same unmodified n8n main and worker topology with Postgres, Redis, queue mode,
offloaded manual executions, production executions, and database binary
storage.

The release-candidate cut on 2026-07-17 froze these official Linux x64 images:

| Role               | Exact n8n version | Exact Linux x64 image digest                                              |
| ------------------ | ----------------- | ------------------------------------------------------------------------- |
| 2.x floor          | 2.0.0             | `sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795` |
| Acceptance         | 2.27.4            | `sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1` |
| Frozen stable head | 2.30.7            | `sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060` |

The Uyumluluk Hedefi remains `>=2.0.0 <3.0.0`. Doğrulanmış Destek is limited
to the exact anchors above after all three lanes pass; the matrix does not
claim that every intermediate 2.x patch was tested. n8n 2.30.8 and every n8n
release after the cut, including 2.32.5, are unverified for `0.2.0`. A later
node release must advance and refreeze the stable-head anchor.

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
- direct, FFmpeg, playlist, credential/proxy, Continue On Fail, cancellation,
  resource/output limit, Nth-transfer, pruning, log, and cleanup outcomes.

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
