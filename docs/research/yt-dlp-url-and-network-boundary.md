# yt-dlp URL and network boundary

Accessed: 2026-07-17

## Version anchor

- yt-dlp tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/tree/2026.06.09).

## Findings

1. **Kanıtlanmış platform gerçeği:** yt-dlp 2026.06.09 disables `file://` URLs by default and describes `--enable-file-urls` as security-sensitive. Source: [`options.py`](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/yt_dlp/options.py#L647).

2. **Kanıtlanmış platform gerçeği:** The same version can accept URL lists from a local file or stdin through `--batch-file`, load local metadata through `--load-info-json`, transform unqualified input with `--default-search`, and force its generic extractor. Sources: [`options.py` filesystem options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/yt_dlp/options.py#L1382) and [`options.py` general options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/yt_dlp/options.py#L411).

3. **Ürün kararı:** v1 accepts exactly one separate absolute HTTP(S) Source URL per input item. It rejects userinfo, control characters, NUL, missing hosts, values over 16 KiB UTF-8, all other schemes, search prefixes, bare search terms, batch/stdin lists, local info JSON, and arguments that alter this boundary.

4. **Ürün kararı:** Default yt-dlp extractor selection, including fallback behavior, remains enabled. The node does not claim that validation of the initial Source URL constrains every downstream request made by extractors or FFmpeg.

5. **Lisans/güvenlik riski:** DNS resolution, redirects, extractor-generated endpoints, media manifests, and FFmpeg protocols occur below the node's initial URL parser. Application-level preflight checks cannot provide a complete public-network-only or anti-rebinding guarantee.

6. **Ürün kararı:** Workflow authors and URL provenance are within the trust boundary. Untrusted webhook/form/AI-derived URLs require operator-enforced egress controls. v1 is not advertised as an AI tool.

7. **E2E ile doğrulanacak varsayım:** Tests must prove rejection of local and ambiguous URL forms and show that no supported argument can re-enable file URLs, batch input, search prefixes, forced extractors, or local info loading. Network egress isolation itself is an operator deployment test, not a node guarantee.
