# yt-dlp Community Node Specification

This document is the implementation contract for the first release. The ADRs in `docs/adr` explain why these requirements were selected; `CONTEXT.md` defines the domain language.

## Goal

Provide yt-dlp to a self-hosted n8n workflow without requiring a custom n8n image. A workflow author enters the arguments that normally follow the `yt-dlp` executable. The node runs a pinned packaged toolchain and returns both a structured process result and final files in n8n binary storage.

The node is not a shell and does not promise unrestricted yt-dlp CLI parity.

## Compatibility contract

- n8n 2.x, beginning at 2.0.0.
- The official n8n Docker image as a single instance.
- Linux x64 and Linux arm64.
- Self-hosted unverified community-node installation only.
- Queue mode, n8n Cloud, native Linux, other container bases, Windows, macOS, and AI-tool use are unsupported in v1.

## Package family

The private npm-workspace root coordinates three public packages with the same exact SemVer:

| Package                        | Purpose                        | License          |
| ------------------------------ | ------------------------------ | ---------------- |
| `n8n-nodes-yt-dlp`             | TypeScript node and credential | MIT              |
| `n8n-nodes-yt-dlp-linux-x64`   | Linux x64 packaged toolchain   | GPL-3.0-or-later |
| `n8n-nodes-yt-dlp-linux-arm64` | Linux arm64 packaged toolchain | GPL-3.0-or-later |

The node package declares the platform packages as exact-version optional dependencies. Platform packages use npm `os`, `cpu`, and `libc` constraints so npm installs only the matching Linux musl package. No install or runtime script downloads an executable.

## Node interface

Display name: `yt-dlp`

The node is a programmatic regular node with one main input and two named main outputs:

1. `Result`
2. `Artifacts`

It is not usable as an AI tool.

Parameters:

- `Arguments`: required expression-capable multiline string, maximum 64 KiB of UTF-8. It excludes the executable name.
- `Timeout Seconds`: non-negative number, default `0`. Zero disables the per-invocation timeout.
- Optional `yt-dlp Secrets` credential.

Credential fields:

- `Cookies`: optional Netscape cookie-file content, maximum 10 MiB of UTF-8.
- `Sensitive Arguments`: optional argument line, maximum 64 KiB of UTF-8.

NUL bytes are invalid in every text input. Cookies are syntax-validated without reproducing cookie values in errors.

## Item execution

- One incoming item creates one invocation.
- Expressions resolve separately for each incoming item.
- Invocations run sequentially in incoming-item order.
- An argument line may contain multiple URLs or a playlist.
- Separate workflow executions may still run concurrently under n8n's own concurrency controls.
- Every returned item has `pairedItem` linkage to the incoming item that caused it.

## Argument grammar

The normal and sensitive lines use the same POSIX-like lexical subset:

- Whitespace and newlines delimit tokens.
- Single and double quotes group text.
- Backslash escapes and backslash-newline continuation are supported.
- Token order, repeated options, and the `--` separator are preserved.
- Environment expansion, tilde expansion, globbing, comments, command substitution, and shell operators are not supported.
- `|`, `>`, `<`, `&&`, `||`, `;`, `$()`, and backticks are rejected outside quoted literal data where applicable.
- An unclosed quote, invalid escape, empty argument line, or a line beginning with an executable token fails before process creation.

The effective argv contains node-owned isolation options, normal tokens, and sensitive option tokens. If normal tokens contain `--`, sensitive tokens are inserted immediately before it. Sensitive Arguments may contain only cataloged options and their values, never positional inputs or their own separator. The complete argv is validated again after merging.

## Option catalog

Each toolchain manifest identifies a version-specific catalog of every accepted yt-dlp option, alias, arity, value form, and classification:

- `pass`: passed without semantic change.
- `node-controlled`: supplied only by the node.
- `restricted`: rejected with a user-facing reason.

Unknown options are rejected. A toolchain update is blocked until new or semantically changed options are classified.

