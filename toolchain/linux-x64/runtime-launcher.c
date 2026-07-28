#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int supported_name(const char *name) {
	return strcmp(name, "deno") == 0 || strcmp(name, "ffmpeg") == 0 ||
		strcmp(name, "ffprobe") == 0 || strcmp(name, "yt-dlp") == 0;
}

static void fail(const char *message) {
	const int saved_errno = errno;
	fprintf(stderr, "Packaged toolchain launcher failed: %s", message);
	if (saved_errno != 0) fprintf(stderr, ": %s", strerror(saved_errno));
	fputc('\n', stderr);
	exit(126);
}

int main(int argc, char **argv, char **envp) {
	char executable[PATH_MAX];
	const ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
	if (length < 0 || (size_t)length >= sizeof(executable) - 1) fail("resolve executable");
	executable[length] = '\0';

	char *name = strrchr(executable, '/');
	if (name == NULL || !supported_name(name + 1)) fail("unsupported executable name");
	*name = '\0';
	name += 1;

	char *bin_component = strrchr(executable, '/');
	if (bin_component == NULL || strcmp(bin_component + 1, "bin") != 0) {
		fail("resolve package root");
	}
	*bin_component = '\0';

	char loader[PATH_MAX];
	char library_path[PATH_MAX];
	char target[PATH_MAX];
	const int musl_target = strcmp(name, "yt-dlp") == 0;
	const char *runtime_name = musl_target ? "musl" : "glibc";
	const char *loader_name =
		musl_target ? "ld-musl-x86_64.so.1" : "ld-linux-x86-64.so.2";
	const char *target_suffix = musl_target ? "musl" : "gnu";
	if (
		snprintf(
			loader,
			sizeof(loader),
			"%s/runtime/%s/%s",
			executable,
			runtime_name,
			loader_name
		) >= (int)sizeof(loader) ||
		snprintf(
			library_path,
			sizeof(library_path),
			"%s/runtime/%s",
			executable,
			runtime_name
		) >=
			(int)sizeof(library_path) ||
		snprintf(
			target,
			sizeof(target),
			"%s/bin/%s.%s",
			executable,
			name,
			target_suffix
		) >=
			(int)sizeof(target)
	) {
		fail("construct runtime path");
	}

	char **launcher_argv = calloc((size_t)argc + 4, sizeof(*launcher_argv));
	if (launcher_argv == NULL) fail("allocate arguments");
	launcher_argv[0] = loader;
	launcher_argv[1] = "--library-path";
	launcher_argv[2] = library_path;
	launcher_argv[3] = target;
	for (int index = 1; index < argc; index += 1) {
		launcher_argv[index + 3] = argv[index];
	}

	execve(loader, launcher_argv, envp);
	fail("start packaged executable");
}
