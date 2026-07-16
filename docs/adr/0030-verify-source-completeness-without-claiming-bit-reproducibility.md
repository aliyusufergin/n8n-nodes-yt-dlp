# Verify source completeness without claiming bit reproducibility

The release gate will publish and independently verify the complete source inputs,
recipes, patches, configuration, licenses, and provenance evidence corresponding to
the packaged toolchain. It will not claim that the historical FFmpeg images can be
rebuilt bit-for-bit or provide a nominal `offline.Dockerfile`.

The original Wader build depended on Alpine APK revisions that are no longer all
retained by normal mirrors, and GLib fetched a mutable libffi Meson branch whose
exact build-time commit was not attested in the retained log. An honest
network-disabled rebuild first requires reconstructing a local APK repository from
the included aports recipes and verified distfiles. Pretending that the original
Dockerfile can already rebuild offline would overstate the evidence.

Instead, the verifier checks the exact required source inventory, locked origins,
versions or commits, Wader archive SHA-256 values, Alpine APKBUILD SHA-512 values,
Cargo.lock package checksums, per-file Cargo vendor checksums, provenance records,
and the bundle-wide SHA-256 manifest. A future offline rebuild recipe may be added
only when it starts from these retained bytes and passes with networking disabled.
