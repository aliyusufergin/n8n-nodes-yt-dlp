# FFmpeg corresponding source rebuild

This toolchain reconstructs the Linux x64 GPL FFmpeg/FFprobe build identified by
`autobuild-2026-07-12-15-07`. The source bundle contains the exact FFmpeg and FFmpeg-Builds
snapshots, all 109 dependency source archives, the generated dependency Dockerfile, configuration
inputs, linked-library evidence, and expected version/configuration output. The rav1e archive is
augmented with its locked Cargo graph and 272 vendored crates; `patches/50-rav1e-offline.patch`
removes the upstream `cargo update` and enforces `cargo cinstall --locked --offline`. Both FreeType
stages include the exact `dlg` submodule revision required by their pinned source commit.

The rebuild performs no source downloads. Before isolating the build host, fetch the one pinned
base image printed by `rebuild.sh` if it is not already present. Then extract the source bundle and
run:

```sh
./toolchain/rebuild.sh /absolute/output/directory
```

Both Docker build phases use `--network=none`. Dependency stages are warmed in declaration order to
bound peak memory use on clean builders. The script rebuilds every static dependency from the
bundled source archives, builds FFmpeg/FFprobe from the pinned FFmpeg snapshot, and fails unless the
resulting version, configuration, and library-version evidence matches the distributed binaries.
It writes `REBUILD-EVIDENCE.json` beside the rebuilt executables. Persist that record at
`toolchain/ffmpeg/REBUILD-EVIDENCE.json`; the release gate binds it to the source inventory, binary
asset, dependency Dockerfile, and pinned base image.
The evidence also binds the rav1e offline-build patch.
The output hashes from the completed clean rebuild are frozen in `FFMPEG-SOURCE-MANIFEST.json`; the
release gate rejects a later evidence record whose rebuilt executables differ from those expected
outputs, even when their version/configuration text matches.

`SOURCE-INVENTORY.json` is the machine-readable source and digest index. `LINKED-LIBRARIES.json`
maps the complete captured external linker input to its corresponding bundled source component.
The gate hashes the sorted mapping keys and compares them with the captured linker-input digest, so
removing an observed linker input makes the coverage check fail.
Its toolchain-runtime section distinguishes GCC portions incorporated under the GCC Runtime Library
Exception from host-provided dynamic libraries that are not part of the package.
