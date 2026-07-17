# Acceptance worker resource envelope

Accessed: 2026-07-17

## Version anchors

- n8n tag: `n8n@2.27.4`, commit [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485).
- Acceptance image: `docker.n8n.io/n8nio/n8n@sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d`.

## Read-only acceptance environment evidence

- Worker container: `n8n-n8n-worker-1`, service `n8n-worker`.
- Visible CPUs: 4.
- Visible memory: 8,138,048 KiB (about 7.76 GiB).
- Available filesystem space at inspection: 34,113,788 KiB (about 32.5 GiB).
- Docker memory, swap, NanoCPU, and PID limits: unset/unlimited in the inspected container configuration.
- `EXECUTIONS_TIMEOUT`, `EXECUTIONS_TIMEOUT_MAX`, `N8N_DEFAULT_BINARY_DATA_MODE`, and `N8N_CONCURRENCY_PRODUCTION_LIMIT`: unset. No secret-bearing environment fields were read.

## Findings

1. **Kanıtlanmış platform gerçeği:** n8n 2.27.4 worker CLI concurrency defaults to 10 when no production-concurrency environment override is active. Source: [`worker.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/commands/worker.ts#L26).

2. **Kanıtlanmış platform gerçeği:** In database binary mode, `DatabaseManager.copyByFilePath()` reads the complete file into a Buffer before checking the configured database size and inserting it. Stream input is also converted to a complete Buffer. Source: [`database.manager.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/binary-data/database.manager.ts), n8n 2.27.4.

3. **Kanıtlanmış platform gerçeği:** Queue mode defaults to database binary mode in tagged source when no explicit mode is set. Database max file size defaults to 512 MiB and its schema maximum is 1024 MiB. Source: [`binary-data.config.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/binary-data/binary-data.config.ts), n8n 2.27.4.

4. **Ürün kararı:** ADR 0019 defines the exact v1 Resource Envelope. Workflow parameters may lower or raise defaults only within those immutable hard caps.

5. **Ürün kararı:** If no playlist selection is supplied, the node selects entries 1 through 5. User selection must have a statically computable cardinality of at most 20. Open-ended or data-dependent selection is rejected.

6. **Ürün kararı:** Workspace apparent size is polled at least once per second and may not exceed twice the configured final-total limit plus 64 MiB. Known remote files also receive a node-controlled yt-dlp max-filesize value. Final limits are rechecked from opened descriptors before binary transfer.

7. **Lisans/güvenlik riski:** Polling and yt-dlp's max-filesize option cannot provide a kernel-enforced disk quota; fast writes can overshoot between samples, post-processing can temporarily duplicate data, and SIGKILL/container failure bypasses JavaScript cleanup.

8. **Lisans/güvenlik riski:** Ten concurrent 256 MiB database copies can theoretically retain about 2.5 GiB of binary buffers before accounting for n8n, yt-dlp, FFmpeg, PostgreSQL, and OS memory. Hard caps do not prove the current concurrency safe.

9. **E2E ile doğrulanacak varsayım:** Exact-image load tests must exercise ten concurrent worst-allowed requests, database transfer, FFmpeg thread restriction, timeout/limit termination, disk overshoot, and cleanup while measuring worker/container/host memory, CPU, disk, event-loop health, and queue latency.

10. **Cevapsız soru:** If concurrency 10 fails the load acceptance gate, deployment must change worker concurrency/topology rather than silently increasing node risk. Any server configuration change requires a separate, operation-specific approval and rollback plan.