At minimum, the following capabilities are node-controlled or restricted:

- yt-dlp self-update.
- Configuration files, default configuration discovery, plugins, and remote components.
- Arbitrary executable selection or location, external downloaders, and executable-spawning hooks.
- User-defined aliases, raw postprocessor arguments, and raw downloader arguments.
- Arbitrary staged input files, browser cookie stores, netrc, batch files, and info-JSON input.
- Node-owned paths, cache, cookie path, temporary path, FFmpeg location, and JavaScript runtime.
- Media output to stdout.
- Raw page/traffic debug options and their historical aliases.
- `file:` URLs, local-path-like positional inputs, and stdin as a positional input.
- Interactive option values.

Fixed upstream preset aliases are accepted only after their expansions recursively pass the catalog. Compat-option values have their own versioned allowlist.

`--output` is accepted only for relative templates confined to the output area. Absolute paths, traversal, stdout, and templates capable of leaving the output area are rejected. `--paths` is node-controlled.

## Packaged invocation

Only the packaged yt-dlp executable is spawned, directly and without a shell. Stdin is closed, no PTY is allocated, and stdout/stderr are pipes.

Node-owned arguments enforce:

- Ignoring every configuration source.
- Disabling plugin and remote-component discovery.
- The packaged FFmpeg/FFprobe location.
- The packaged Node runtime and yt-dlp-ejs assets.
- The invocation's home, output, temporary, cache, and cookie paths.

Each invocation is the leader of a detached Linux process group. n8n cancellation sends SIGTERM to the group and SIGKILL after five seconds. Cancellation is never converted into Continue On Fail. A per-invocation timeout uses the same termination path but is an ordinary invocation failure.

## Execution environment

The child does not inherit the container environment wholesale.

Node-owned values set the working directory, HOME, XDG configuration/cache roots, TMPDIR, a minimal PATH, and deterministic UTF-8 locale inside the invocation workspace. Executable paths are absolute.

Only these operator settings may pass through:

- Uppercase and lowercase HTTP, HTTPS, ALL proxy variables and NO_PROXY.
- `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE`.
- `TZ`.

Proxy user information joins the secret set. Arbitrary environment fields are not exposed in the node UI.

## Workspace and artifacts

Each invocation creates a random mode-0700 directory beneath the system temporary directory with three areas:

- `output`
- `temp`
- `private`

Secret files use mode 0600. Every accepted artifact is transferred to n8n binary storage before workspace cleanup.

Every regular file recursively remaining beneath `output` is an Artifact. Directories, symbolic links, sockets, special files, partial downloads, temporary fragments, credentials, and node-private files are never Artifacts.

An Artifact item uses binary property `data` and JSON metadata:

```json
{
  "relativePath": "subdirectory/file.mp4",
  "fileName": "file.mp4",
  "fileExtension": "mp4",
  "mimeType": "video/mp4",
  "fileSize": 12345
}
```

There is no implicit per-file, total-artifact, or playlist-entry size limit. Operators are responsible for temporary disk, n8n binary storage, pruning, execution time, and workflow concurrency.

Cleanup runs after success, failure, timeout, and cancellation. A bounded scavenger may reclaim only prefixed abandoned directories whose owner marker proves the originating Linux process is gone or its PID has been reused. Ambiguous directories remain untouched.

## Process output and redaction

Stdout and stderr are continuously drained. Each Result retains at most 1 MiB from each stream: the first 512 KiB and last 512 KiB separated by a truncation marker. The Result reports original byte counts and truncation flags.

Before bounded capture or exposure, a streaming redactor masks:

- Known credential, cookie, and proxy secret values.
- Plain, URL-encoded, and JSON-escaped forms.
- Sensitive HTTP header values.
- URL user information and recognized sensitive query values.

Neither argument line is echoed in Result, errors, or logs. Node logs contain neutral invocation diagnostics only. Redaction is best effort and cannot guarantee detection of an unknown transformation. Artifact files are not modified or scanned and may contain private data.

