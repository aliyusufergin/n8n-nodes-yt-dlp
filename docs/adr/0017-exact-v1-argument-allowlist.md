---
status: accepted
---

# V1 yalnızca exact media işlem allowlist'ini kabul eder

İlk sürüm V1 Argument Allowlist olarak `-f/--format`, `-S/--format-sort`, `--format-sort-force`, `--merge-output-format`, `-I/--playlist-items`, `--yes-playlist`, `--no-playlist`, `--write-subs`, `--write-auto-subs`, `--sub-langs`, `--sub-format`, `--convert-subs`, `--embed-subs`, `--write-thumbnail`, `--convert-thumbnails`, `--embed-thumbnail`, `-x/--extract-audio`, `--audio-format`, `--audio-quality`, `--remux-video`, `--recode-video`, `--embed-metadata`, `--embed-chapters` ve `--no-embed-chapters` seçeneklerini kabul edecek. Alias'lar canonical forma çevrilecek; duplicate, conflict, eksik dependency, stdout media ve option-specific value ihlalleri process başlamadan reddedilecek. Unknown ile output/path, config/plugin/runtime/update, command/external executable, print/debug/simulate, auth/network, resource-control, local filesystem/metadata, geniş post-processing ve experimental/live seçenekleri fail-closed `UNSUPPORTED_ARGUMENT` olacaktır.
