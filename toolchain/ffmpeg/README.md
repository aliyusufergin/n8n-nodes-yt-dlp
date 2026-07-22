# FFmpeg corresponding source rebuild

This toolchain reconstructs the Linux x64 GPL FFmpeg/FFprobe build identified by
`autobuild-2026-07-12-15-07`. The source bundle contains the exact FFmpeg and FFmpeg-Builds
snapshots, all 109 dependency source archives, the generated dependency Dockerfile, configuration
inputs, linked-library evidence, and expected version/configuration output.

The rebuild performs no source downloads. Before isolating the build host, fetch the one pinned
base image printed by `rebuild.sh` if it is not already present. Then extract the source bundle and
run:

```sh
./toolchain/rebuild.sh /absolute/output/directory
```

Both Docker build phases use `--network=none`. The script rebuilds every static dependency from the
bundled source archives, builds FFmpeg/FFprobe from the pinned FFmpeg snapshot, and fails unless the
resulting version, configuration, and library-version evidence matches the distributed binaries.

`SOURCE-INVENTORY.json` is the machine-readable source and digest index. `LINKED-LIBRARIES.json`
maps the complete captured external linker input to its corresponding bundled source component.
