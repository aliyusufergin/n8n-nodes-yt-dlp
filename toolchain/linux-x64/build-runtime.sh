#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output_directory=${1:?"usage: build-runtime.sh OUTPUT_DIRECTORY"}
compiler_image='gcc@sha256:3e239a5ea77200b9163c825a0a5ebc17ca99f3bbb4d08241ee0fb9c174325880'
runtime_image='ubuntu@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982'
musl_runtime_image='docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1'

mkdir -p "$output_directory/glibc" "$output_directory/musl" "$output_directory/licenses"
staging_directory=$(mktemp -d -t n8n-yt-dlp-runtime.XXXXXXXX)
compiler_container=
musl_runtime_container=
runtime_container=
cleanup() {
	if [ -n "$compiler_container" ]; then
		docker rm --force "$compiler_container" >/dev/null 2>&1 || true
	fi
	if [ -n "$runtime_container" ]; then
		docker rm --force "$runtime_container" >/dev/null 2>&1 || true
	fi
	if [ -n "$musl_runtime_container" ]; then
		docker rm --force "$musl_runtime_container" >/dev/null 2>&1 || true
	fi
	rm -rf -- "$staging_directory"
}
trap cleanup EXIT

docker image inspect "$compiler_image" >/dev/null
docker image inspect "$runtime_image" >/dev/null
docker image inspect "$musl_runtime_image" >/dev/null

docker run --rm \
	--network=none \
	--user "$(id -u):$(id -g)" \
	--volume "$repository_root/toolchain/linux-x64:/source:ro" \
	--volume "$output_directory:/output" \
	"$compiler_image" \
	gcc -Os -static -s -Wl,-z,relro,-z,now \
		/source/runtime-launcher.c -o /output/runtime-launcher

compiler_container=$(docker create "$compiler_image")
musl_runtime_container=$(docker create "$musl_runtime_image")
runtime_container=$(docker create "$runtime_image")

for library in \
	ld-linux-x86-64.so.2 \
	libc.so.6 \
	libdl.so.2 \
	libgcc_s.so.1 \
	libm.so.6 \
	libmvec.so.1 \
	libnss_dns.so.2 \
	libnss_files.so.2 \
	libpthread.so.0 \
	libresolv.so.2 \
	librt.so.1
do
	docker cp \
		"$runtime_container:/lib/x86_64-linux-gnu/$library" \
		"$staging_directory/$library"
	install -m 0644 "$staging_directory/$library" "$output_directory/glibc/$library"
done
docker cp \
	"$runtime_container:/lib/x86_64-linux-gnu/libz.so.1.2.11" \
	"$staging_directory/libz.so.1"
install -m 0644 "$staging_directory/libz.so.1" "$output_directory/glibc/libz.so.1"
docker cp "$runtime_container:/usr/share/doc/libc6/copyright" \
	"$staging_directory/libc6-copyright"
install -m 0644 "$staging_directory/libc6-copyright" \
	"$output_directory/licenses/libc6-copyright"
docker cp "$runtime_container:/usr/share/doc/libgcc-s1/copyright" \
	"$staging_directory/libgcc-s1-copyright"
install -m 0644 "$staging_directory/libgcc-s1-copyright" \
	"$output_directory/licenses/libgcc-s1-copyright"
docker cp "$runtime_container:/usr/share/doc/zlib1g/copyright" \
	"$staging_directory/zlib1g-copyright"
install -m 0644 "$staging_directory/zlib1g-copyright" \
	"$output_directory/licenses/zlib1g-copyright"
docker cp "$compiler_container:/usr/share/doc/libc6/copyright" \
	"$staging_directory/launcher-libc6-copyright"
install -m 0644 "$staging_directory/launcher-libc6-copyright" \
	"$output_directory/licenses/launcher-libc6-copyright"
docker cp "$compiler_container:/usr/share/doc/libgcc-s1/copyright" \
	"$staging_directory/launcher-libgcc-s1-copyright"
install -m 0644 "$staging_directory/launcher-libgcc-s1-copyright" \
	"$output_directory/licenses/launcher-libgcc-s1-copyright"
docker cp "$musl_runtime_container:/lib/ld-musl-x86_64.so.1" \
	"$staging_directory/ld-musl-x86_64.so.1"
install -m 0755 "$staging_directory/ld-musl-x86_64.so.1" \
	"$output_directory/musl/ld-musl-x86_64.so.1"
docker cp "$musl_runtime_container:/usr/lib/libz.so.1.3.2" \
	"$staging_directory/libz-musl.so.1"
install -m 0644 "$staging_directory/libz-musl.so.1" \
	"$output_directory/musl/libz.so.1"

chmod 0755 "$output_directory/runtime-launcher" "$output_directory/glibc/ld-linux-x86-64.so.2"
