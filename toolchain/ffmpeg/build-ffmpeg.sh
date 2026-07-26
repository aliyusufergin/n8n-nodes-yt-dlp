#!/bin/bash
set -euo pipefail

export SOURCE_DATE_EPOCH=1783868618
export revision=N-125551-ga09be9b91e

cd /ffbuild/ffmpeg
./configure \
	--prefix=/ffbuild/prefix \
	--pkg-config-flags=--static \
	$FFBUILD_TARGET_FLAGS \
	$FF_CONFIGURE \
	--extra-cflags="$FF_CFLAGS" \
	--extra-cxxflags="$FF_CXXFLAGS" \
	--extra-libs="$FF_LIBS" \
	--extra-ldflags="$FF_LDFLAGS" \
	--extra-ldexeflags="$FF_LDEXEFLAGS" \
	--cc="$CC" \
	--cxx="$CXX" \
	--ar="$AR" \
	--ranlib="$RANLIB" \
	--nm="$NM" \
	--extra-version=20260712
make -j"$(nproc)" V=1
make install install-doc

install -m 0755 /ffbuild/prefix/bin/ffmpeg /output/ffmpeg
install -m 0755 /ffbuild/prefix/bin/ffprobe /output/ffprobe
install -m 0644 COPYING.GPLv3 /output/FFmpeg-GPLv3.txt
