# Operator observability boundary

Accessed: 2026-07-17

## n8n anchors

- `n8n@2.0.0`, commit [`a8ecda44f7627630bc8b78cf671405157ad41c4f`](https://github.com/n8n-io/n8n/tree/a8ecda44f7627630bc8b78cf671405157ad41c4f)
- `n8n@2.27.4`, commit [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485)
- `n8n@2.30.7`, commit [`1e2d027d6d239a55fc95598179e2a25d47e78c9b`](https://github.com/n8n-io/n8n/tree/1e2d027d6d239a55fc95598179e2a25d47e78c9b)

## Findings

1. **Kanıtlanmış platform gerçeği:** At all three anchors, the programmatic node execution contract exposes `logger`, `getExecutionId()`, and cancellation APIs. `Logger` accepts `debug`, `info`, `warn`, and `error` calls with arbitrary structured metadata. Sources: [`2.0.0 interfaces.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/workflow/src/interfaces.ts#L903), [`2.27.4 interfaces.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/workflow/src/interfaces.ts#L996), and [`2.30.7 interfaces.ts`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/workflow/src/interfaces.ts#L1055).

2. **Kanıtlanmış platform gerçeği:** The execution context returns n8n's process logger directly and exposes the execution ID separately; the node must therefore add its own stable event metadata if it needs request-level correlation. Sources: [`2.0.0 node-execution-context.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/core/src/execution-engine/node-execution-context/node-execution-context.ts#L65), [`2.27.4 node-execution-context.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/execution-engine/node-execution-context/node-execution-context.ts#L63), and [`2.30.7 node-execution-context.ts`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/core/src/execution-engine/node-execution-context/node-execution-context.ts#L63).

3. **Kanıtlanmış platform gerçeği:** Current official n8n documentation says JSON logging emits one object per line with message, level, timestamp, and metadata. Log level defaults to `info`; `debug` is the most verbose. Source: [Logs environment variables](https://docs.n8n.io/hosting/configuration/environment-variables/logs/), current documentation accessed 2026-07-17.

4. **Kanıtlanmış platform gerçeği:** n8n's Prometheus endpoint is disabled by default. Main and worker instances can expose metrics; optional queue metrics on main include active, completed, failed, and waiting jobs. n8n warns that the metrics endpoint can reveal operational data and must not be public. Source: [Enable Prometheus metrics](https://docs.n8n.io/hosting/configuration/configuration-examples/prometheus/), current documentation accessed 2026-07-17.

5. **Kanıtlanmış platform gerçeği:** With `QUEUE_HEALTH_CHECK_ACTIVE`, worker `/healthz/readiness` reports DB and Redis connection readiness. It does not document Community Package presence or packaged executable attestation as part of readiness. Source: [Queue mode — Worker server](https://docs.n8n.io/hosting/scaling/queue-mode/#worker-server), current documentation accessed 2026-07-17.

6. **Kanıtlanmış platform gerçeği:** n8n worker concurrency defaults to ten and n8n recommends five or higher, warning that many low-concurrency workers can exhaust database connections. This generic guidance does not establish safe yt-dlp/FFmpeg capacity; ADR 0019's exact-image load gate remains the product-specific evidence. Source: [Queue mode — Configure worker concurrency](https://docs.n8n.io/hosting/scaling/queue-mode/#configure-worker-concurrency), current documentation accessed 2026-07-17.

7. **Ürün kararı:** Do not start a node-owned HTTP server, Prometheus endpoint, background reporter, or telemetry exporter in v0.2.0. The node uses only n8n's public logger and stable workflow Result contract; infrastructure monitoring remains outside the package process.

8. **Ürün kararı:** Emit a bounded, structured terminal event per Download Request: success at `debug`, expected request failure at `warn`, and global invariant failure at `error`. Emit one execution summary at `info`. Stable metadata is limited to event schema version, package/toolchain version, execution ID, zero-based input index, outcome/error code, duration, artifact count, and final byte count. Cancellation is a distinct terminal outcome. Do not log Source URL, Arguments, filename/title/extractor, credential/proxy/header/cookie values, argv/environment, stdout/stderr, worker path, or stack. No progress event is logged.

9. **Ürün kararı:** The operator runbook must monitor n8n main/worker health, queue active/waiting/failed trends, worker/container CPU and RSS, worker writable-layer/temp free space, Postgres/Redis health, and binary-storage/database growth. Alerts and capacity thresholds are deployment-specific and cannot be shipped as universal node defaults. The package documents ADR 0019 hard caps and requires exact-topology load evidence before production sizing.

10. **Ürün kararı:** Worker `/healthz/readiness` must not be described as toolchain readiness. ADR 0029 attestation is lazy and the first real node invocation can still fail before starting yt-dlp. Release tests prove every worker with an explicit node execution; production operators diagnose toolchain failures through the global error code plus bounded structured log, not by treating `/healthz/readiness` as a package probe.

11. **Lisans/güvenlik riski:** Execution IDs and operational measurements are not authentication secrets, but they are internal identifiers and capacity signals. Metrics and logs must remain access-controlled; arbitrary user inputs and yt-dlp output must never become labels or log metadata because they can leak secrets, create unbounded cardinality, and forge multiline logs.

12. **E2E ile doğrulanacak varsayım:** Exact-anchor tests must capture JSON logs and prove event cardinality, levels, field schema, correlation, absence of forbidden values, cancellation classification, and one summary under success, Continue On Fail, global failure, and multi-item execution. They must also prove no progress-volume amplification.

13. **Cevapsız soru:** Concrete CPU/RSS/disk/queue alert thresholds and safe worker topology are **doğrulanmadı** until ADR 0019's load test runs against the frozen official image and the acceptance topology. These values belong in a versioned operator capacity record, not in v0.2.0 code defaults.
