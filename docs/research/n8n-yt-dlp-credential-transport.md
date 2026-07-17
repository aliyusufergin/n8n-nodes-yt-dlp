# n8n and yt-dlp credential transport

Accessed: 2026-07-17

## Version anchors

- n8n tag: `n8n@2.27.4`, commit [`a4d0dfce294064026be1a6a246e6da348fea1485`](https://github.com/n8n-io/n8n/tree/a4d0dfce294064026be1a6a246e6da348fea1485).
- yt-dlp tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/tree/2026.06.09).

## Findings

1. **Kanıtlanmış platform gerçeği:** An n8n workflow node stores credential details as an ID/name reference, not the decrypted credential fields. Source: [`INodeCredentialsDetails`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/workflow/src/interfaces.ts#L1382), n8n 2.27.4.

2. **Kanıtlanmış platform gerçeği:** n8n's `Credentials.setData()` serializes and encrypts the complete credential object before persistence, and `getData()` decrypts it. The 2.27.4 default V2 path uses the instance encryption key and AES-256-CBC unless its encryption-key-rotation feature is configured. Sources: [`credentials.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/credentials.ts) and [`cipher.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/encryption/cipher.ts), n8n 2.27.4.

3. **Kanıtlanmış platform gerçeği:** Programmatic node execution can request decrypted credential data with `getCredentials(type, itemIndex)`. Source: [`BaseExecuteContext`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/core/src/execution-engine/node-execution-context/base-execute-context.ts), n8n 2.27.4.

4. **Kanıtlanmış platform gerçeği:** n8n credential definitions support password-masked string properties. Masking is a UI behavior; database encryption is provided separately by the credential persistence path. Source: [`custom.credentials.ts`](https://github.com/n8n-io/n8n/blob/a4d0dfce294064026be1a6a246e6da348fea1485/packages/%40n8n/node-cli/src/template/templates/shared/credentials/custom.credentials.ts), n8n 2.27.4.

5. **Kanıtlanmış platform gerçeği:** yt-dlp 2026.06.09 accepts `--config-locations -`, reads that explicit configuration from stdin, and tokenizes it with Python `shlex.split`. `--ignore-config`/`--no-config` prevents loading further configuration except explicit `--config-locations`. Sources: [`options.py`](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/yt_dlp/options.py#L424) and [`Config`](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/yt_dlp/utils/_utils.py#L4917).

6. **Kanıtlanmış platform gerçeği:** yt-dlp's own option redactor covers username/password and video-password options, but does not include proxy URLs or arbitrary headers. Source: [`Config.hide_login_info`](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/yt_dlp/utils/_utils.py#L4989).

7. **Ürün kararı:** v1 exposes one optional Authentication Credential supporting Netscape cookie content, site username/password, video password, and proxy URL. Arbitrary headers/tokens and interactive, browser, command, local-path, OAuth, OTP, and client-certificate mechanisms are outside v1.

8. **Ürün kararı:** Cookie content is materialized only into an exclusive-create `0600` file inside the per-request workspace. Other supported secrets are serialized into a Secret Config delivered over yt-dlp stdin; no secret is deliberately placed in argv or environment. User configuration remains disabled.

9. **E2E ile doğrulanacak varsayım:** POSIX-shlex serialization in TypeScript, stdin close behavior, cookie-file permissions, proxy/login behavior, secret redaction, queue-worker credential resolution, and cleanup have not yet been tested in the exact supported image. Tests must include quotes, backslashes, whitespace, option-looking values, CR/LF/NUL rejection, cancellation, timeout, and parser errors.

10. **Lisans/güvenlik riski:** n8n credential encryption protects persisted values but does not by itself prevent a workflow editor, instance administrator, running process, diagnostic dump, or deliberately decrypted credential export from accessing secrets. The node must minimize in-process lifetime and output/log exposure; operator access control remains part of the security boundary.
