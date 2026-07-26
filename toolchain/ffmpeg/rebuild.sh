#!/bin/bash
set -euo pipefail

bundle_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_directory=${1:-"$bundle_root/rebuilt"}
dependency_image=n8n-nodes-yt-dlp-ffmpeg-dependencies:0.2.0
base_image=ghcr.io/yt-dlp/ffmpeg-builds/base-linux64@sha256:2d1b4af9d22653e1fa430b7cabd36f616bebbd6c1a1f93242008f3f6869e57cf
temporary_directory=$(mktemp -d -t n8n-ffmpeg-rebuild.XXXXXXXX)
trap 'rm -rf -- "$temporary_directory"' EXIT

command -v docker >/dev/null
docker image inspect "$base_image" >/dev/null 2>&1 || {
	echo "Missing pinned base image. Fetch it once with: docker pull $base_image" >&2
	exit 1
}

build_context="$temporary_directory/ffmpeg-builds"
mkdir -p "$build_context" "$output_directory"
tar -xzf "$bundle_root/source/FFmpeg-Builds-832dd2f333d919790f117b054f628756c515adce.tar.gz" \
	-C "$build_context" --strip-components=1
patch --directory="$build_context" --strip=1 \
	<"$bundle_root/toolchain/patches/50-rav1e-offline.patch"
mkdir -p "$build_context/.cache/downloads"
cp "$bundle_root"/source/dependencies/*.tar.xz "$build_context/.cache/downloads/"
cp "$bundle_root/toolchain/Dockerfile.dependencies" "$build_context/Dockerfile.n8n"

# Warm each named stage in declaration order so BuildKit does not compile every
# independent dependency concurrently on memory-constrained clean builders.
while IFS= read -r target; do
	docker build \
		--network=none \
		--pull=false \
		--file "$build_context/Dockerfile.n8n" \
		--target "$target" \
		"$build_context"
done < <(sed -n 's/^FROM base-layer AS \([^ ]*\)$/\1/p' "$build_context/Dockerfile.n8n")

docker build \
	--network=none \
	--pull=false \
	--file "$build_context/Dockerfile.n8n" \
	--tag "$dependency_image" \
	"$build_context"

ffbuild="$temporary_directory/ffbuild"
mkdir -p "$ffbuild/ffmpeg" "$ffbuild/prefix"
tar -xzf "$bundle_root/source/FFmpeg-a09be9b91e8e1219f297586873b0d7322b47df96.tar.gz" \
	-C "$ffbuild/ffmpeg" --strip-components=1
printf '%s\n' 'N-125551-ga09be9b91e' >"$ffbuild/ffmpeg/VERSION"

docker run --rm \
	--network=none \
	--user "$(id -u):$(id -g)" \
	--volume "$ffbuild:/ffbuild" \
	--volume "$output_directory:/output" \
	--volume "$bundle_root/toolchain/build-ffmpeg.sh:/build-ffmpeg.sh:ro" \
	"$dependency_image" bash /build-ffmpeg.sh

"$output_directory/ffmpeg" -hide_banner -version >"$output_directory/ffmpeg-version.txt"
"$output_directory/ffprobe" -hide_banner -version >"$output_directory/ffprobe-version.txt"
grep -E '^(ffmpeg version|configuration:|libav|libsw)' \
	"$bundle_root/evidence/expected-ffmpeg-version.txt" >"$temporary_directory/expected-ffmpeg.txt"
grep -E '^(ffmpeg version|configuration:|libav|libsw)' \
	"$output_directory/ffmpeg-version.txt" >"$temporary_directory/actual-ffmpeg.txt"
grep -E '^(ffprobe version|configuration:|libav|libsw)' \
	"$bundle_root/evidence/expected-ffprobe-version.txt" >"$temporary_directory/expected-ffprobe.txt"
grep -E '^(ffprobe version|configuration:|libav|libsw)' \
	"$output_directory/ffprobe-version.txt" >"$temporary_directory/actual-ffprobe.txt"
cmp "$temporary_directory/expected-ffmpeg.txt" "$temporary_directory/actual-ffmpeg.txt"
cmp "$temporary_directory/expected-ffprobe.txt" "$temporary_directory/actual-ffprobe.txt"

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_inventory_sha=$(sha256sum "$bundle_root/SOURCE-INVENTORY.json" | cut -d ' ' -f 1)
dockerfile_sha=$(sha256sum "$bundle_root/toolchain/Dockerfile.dependencies" | cut -d ' ' -f 1)
build_script_sha=$(sha256sum "$bundle_root/toolchain/build-ffmpeg.sh" | cut -d ' ' -f 1)
rebuild_script_sha=$(sha256sum "$bundle_root/toolchain/rebuild.sh" | cut -d ' ' -f 1)
rav1e_patch_sha=$(sha256sum "$bundle_root/toolchain/patches/50-rav1e-offline.patch" | cut -d ' ' -f 1)
ffmpeg_sha=$(sha256sum "$output_directory/ffmpeg" | cut -d ' ' -f 1)
ffprobe_sha=$(sha256sum "$output_directory/ffprobe" | cut -d ' ' -f 1)
ffmpeg_config_sha=$(sha256sum "$temporary_directory/actual-ffmpeg.txt" | cut -d ' ' -f 1)
ffprobe_config_sha=$(sha256sum "$temporary_directory/actual-ffprobe.txt" | cut -d ' ' -f 1)
cat >"$output_directory/REBUILD-EVIDENCE.json" <<EOF
{
	"schemaVersion": 1,
	"status": "passed",
	"completedAt": "$completed_at",
	"networkMode": "none",
	"bindings": {
		"baseImage": "$base_image",
		"binaryAssetSha256": "7a19456683e31d937ae48d51e23dfb869dbb9db1e4d6e1b6881d7fed168fa5cf",
		"buildScriptSha256": "$build_script_sha",
		"dependencyDockerfileSha256": "$dockerfile_sha",
		"rav1ePatchSha256": "$rav1e_patch_sha",
		"rebuildScriptSha256": "$rebuild_script_sha",
		"sourceInventorySha256": "$source_inventory_sha"
	},
	"outputs": {
		"ffmpegSha256": "$ffmpeg_sha",
		"ffprobeSha256": "$ffprobe_sha",
		"ffmpegConfigEvidenceSha256": "$ffmpeg_config_sha",
		"ffprobeConfigEvidenceSha256": "$ffprobe_config_sha"
	}
}
EOF

echo "Rebuild evidence matches the packaged FFmpeg/FFprobe version and configuration."
echo "Persist $output_directory/REBUILD-EVIDENCE.json before release."
