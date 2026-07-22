#!/bin/bash
set -euo pipefail

bundle_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_directory=${1:-"$bundle_root/rebuilt"}
dependency_image=n8n-nodes-yt-dlp-ffmpeg-dependencies:0.2.0
base_image=ghcr.io/yt-dlp/ffmpeg-builds/base-linux64@sha256:0fe9fc0b0831bc8c5a54705af7d8db2aac69c69e399c44f61d28989109a961cf
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
mkdir -p "$build_context/.cache/downloads"
cp "$bundle_root"/source/dependencies/*.tar.xz "$build_context/.cache/downloads/"
cp "$bundle_root/toolchain/Dockerfile.dependencies" "$build_context/Dockerfile.n8n"

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

echo "Rebuild evidence matches the packaged FFmpeg/FFprobe version and configuration."
