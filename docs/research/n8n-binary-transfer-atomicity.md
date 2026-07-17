# n8n binary transfer atomicity

Accessed: 2026-07-17

## Version anchors

- n8n tag: `n8n@2.27.4`, commit [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485).
- Acceptance image: `docker.n8n.io/n8nio/n8n@sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d`.
- n8n documentation pages are unversioned current documentation; findings below therefore record the access date and defer to tagged source for the 2.27.4 contract.

## Findings

1. **Kanıtlanmış platform gerçeği:** The public `BinaryHelperFunctions.prepareBinaryData()` contract accepts a `Buffer | Readable`, optional filename, and optional MIME type. It exposes no binary delete or rollback operation to a community node. Sources: [`interfaces.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/workflow/src/interfaces.ts) and [`binary-helper-functions.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/execution-engine/node-execution-context/utils/binary-helper-functions.ts), n8n 2.27.4.

2. **Kanıtlanmış platform gerçeği:** `prepareBinaryData()` stores each call independently through `BinaryDataService.store()` and tags it with the current workflow and execution IDs. `BinaryDataService` has internal deletion methods, but they are not part of the public node helper interface. Source: [`binary-data.service.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/binary-data/binary-data.service.ts), n8n 2.27.4.

3. **Kanıtlanmış platform gerçeği:** The database manager consumes a complete stream into a Buffer, checks the configured per-file database limit, and inserts one row per call. There is no multi-file transaction in this interface. Its execution-level deletion removes all rows associated with selected execution IDs. Source: [`database.manager.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/binary-data/database.manager.ts), n8n 2.27.4.

4. **Kanıtlanmış platform gerçeği:** Queue mode defaults to `database` binary mode in n8n 2.27.4 tagged source; regular mode defaults to `filesystem`. The database per-file limit defaults to 512 MiB. Source: [`binary-data.config.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/binary-data/binary-data.config.ts), n8n 2.27.4.

5. **Kanıtlanmış platform gerçeği:** n8n's current binary-data documentation says queue mode must use `database` because `filesystem` is unsupported. The current queue-mode page instead directs persisted queue-mode binary data to S3. S3 external storage is documented as a self-hosted Enterprise feature. Sources: [binary data](https://docs.n8n.io/hosting/scaling/binary-data/), [queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/), and [external storage](https://docs.n8n.io/hosting/scaling/external-storage/), unversioned, accessed 2026-07-17.

6. **Kanıtlanmış platform gerçeği:** Hard-deleting an execution calls binary deletion for that execution. Rolling pruning is enabled by default, with a 336-hour age threshold, a one-hour hard-delete buffer, and periodic soft/hard deletion. Sources: [`execution-persistence.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/executions/execution-persistence.ts), [`executions-pruning.service.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/cli/src/services/pruning/executions-pruning.service.ts), and [`executions.config.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/%40n8n/config/src/configs/executions.config.ts), n8n 2.27.4.

7. **Ürün kararı:** ADR 0021 requires queue mode with database binary mode for v1 Doğrulanmış Destek. Filesystem mode is unsupported with queue mode. S3 remains outside Doğrulanmış Destek until a licensed exact-version E2E environment is available.

8. **Ürün kararı:** After process success and validation of every final file, transfer Artifact files sequentially through only `prepareBinaryData(createReadStream(...), basename, mimeType)`. Do not import or resolve n8n internal storage/deletion services.

9. **Ürün kararı:** Atomik İndirme İsteği guarantees output atomicity, not backend-storage transactionality. If any transfer in a request fails, return no Artifact Item for that request. With `Continue On Fail`, emit one `BINARY_TRANSFER_FAILED` Failure Item and continue with later input items; otherwise fail the node execution.

10. **Lisans/güvenlik riski:** If a later file transfer fails, earlier rows already written for that request cannot be synchronously rolled back through the supported node API. They may retain media or authentication-derived content until the execution is deleted/pruned. Internal deletion APIs must not be used because they are unsupported host internals and execution-wide deletion could affect other nodes.

11. **E2E ile doğrulanacak varsayım:** Exact-image queue-mode E2E must inject failure on the nth Artifact transfer and prove: no Artifact Item for that request, correct Continue On Fail behavior, prior/later input behavior, no local workspace residue, the exact number of unreferenced database rows, and their removal when the owning execution is hard-deleted/pruned.

12. **Cevapsız soru:** Immediate multi-Artifact backend rollback is not available in the n8n 2.27.4 public node contract. Supporting S3 or any future transactional storage guarantee requires a separate backend-specific E2E and contract review.
