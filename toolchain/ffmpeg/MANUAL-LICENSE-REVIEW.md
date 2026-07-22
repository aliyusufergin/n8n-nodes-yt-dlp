# FFmpeg static-build license review

- Review date: 2026-07-22
- Scope: `ffmpeg-N-125551-ga09be9b91e-linux64-gpl.tar.xz` and its frozen source graph
- Review status: approved
- Reviewer: OpenAI Codex implementation review

The reviewed build enables GPL and version 3, disables the nonfree FDK AAC integration, and ships
the FFmpeg GPLv3 text. The complete captured linker inventory is mapped to the 109 exact dependency
source archives in `LINKED-LIBRARIES.json`; the platform package preserves 396 verbatim license,
notice, and license-header materials extracted from those archives.

The MIT-licensed n8n wrapper neither incorporates nor links FFmpeg code. It invokes the packaged
GPL executable as a separate process and exchanges arguments, files, and process output. On that
technical basis, the wrapper and GPL executable are distributed as separately licensed components
of one aggregate package, whose metadata says `SEE LICENSE IN LICENSES.md`.

Conclusion: approved for this exact frozen asset and source bundle. This is an engineering
compliance review, not legal advice. Any change to the binaries, configure flags, linker inventory,
source digests, license materials, or Toolchain Lock invalidates this review. Publication remains
blocked if the separate-process/aggregate interpretation is not accepted by the project's legal
reviewer.
