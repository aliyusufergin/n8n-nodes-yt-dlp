# FFmpeg static-build license review

- Review date: 2026-07-22
- Scope: `ffmpeg-N-125551-ga09be9b91e-linux64-gpl.tar.xz` and its frozen source graph
- Technical review status: complete
- Publication approval: pending maintainer or counsel review in `LICENSE-REVIEW.json`
- Technical reviewer: OpenAI Codex implementation review

The reviewed build enables GPL and version 3, disables the nonfree FDK AAC integration, and ships
the FFmpeg GPLv3 text. The complete captured linker inventory is mapped to the 109 exact dependency
source archives in `LINKED-LIBRARIES.json`; the platform package preserves 895 verbatim license,
notice, and license-header materials extracted from those archives. The FreeType inventories also
pin and preserve the license for their `dlg` submodule. The rav1e inventory includes
all 272 locked Cargo packages with their name, version, SPDX expression, source path, and mapped
license texts.

The MIT-licensed n8n wrapper neither incorporates nor links FFmpeg code. It invokes the packaged
GPL executable as a separate process and exchanges arguments, files, and process output. On that
technical basis, the wrapper and GPL executable are distributed as separately licensed components
of one aggregate package, whose metadata says `SEE LICENSE IN LICENSES.md`.

Technical conclusion: the frozen inputs support the aggregate interpretation. This is an
engineering compliance review, not legal advice. Publication remains blocked until a maintainer or
counsel records an explicit `approved` decision for the exact digests in `LICENSE-REVIEW.json`.
Any change to the binaries, configure flags, linker inventory, source digests, license materials,
or Toolchain Lock invalidates that approval.
