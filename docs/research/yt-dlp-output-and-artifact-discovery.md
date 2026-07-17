# yt-dlp output and artifact discovery

Accessed: 2026-07-17

## Version anchors

- yt-dlp tag: [`2026.06.09`](https://github.com/yt-dlp/yt-dlp/tree/2026.06.09).
- Node.js API baseline: official rolling Node.js filesystem documentation accessed 2026-07-17; exact supported-image behavior remains an E2E target.

## Findings

1. **Kanıtlanmış platform gerçeği:** yt-dlp output templates may contain arbitrary hierarchical paths, create missing directories, and use `-o -` to emit media to stdout. Source: [yt-dlp 2026.06.09 output template](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#output-template).

2. **Kanıtlanmış platform gerçeği:** yt-dlp separately controls final home and intermediate temp paths, output templates, restricted filenames, stem-length trimming, overwrite behavior, partial files, and metadata sidecars. It warns that info JSON may contain personal information. Source: [yt-dlp 2026.06.09 filesystem options](https://github.com/yt-dlp/yt-dlp/blob/2026.06.09/README.md#filesystem-options).

3. **Kanıtlanmış platform gerçeği:** Node.js exposes `lstat`, `realpath`, descriptor `fstat`, and Linux `O_NOFOLLOW`; these primitives can detect or reject symbolic-link traversal and verify the opened inode. Source: [Node.js filesystem API](https://nodejs.org/api/fs.html).

4. **Ürün kararı:** Each request uses sibling `artifacts/`, `temp/`, and `control/` directories. Node-controlled paths and `%(autonumber)06d-%(id)s.%(ext)s` keep all user metadata out of directory structure; `--restrict-filenames` and `--trim-filenames 160` bound basenames. User output/path/template options are outside v1.

5. **Ürün kararı:** Artifact discovery is non-recursive and fail-closed. Only direct regular files with one hard link, an artifact-parent realpath, `O_NOFOLLOW` open, and matching `lstat`/`fstat` device and inode are eligible. Their physical basename is the n8n binary filename, and deterministic order is basename order.

6. **Ürün kararı:** Unexpected directories, links, special files, partial/control entries, or zero final files produce a request error before any Artifact Item is published. Temp and control directories are never artifact sources.

7. **E2E ile doğrulanacak varsayım:** The fixed template must remain collision-free for single videos, playlists, subtitle languages, thumbnails, audio extraction, remux, and recode. Exact-image tests must inject links and special files through a fake executable, race file replacement between checks, and prove descriptor-based binary transfer and cleanup.

8. **Lisans/güvenlik riski:** Descriptor checks narrow path traversal and TOCTOU exposure but do not create OS-level isolation. Any n8n/community-node code running as the same container user remains in the host process trust boundary.