There is no live process-output or progress stream in v1.

## Result contract

One Result item is produced per completed invocation:

```json
{
  "status": "succeeded",
  "exitCode": 0,
  "signal": null,
  "durationMs": 1234,
  "stdout": "...",
  "stderr": "...",
  "stdoutBytes": 123,
  "stderrBytes": 456,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "artifactCount": 1,
  "toolchain": {
    "ytDlp": "...",
    "ffmpeg": "...",
    "ffprobe": "...",
    "ejs": "..."
  },
  "error": null
}
```

`status` is `succeeded`, `failed`, or `timed_out`. Exit code, signal, and error are nullable as appropriate. Stdout is never implicitly parsed as JSON.

By default a validation error, spawn failure, signal, timeout, or non-zero exit raises `NodeOperationError` and stops later items. With Continue On Fail, the node emits a failed Result, continues to later items, and emits only regular finalized files already present in `output`. n8n cancellation always stops the node. yt-dlp's own ignore-errors behavior is governed by its final exit code.

## Toolchain and releases

Each architecture package contains pinned versions of:

- A tested official yt-dlp nightly musllinux executable.
- Hardened fully static release GPL FFmpeg and FFprobe executables from the pinned
  multi-architecture `wader/static-ffmpeg` OCI image.
- yt-dlp-ejs and required companion assets.

The toolchain manifest records immutable URLs, exact versions or commits, SHA-256 digests, licenses, source references, and executable paths. yt-dlp checksums are verified against upstream's GPG-signed list. Other upstream verification data is used when available; otherwise a human-reviewed update establishes the expected digest.

Updates may create pull requests but never publish automatically. Required deterministic tests, human approval, and both platform packages must succeed before the main package is published. Platform packages are published and verified first; the main package is last.

Packages publish from GitHub Actions with npm trusted publishing and provenance. Initial `0.1.0` packages use the `next` dist-tag. `1.0.0` becomes `latest` only after registry-install tests pass on both supported architectures.

Every release also publishes a Corresponding Source Bundle. Platform packages include the GPL text, third-party notices, manifest, and immutable source-bundle direction.

## Required test seams

Tests observe behavior only through these agreed seams:

1. Argument policy: user lines and credential input produce an approved argv or a validation error.
2. Invocation runtime: an approved invocation produces Result/Artifacts and exhibits timeout, cancellation, redaction, and cleanup behavior.
3. n8n node contract: incoming items and settings produce both paired outputs with n8n failure semantics and sequential execution.
4. Platform package contract: runtime platform plus manifest resolves exact tool paths or an actionable unsupported/missing-package error.

Required CI includes unit tests, local HTTP/media fixtures, FFmpeg merge/post-processing, clean package installation, n8n node linting, type checking, package-content checks, and end-to-end execution in the official n8n 2.x image on x64 and arm64. Scheduled live-site canaries are non-blocking and retain no credentials or media.

## Acceptance criteria

The first implementation is complete when:

- A clean supported n8n Docker instance can install only `n8n-nodes-yt-dlp` and execute a local-fixture download without a custom image or system yt-dlp/FFmpeg.
- npm selects exactly one matching platform package and an absent/unsupported package produces an actionable error.
- One input item can return one Result and multiple paired Artifact items.
- Multiple input items run sequentially and Continue On Fail behaves as specified.
- Shell syntax, every cataloged restricted capability, path escape, local-file input, unknown options, invalid cookies, oversized input, and interactive input fail before spawn.
- Secrets do not appear in captured Result/error fixtures, including across stream chunk boundaries.
- Timeout and cancellation terminate descendant processes and remove the workspace.
- Partial and special files are never emitted; finalized sidecar files are emitted.
- The complete required test matrix, type check, lint, package inspection, source-bundle check, and provenance-ready release dry run pass.
