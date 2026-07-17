# Workflow-visible result contract

Accessed: 2026-07-17

## Version anchors

- n8n 2.0.0: [`a8ecda44f7627630bc8b78cf671405157ad41c4f`](https://github.com/n8n-io/n8n/tree/a8ecda44f7627630bc8b78cf671405157ad41c4f)
- n8n 2.27.4: [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485)
- n8n 2.30.7: [`1e2d027d6d239a55fc95598179e2a25d47e78c9b`](https://github.com/n8n-io/n8n/tree/1e2d027d6d239a55fc95598179e2a25d47e78c9b)

## Findings

1. **Kanıtlanmış platform gerçeği:** n8n's node-author documentation says a programmatic node must set `pairedItem` when n8n cannot infer item lineage; otherwise downstream expressions may break. Every Artifact Item and Failure Item therefore needs `pairedItem: { item: inputIndex }`. Source: [Item linking for node creators](https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-node-building/). The page is mutable and unversioned; the exact anchor interfaces below confirm the field shape.

2. **Kanıtlanmış platform gerçeği:** All three anchors define `IBinaryData` with required `data` and `mimeType`, plus optional `fileName`, `fileExtension`, and `fileSize`. All three define `INodeExecutionData` with `json`, optional `binary`, and optional `pairedItem`. Sources: [`2.0.0 interfaces.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/workflow/src/interfaces.ts#L56), [`2.27.4 interfaces.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/workflow/src/interfaces.ts#L65), and [`2.30.7 interfaces.ts`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/workflow/src/interfaces.ts#L66).

3. **Kanıtlanmış platform gerçeği:** `IBinaryData.bytes` is absent in 2.0.0 but present in 2.27.4 and 2.30.7. A `>=2 <3` workflow contract cannot rely on that helper-returned field. `sizeBytes` must come from the already verified artifact descriptor/stat result, not from version-dependent binary metadata. Sources: the exact `interfaces.ts` files above.

4. **Kanıtlanmış platform gerçeği:** At all three anchors, public `prepareBinaryData()` accepts a `Buffer | Readable`, an optional path/name, and an optional MIME type. It derives `fileName` from the supplied path. For a generic `Readable`, it does not inspect content; when neither the supplied MIME nor extension lookup resolves a type, it falls back to `text/plain`. Sources: [`2.0.0 binary-helper-functions.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/core/src/execution-engine/node-execution-context/utils/binary-helper-functions.ts#L231), [`2.27.4 binary-helper-functions.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/execution-engine/node-execution-context/utils/binary-helper-functions.ts#L244), and [`2.30.7 binary-helper-functions.ts`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/core/src/execution-engine/node-execution-context/utils/binary-helper-functions.ts#L244).

5. **Kanıtlanmış platform gerçeği:** Supplying a full local artifact path to `prepareBinaryData()` can populate binary `directory` metadata. Supplying only the validated basename avoids exposing the worker-local workspace while still setting `fileName`. This is an inference directly from the exact helper implementations above.

6. **Kanıtlanmış platform gerçeği:** n8n's current node-author error guidance shows per-item `continueOnFail()` handling as an output item with an error value and `pairedItem`; otherwise it recommends an item-indexed `NodeOperationError`. Source: [Error handling in n8n nodes](https://docs.n8n.io/integrations/creating-nodes/build/reference/error-handling/). This mutable page supports, but does not replace, ADR 0005's product-specific boundary.

7. **Ürün kararı:** Make the single main output a discriminated union. An Artifact Item is exactly `{ json: { status: "success", artifactIndex, artifactCount, fileName, mimeType, sizeBytes }, binary: { data }, pairedItem: { item: inputIndex } }`. Indices are one-based and artifacts retain ADR 0018's basename sort order. A Failure Item is exactly `{ json: { status: "error", errorCode, errorMessage }, pairedItem: { item: inputIndex } }` and has no binary data. Do not add a summary item or echo input data.

8. **Ürün kararı:** Pass the verified basename and an explicit MIME type to `prepareBinaryData()`. Resolve MIME from a versioned, dependency-free extension map for the media, subtitle, and thumbnail types the node recognizes; use `application/octet-stream` for every unknown extension. Do not content-sniff untrusted artifacts and do not inherit n8n's inaccurate unknown-stream `text/plain` fallback.

9. **Ürün kararı:** Freeze this request-scoped error-code set for v0.2.0: `INVALID_SOURCE_URL`, `INVALID_ARGUMENTS`, `YTDLP_FAILED`, `REQUEST_TIMEOUT`, `PROCESS_OUTPUT_LIMIT`, `RESOURCE_LIMIT`, `INVALID_ARTIFACT_SET`, and `BINARY_TRANSFER_FAILED`. `RESOURCE_LIMIT` covers request workspace/artifact count/single-file/total-size limits. Only known typed request failures may become Failure Items; cancellation, execution-wide limits, packaged-tool/process lifecycle invariants, cleanup failures, and unknown exceptions remain global errors.

10. **Ürün kararı:** `errorCode` is the stable routing contract; `errorMessage` is a short node-authored English explanation whose wording may improve between releases. Never place raw stdout/stderr, Source URL, Arguments, credential values, proxy data, environment, command/argv, workspace path, stack, or exception dump in either output shape. The bounded process tails from ADR 0020 remain in-memory diagnostics and are discarded rather than copied into workflow output.

11. **Lisans/güvenlik riski:** Extension-derived MIME is metadata, not proof of content safety. Downstream consumers must treat Artifact bytes as untrusted. Content sniffing would add parser/supply-chain surface and still would not make a downloaded file trusted.

12. **E2E ile doğrulanacak varsayım:** Each release-gate anchor must prove one-to-many `pairedItem` expression resolution, exact output keys and ordering, database-backed binary retrieval, known and unknown extension MIME behavior, one representative of every stable request error code, absence of forbidden values in serialized execution output, and no Failure Item on cancellation/global errors.

13. **Cevapsız soru:** The exact extension-to-MIME table is not yet implemented or tested. Its entries and fixtures must be reviewed with the final V1 artifact types; until that test exists, coverage of any particular extension is **doğrulanmadı** and the contractually safe result is `application/octet-stream`.
