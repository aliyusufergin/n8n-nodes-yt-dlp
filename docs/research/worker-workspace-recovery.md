# Worker workspace recovery

Accessed: 2026-07-17

## Version anchors

- n8n acceptance image: `docker.n8n.io/n8nio/n8n@sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d`, n8n 2.27.4, Node.js v24.16.0.
- Node.js documentation source: tag [`v24.16.0`](https://github.com/nodejs/node/tree/v24.16.0).
- Docker documentation is unversioned current documentation, accessed 2026-07-17.

## Read-only acceptance environment evidence

- Worker process runs as UID 1000.
- `/tmp` is mode `1777` and resides on the container's root `overlay` filesystem, not a separately reported tmpfs mount.
- Worker restart policy is `always`.
- The optional `/proc/mounts` filter in the same read-only inspection had an `awk` syntax error and was not retried. The `df -T /tmp` result independently identified `overlay`.

## Findings

1. **Kanıtlanmış platform gerçeği:** Node.js `os.tmpdir()` uses `TMPDIR`, `TMP`, then `TEMP` on non-Windows systems and otherwise defaults to `/tmp`. Source: [`doc/api/os.md`](https://github.com/nodejs/node/blob/v24.16.0/doc/api/os.md#ostmpdir), Node.js v24.16.0.

2. **Kanıtlanmış platform gerçeği:** `fsPromises.mkdtemp()` appends six random characters to a prefix and is the standard primitive for a uniquely named temporary directory. `fsPromises.rm()` supports recursive removal with bounded retry options. Source: [`doc/api/fs.md`](https://github.com/nodejs/node/blob/v24.16.0/doc/api/fs.md#fspromisesmkdtempprefix-options), Node.js v24.16.0.

3. **Kanıtlanmış platform gerçeği:** Docker writes unmounted container paths to the container's writable layer. That layer is unique to the container and is deleted when the container is deleted, not merely because its process stops. Source: [Docker storage](https://docs.docker.com/engine/storage/), accessed 2026-07-17.

4. **Kanıtlanmış platform gerçeği:** The inspected `/tmp` therefore provides worker-local isolation from other containers but does not by itself guarantee removal after a worker-process crash or restart of the same container. Recreating/deleting the container removes its writable layer.

5. **Ürün kararı:** ADR 0022 uses a stable `${os.tmpdir()}/n8n-nodes-yt-dlp` base verified as a real, UID-owned, mode-0700 directory. Create one random execution root beneath it and request workspaces beneath that root. Never use the shared `/home/node/.n8n` mount for download workspaces.

6. **Ürün kararı:** Normal completion, request failure, timeout, cancellation, and transfer failure all remove the request workspace in `finally`, after the Process Group and streams are closed. Cleanup retries are bounded. Failure to remove the current workspace is a global `WORKSPACE_CLEANUP_FAILED` error and is never converted by `Continue On Fail`.

7. **Ürün kararı:** Maintain a versioned, non-secret owner marker and update its heartbeat at most once per minute while an execution is active. At each later node execution start, scan only direct children with the exact package prefix; delete at most 100 roots whose verified marker heartbeat is older than three hours. Three hours is the accepted two-hour node hard cap plus a one-hour safety margin.

8. **Ürün kararı:** A stale candidate must be a direct real directory owned by the current UID, with no symlink path component and a regular, single-link, owner-only marker matching the supported schema. Ambiguous entries are never deleted. Failure to remove a fully verified stale candidate is surfaced as `STALE_WORKSPACE_CLEANUP_FAILED` rather than silently proceeding.

9. **Lisans/güvenlik riski:** JavaScript cleanup cannot run after worker/container SIGKILL, host failure, runtime crash, or out-of-memory termination. Until a later node execution performs the stale sweep, media and a cookie file may remain in the worker's writable layer. If the node never runs again, only operator action or container recreation clears it.

10. **Lisans/güvenlik riski:** Path checks and mode 0700 do not isolate the workspace from other malicious code already executing as the same UID in the same container. V1 does not claim a same-UID sandbox.

11. **E2E ile doğrulanacak varsayım:** Exact-image tests must cover every normal/error/cancellation cleanup path; concurrent active workspaces; a fake three-hour-old workspace; fresh/ambiguous/symlink/foreign-owner entries; cleanup permission failure; worker SIGKILL/restart; subsequent sweep; the 100-root bound; and container recreation.

12. **Cevapsız soru:** No application-level mechanism can guarantee immediate cleanup after an uncatchable crash. Operations documentation must identify the exact stable temp base, the three-hour recovery window, disk monitoring, and targeted container recreation as the final recovery mechanism. No general Docker prune is permitted.
