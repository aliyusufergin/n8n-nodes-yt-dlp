# n8n AI-tool binary boundary

Accessed: 2026-07-17

## Version anchors

- n8n 2.0.0: [`a8ecda44f7627630bc8b78cf671405157ad41c4f`](https://github.com/n8n-io/n8n/tree/a8ecda44f7627630bc8b78cf671405157ad41c4f)
- n8n 2.27.4: [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485)
- n8n 2.30.7: [`1e2d027d6d239a55fc95598179e2a25d47e78c9b`](https://github.com/n8n-io/n8n/tree/1e2d027d6d239a55fc95598179e2a25d47e78c9b)

## Findings

1. **Kanıtlanmış platform gerçeği:** All three anchor interfaces expose optional `usableAsTool?: true | UsableAsToolDescription` on a node description. The field means the node is wrapped for AI Agent tool use; absence leaves it as an ordinary main-connection node. Sources: [`2.0.0 interfaces.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/workflow/src/interfaces.ts#L2006), [`2.27.4 interfaces.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/workflow/src/interfaces.ts#L2377), and [`2.30.7 interfaces.ts`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/workflow/src/interfaces.ts#L2481).

2. **Kanıtlanmış platform gerçeği:** At every anchor, the normal-node AI-tool adapter rejects binary-only output as unsupported. When output items contain both useful JSON and binary, it discards binary, logs a warning, flattens only item JSON, and returns its JSON string to the Agent. Sources: [`2.0.0 get-input-connection-data.ts`](https://github.com/n8n-io/n8n/blob/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/core/src/execution-engine/node-execution-context/utils/get-input-connection-data.ts#L42), [`2.27.4 get-input-connection-data.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/execution-engine/node-execution-context/utils/get-input-connection-data.ts#L147), and [`2.30.7 get-input-connection-data.ts`](https://github.com/n8n-io/n8n/blob/1e2d027d6d239a55fc95598179e2a25d47e78c9b/packages/core/src/execution-engine/node-execution-context/utils/get-input-connection-data.ts#L147).

3. **Kanıtlanmış platform gerçeği:** ADR 0026's successful Artifact Item always contains both compact JSON metadata and `binary.data`. Under the exact adapter above, an AI Agent receives only the metadata; it does not receive the Artifact binary. The node can still perform network/process work and write binary storage before that reference is omitted.

4. **Kanıtlanmış platform gerçeği:** Current n8n documentation says AI models can dynamically fill tool parameters from task context and connected tools through `$fromAI()`. Source: [Let AI specify the tool parameters](https://docs.n8n.io/advanced-ai/examples/using-the-fromai-function/). This page is mutable and unversioned; the exact behavior and UI at every 2.x patch are not a compatibility guarantee.

5. **Kanıtlanmış platform gerçeği:** Current n8n documentation offers human approval before selected AI tool calls and shows reviewers the tool name and AI-specified parameters. Source: [Human-in-the-loop for AI tool calls](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/). HITL does not alter the adapter's binary omission. Availability and behavior of this current feature at the 2.0.0 floor are **doğrulanmadı**.

6. **Lisans/güvenlik riski:** Tool exposure would let a model choose any `$fromAI()`-enabled Source URL or Arguments field, initiating bounded but still costly outbound network, yt-dlp, Deno, FFmpeg, database-binary, and temporary-disk work. HITL can add governance but cannot make model-produced URLs trusted or restore omitted binary output.

7. **Ürün kararı:** Do not set `usableAsTool` in v0.2.0 and do not advertise the node as an AI Agent tool. This avoids a successful-looking operation whose primary result is silently unavailable to the caller. Ordinary main-connection workflows remain supported, including explicit upstream AI/model nodes whose outputs the workflow author deliberately maps into Source URL or Arguments.

8. **Ürün kararı:** Reopen AI-tool support only as a separately designed feature after n8n supplies an exact supported binary-tool contract or the project defines a different bounded JSON-only tool result with clear storage/reference lifecycle, authorization, human approval, and network/resource abuse controls. That would not be a metadata-only change.

9. **E2E ile doğrulanacak varsayım:** Release-gate tests must confirm the node is absent from AI-tool selection/wrapping at all three anchors while remaining available as an ordinary programmatic node. No AI Agent execution is part of v0.2.0 acceptance.

10. **Cevapsız soru:** Whether a future n8n 2.x patch adds a safe binary-capable AI-tool response is **doğrulanmadı** and cannot change the frozen v0.2.0 contract without a new release decision and E2E lane.
