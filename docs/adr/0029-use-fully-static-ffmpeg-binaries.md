# Use fully static FFmpeg binaries

The platform packages will copy FFmpeg and FFprobe from the versioned,
multi-architecture `wader/static-ffmpeg` OCI image pinned by manifest-list digest.
Release preparation selects the matching Linux architecture, copies only the two
executables, and verifies their individual SHA-256 digests. The image's source
commit is pinned in the toolchain manifest.

The previously evaluated yt-dlp/FFmpeg-Builds Linux binaries link to glibc even
though their FFmpeg libraries are statically linked. They therefore fail in the
musl-based official n8n image. The selected replacements are hardened static PIE
executables with no external dependencies and keep the release-build, GPL,
x64/arm64, and complete media-toolchain decisions intact. Docker is required only
during release preparation; npm installation and node execution remain offline.
