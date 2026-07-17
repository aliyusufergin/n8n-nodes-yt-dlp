# Linux process lifecycle and output bounds

Accessed: 2026-07-17

## Version anchors

- n8n tag: `n8n@2.27.4`, commit [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485).
- Acceptance image: `docker.n8n.io/n8nio/n8n@sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d`, Node.js v24.16.0.

## Findings

1. **Kanıtlanmış platform gerçeği:** n8n 2.27.4 exposes the execution `AbortSignal` through `getExecutionCancelSignal()` and provides an execution-cancellation listener. Source: [`BaseExecuteContext`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/execution-engine/node-execution-context/base-execute-context.ts).

2. **Kanıtlanmış platform gerçeği:** On non-Windows systems, Node's `detached: true` makes a child the leader of a new process group and session. Node also documents that killing only a parent does not terminate its descendants on Linux. Source: [Node.js child process documentation](https://nodejs.org/api/child_process.html#optionsdetached).

3. **Kanıtlanmış platform gerçeği:** Node's child `'close'` event follows process termination and stdio closure; `'exit'` can occur while streams remain open. `subprocess.kill()` only sends a signal and its `killed` property does not prove termination. Source: [Node.js `ChildProcess`](https://nodejs.org/api/child_process.html#class-childprocess).

4. **Kanıtlanmış platform gerçeği:** Negative PIDs address process groups on POSIX through `process.kill`; Node documents that Windows rejects a PID used for a process group. v1 supports Linux x64 only. Source: [Node.js `process.kill`](https://nodejs.org/api/process.html#processkillpid-signal).

5. **Kanıtlanmış platform gerçeği:** The acceptance worker uses `tini -- /docker-entrypoint.sh worker` as PID 1, with `node /usr/local/bin/n8n worker` as its direct child. This helps container-level reaping but is not request-level descendant control.

6. **Ürün kararı:** ADR 0020 defines the exact Process Group termination sequence, cancellation priority, minimal environment, output limits, redaction, and success/failure exposure.

7. **Ürün kararı:** `--no-progress` and no-color behavior are node-controlled. v1 offers no progress override and never places retained stdout/stderr in a successful Result.

8. **Lisans/güvenlik riski:** `detached` children can outlive a parent in POSIX semantics. PID/group reuse, a worker crash, SIGKILL, Docker failure, or a descendant that changes session/group can escape JavaScript cleanup. PID 1 `tini` does not eliminate these cases.

9. **E2E ile doğrulanacak varsayım:** A fake executable must create multi-generation children, ignore SIGTERM, split secrets across chunks, flood both streams, and race exit/error/cancellation. Real tests must prove yt-dlp, FFmpeg, and Deno group membership, termination, descriptor closure, no zombies, bounded memory, redaction, and cleanup in the exact image.
