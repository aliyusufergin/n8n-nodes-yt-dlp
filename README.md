# n8n-nodes-yt-dlp

A self-hosted n8n Community Node that turns one authorized HTTP(S) media URL into one
`binary.data` Artifact per final file. Version 0.2.1 carries its own pinned yt-dlp, FFmpeg,
FFprobe, Deno, and challenge assets; it does not use tools from `PATH` or download tools at
runtime.

Use this node only for content you own or are authorized to download. Extractor behavior can
change outside this project, and neither the examples nor the release can guarantee that any
particular site is supported.

## Support boundary

The v0.2.1 support statement has two deliberately separate parts:

| Boundary | v0.2.1 statement |
| --- | --- |
| Uyumluluk Hedefi (compatibility target) | n8n `>=2.0.0 <3.0.0` |
| Doğrulanmış Destek (exact verified support) | Official n8n Docker Linux x64 images for n8n 2.0.0, 2.27.4, and 2.34.5 |
| Binary storage | Queue mode with `database` binary storage |
| Worker concurrency | 1 until a lower-concurrency disposable capacity lane passes |

The compatibility target is an intention, not certification of every n8n 2.x patch. The
stable-head anchor was advanced from 2.30.7 to 2.34.5 on 2026-08-13 and refrozen there. Versions
after that head, and intermediate versions not listed above, are unverified for node 0.2.1.

Only official n8n Docker Linux x64 is supported. n8n Cloud, n8n 1.x or 3.x, Linux arm64,
Windows, macOS, bare-metal npm installs, alternative container bases, and other Linux x64
environments are unsupported. Incidental success does not expand the support boundary.

## Install, update, and rollback

Before installation, configure queue mode to use `database` binary storage on main and every
worker. Do not use queue-mode `filesystem` storage with v0.2.1.

To install:

1. Open **Settings → Community Nodes** in n8n.
2. Install `n8n-nodes-yt-dlp` at exact version `0.2.1` and acknowledge n8n's Community Node
   warning.
3. Wait until the package appears on main and every online worker.
4. Run the authorized first-Artifact workflow below on each worker before enabling production
   workflows.

The main package installs this exact three-package chain:

```text
n8n-nodes-yt-dlp@0.2.1
└── n8n-nodes-yt-dlp-platform@0.2.1
    └── n8n-nodes-yt-dlp-linux-x64@0.2.1
```

The main package uses an exact normal dependency on the Platform Selector; the selector uses an
exact optional dependency on the Linux x64 Platform Package. This layout is required because the
n8n Community Packages installer removes direct optional dependencies, ignores lifecycle scripts,
and disables npm bin links. No custom n8n image, container modification, manual yt-dlp/FFmpeg/Deno
installation, permission-repair script, `PATH` fallback, or runtime download is part of the
contract.

For queue mode, package files are local to each n8n process even though installed-package metadata
is stored in the database. Online workers receive install/update events. Set
`N8N_REINSTALL_MISSING_PACKAGES=true` on workers so a restarted or newly added worker can recover
the database-recorded exact version, but treat that setting only as recovery: prove readiness with
a real node execution before the worker accepts production jobs.

Update only to a release whose main, selector, and Platform Package are published at the same exact
version. Use Community Nodes to update the main package, wait for propagation, verify the exact
three-package chain on every worker, and rerun the first-Artifact check.

For an operator rollback, disable affected workflows, remove the bad main package through Community
Nodes, install the previous known-good exact main version, wait for every worker to converge, and
run the readiness workflow before re-enabling traffic. Do not edit worker `node_modules`, replace
bundled tools, or use npm directly inside containers. Release maintainers must not unpublish:
move or remove the main package's `latest`/`next` tags first, then the selector and Platform
Package tags, deprecate all three bad versions, and publish a new lockstep patch.

## First Artifact

Create a workflow with **Manual Trigger → yt-dlp**. Use a media URL that you own or are explicitly
authorized to download:

| Field | First run |
| --- | --- |
| Source URL | Your authorized absolute `https://` media URL |
| Arguments | leave empty |
| Request Timeout (Minutes) | 30 |
| Maximum Artifact Count | 20 |
| Maximum Artifact Size (MiB) | 128 |
| Maximum Total Artifact Size (MiB) | 256 |

Run the workflow. A successful direct-media request produces one output item with the file under
`binary.data`; a playlist may produce several items. Every input item is a separate İndirme İsteği
(Download Request), while a playlist URL remains one request. Inputs are processed sequentially.

The repository release gate uses only project-generated synthetic media served by its disposable,
network-local fixture origin. That fixture URL is intentionally not a public example. Replace it
with your own authorized source; do not copy a third-party media URL into documentation or tests.

After the empty-Arguments run, safe format selection can be expressed without repeating the URL:

```text
-f "bv*+ba/b" --merge-output-format mp4
```

Audio extraction is another supported example:

```text
-x --audio-format mp3 --audio-quality 0
```

These examples demonstrate argument handling, not support for a particular extractor or site.

## Source URL

Source URL is separate from Arguments. It must be an absolute `http:` or `https:` URL, contain no
userinfo such as `user:password@host`, contain no control characters or surrounding whitespace,
and be at most 16 KiB in UTF-8. Search prefixes, bare searches, local/data/stream URLs, batch input,
and local info JSON are rejected before yt-dlp starts.

## Arguments Grammar

Arguments is the option line that would follow the `yt-dlp` executable, without the executable or
Source URL. The dependency-free grammar supports:

- space or tab token separation;
- single and double quotes;
- documented backslash escapes;
- adjacent quoted and unquoted fragment joining;
- empty quoted tokens; and
- `--option=value`, `--option value`, and the four explicit short aliases below.

Outside quotes, backslash may escape only a space, tab, single quote, double quote, or another
backslash. Inside double quotes, only `\"` and `\\` are escapes. Inside single quotes, backslash
is literal. Dollar signs and backticks are rejected even inside quotes.

It performs no environment, command, tilde, brace, or glob expansion. Comments, shell operators,
multiline input, positional tokens, a `--` terminator, short-option clusters, and attached short
values are rejected. The limits are 16 KiB for the complete field, 256 tokens, and 8 KiB for one
token.

## V1 Argument Allowlist

The exact v1 allowlist is:

| Purpose | Accepted options |
| --- | --- |
| Format | `-f`, `--format`, `-S`, `--format-sort`, `--format-sort-force`, `--merge-output-format` |
| Playlist | `-I`, `--playlist-items`, `--yes-playlist`, `--no-playlist` |
| Subtitles | `--write-subs`, `--write-auto-subs`, `--sub-langs`, `--sub-format`, `--convert-subs`, `--embed-subs` |
| Thumbnails | `--write-thumbnail`, `--convert-thumbnails`, `--embed-thumbnail` |
| Audio | `-x`, `--extract-audio`, `--audio-format`, `--audio-quality` |
| Video/post-processing | `--remux-video`, `--recode-video`, `--embed-metadata`, `--embed-chapters`, `--no-embed-chapters` |

The exact value and relationship rules are:

- `--format` accepts one non-empty yt-dlp format expression that does not begin with `-`.
  `--format-sort` accepts a comma-separated list of sort fields, each beginning with a letter and
  optionally prefixed by `+` or `-`, with yt-dlp `:` or `~` value suffixes; its value is limited to
  1,024 characters. `--format-sort-force` requires `--format-sort`.
- `--merge-output-format` accepts one or a `/`-separated preference list of `avi`, `flv`, `mkv`,
  `mov`, `mp4`, `webm`.
- `--playlist-items` accepts comma-separated positive indexes, closed `start-end` ranges, or
  `[start]:end[:step]` slices. Its value is limited to 512 characters and its calculable
  cardinality may not exceed 20. Without it, the node adds `--playlist-items 1:5`.
  `--yes-playlist` and `--no-playlist` conflict.
- `--sub-langs`, `--sub-format`, `--convert-subs`, and `--embed-subs` require
  `--write-subs` or `--write-auto-subs`. Subtitle formats are `ass`, `best`, `lrc`, `srt`, or
  `vtt`; conversion excludes `best`. `--sub-langs` is a non-empty expression of at most 512
  characters and rejects whitespace, path/shell metacharacters, and a leading `-`.
- `--convert-thumbnails` and `--embed-thumbnail` require `--write-thumbnail`. Thumbnail
  conversion accepts `/`-separated values or `source>target` rules using only `jpg`, `png`, and
  `webp`.
- `--audio-format` and `--audio-quality` require `--extract-audio`. Audio formats are `aac`,
  `alac`, `best`, `flac`, `m4a`, `mp3`, `opus`, `vorbis`, and `wav`. Quality is a decimal from 0
  through 10 or a positive decimal bitrate ending in `k` or `K`.
- `--remux-video` and `--recode-video` conflict. Each accepts `/`-separated values or
  `source>target` rules using `aac`, `aiff`, `alac`, `avi`, `flac`, `flv`, `gif`, `m4a`, `mka`,
  `mkv`, `mov`, `mp3`, `mp4`, `ogg`, `opus`, `vorbis`, `wav`, or `webm`.
- `--embed-chapters` and `--no-embed-chapters` conflict.

Aliases are canonicalized, and every canonical option may appear only once. Unknown, duplicated,
conflicting, value-invalid, and dependency-incomplete options fail before process start. Boolean
options reject an attached value.

## Authentication

Create an optional **YT-DLP Authentication** credential and attach it to the node. It can contain:

- Netscape cookie-file content;
- site username and password;
- video password; and
- authenticated proxy URL.

Cookie content is written to an owner-only `0600` file inside the request workspace. Other values
are serialized to a one-use Secret Config sent through stdin. Secrets are excluded from workflow
JSON, argv, inherited environment, Result items, and logs, and temporary cookie material is removed
on every catchable outcome.

Arbitrary headers or tokens, browser-cookie import, user-provided cookie/netrc/config paths,
command-based credentials, OAuth/browser login, OTP/2FA, and client-certificate paths are not
supported.

## Result contract

A successful Atomik İndirme İsteği publishes an Artifact Item only after yt-dlp has completed and
the complete final file set has been validated. Each physical file becomes a separate item in
deterministic basename order:

```json
{
  "json": {
    "status": "success",
    "artifactIndex": 1,
    "artifactCount": 1,
    "fileName": "authorized-media.mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 1048576
  },
  "binary": {
    "data": "<n8n binary metadata>"
  },
  "pairedItem": {
    "item": 0
  }
}
```

MIME type comes from a fixed extension table. An unknown extension uses
`application/octet-stream`; the node does not sniff content. Source URL, Arguments, credentials,
process output, and worker paths are never copied into the Result.

With **Continue On Fail** disabled, a request error stops execution with an item-linked n8n error.
With it enabled, only a typed request error becomes one binary-free Failure Item and later inputs
continue:

```json
{
  "json": {
    "status": "error",
    "errorCode": "INVALID_ARGUMENTS",
    "errorMessage": "The Arguments value is invalid."
  },
  "pairedItem": {
    "item": 0
  }
}
```

The Failure Item always arrives on the node's single main output, whichever **On Error** value is
set:

| On Error | Where a typed request error goes | Branch on it with |
| --- | --- | --- |
| **Stop Workflow** (default) | nowhere — the execution fails with an item-linked error | an n8n error workflow |
| **Continue** | the main output, next to Artifact Items | an If/Switch on `{{ $json.status }}` |
| **Continue (using error output)** | the main output as well — the **Error** output stays empty | an If/Switch on `{{ $json.status }}` |

To branch on failures, set On Error to **Continue** and put an **If** node after yt-dlp with the
condition `{{ $json.status }}` equals `error`; the true branch handles Failure Items, the false
branch Artifact Items.

**Continue (using error output)** does not move the Failure Item to the Error branch, and the node
raises an execution warning saying so. n8n's engine — not the node — fills that output: it scans the
regular outputs for items it recognises as errors (an `error` key, alone or beside `message`) and
overwrites the Error output with what it finds. A Failure Item carries `status`, `errorCode`, and
`errorMessage`, so it is never claimed, and writing that output from the node is not possible.

Only a typed request error becomes a Failure Item. The node still throws for cancellation,
execution-wide limits, and invariant or cleanup failures; n8n then applies On Error to that thrown
error, so under **Continue (using error output)** the Error branch receives an n8n-authored error
item rather than a Failure Item in the Result contract shape.

The stable request error codes are `INVALID_SOURCE_URL`, `INVALID_ARGUMENTS`, `YTDLP_FAILED`,
`REQUEST_TIMEOUT`, `PROCESS_OUTPUT_LIMIT`, `RESOURCE_LIMIT`, `INVALID_ARTIFACT_SET`, and
`BINARY_TRANSFER_FAILED`. Cancellation, execution-wide limits, toolchain/invariant failures,
cleanup failures, and unknown exceptions always stop the execution, even with Continue On Fail.
Cancellation terminates the managed yt-dlp/FFmpeg/Deno process group and waits for process and
stream closure before cleanup.

### Cancellation example

Use only an owned or explicitly authorized endpoint that responds slowly enough to cancel safely:

1. Create **Manual Trigger → yt-dlp**, set Source URL to that authorized slow media URL, leave
   Arguments empty, and enable Continue On Fail if you also want to verify its cancellation
   boundary.
2. Start the manual execution.
3. While the request is running in the n8n execution view, use **Stop**.
4. The execution stops globally. No Artifact Item or Failure Item is returned, later input items
   do not run, and Continue On Fail is not applied. The node terminates the process group before
   removing the owned workspace.

Output atomicity is not storage transactionality. If transfer of a later Artifact fails, the
request publishes no Artifact Items (or one `BINARY_TRANSFER_FAILED` Failure Item with Continue On
Fail), but an earlier backend write may remain unreferenced until n8n execution hard-delete and
pruning. The node does not call an internal deletion API.

## Resource Envelope

| Limit | Default | Hard cap |
| --- | ---: | ---: |
| Inputs per execution | — | 20 |
| Execution duration | — | 2 hours |
| Request timeout | 30 minutes | 60 minutes |
| Artifacts per request | 20 | 50 |
| One Artifact | 128 MiB | 256 MiB |
| All final Artifacts | 256 MiB | 512 MiB |
| Playlist entries | first 5 | 20 explicitly selected |
| FFmpeg threads | 1 | 1 |
| yt-dlp fragment concurrency | 1 | 1 |

Workspace usage is checked at least once per second and is capped at twice the configured final
total plus 64 MiB. Binary transfer is sequential. Configurable limits may be lowered or raised only
up to the immutable hard caps. These limits bound one execution; they are not deployment sizing or
capacity guarantees. See the [operator runbook](docs/operator-runbook.md).

## Security boundary

The node validates the Source URL structure but is not an application-layer SSRF firewall.
Extractors may follow redirects and resolve DNS, manifests, media URLs, or FFmpeg inputs that the
node cannot safely pre-classify. Operators who accept untrusted URLs are responsible for
container/host egress controls, DNS policy, proxy allowlists, private/link-local/metadata endpoint
blocking, and network monitoring.

V0.2.1 deliberately does not expose:

- arbitrary yt-dlp CLI, output paths, configs, plugins, self-update, user-selectable runtimes,
  external commands, local files, debug/print/simulation, or resource-control options;
- broader authentication, header, certificate, OAuth, or browser-login surfaces;
- system tool fallback or container mutation;
- S3 binary storage, queue-mode filesystem storage, or transactional backend rollback;
- n8n AI Agent tool use (the normal-node adapter drops binary data);
- a sandbox against the worker UID or root;
- node-owned metrics/telemetry or immediate cleanup after SIGKILL/OOM/host failure; or
- a supported-site, redistribution-rights, or extractor-availability guarantee.

## License and Corresponding Source

Project-authored TypeScript, JavaScript, tests, documentation, and build orchestration are MIT.
Third-party components keep their own licenses; the binary Platform Package uses
`SEE LICENSE IN LICENSES.md` and must not be described as wholly MIT or wholly GPL. Review the
[component license map](packages/linux-x64/LICENSES.md), [third-party notices](packages/linux-x64/THIRD_PARTY_NOTICES.md),
and verbatim `packages/linux-x64/LICENSES/` inventory.

The [Toolchain Lock](packages/linux-x64/TOOLCHAIN.lock.json) freezes upstream tags/commits, asset
names, SHA-256 values, licenses, runtime-image identities, and source-bundle identities. The
issue-18 disposable capacity record for the current frozen head, [n8n 2.34.5 / node
0.2.1](docs/capacity/n8n-2.34.5-node-0.2.1.json), measured these exact packed bytes:

| Package tarball | SHA-256 |
| --- | --- |
| `n8n-nodes-yt-dlp-linux-x64@0.2.1` | `04acc71c79e71b8455a2660503c30f4cb9e84d8a127fcb71eb7763de47448a9a` |
| `n8n-nodes-yt-dlp-platform@0.2.1` | `cd116ec01875822a374de872702a4c8a47ab26cafef9b6b698bb454e9368c3a5` |
| `n8n-nodes-yt-dlp@0.2.1` | `d227b8abcaddf5abef269c7b1ea15da2e39492a8d715ea95b8b572a7f61d8df7` |

That run installed the tarballs the registry read-back had fetched from public npm, so these are
the published `next` bytes rather than a local pack. Digests move with every release: the same
anchor's node 0.2.0 record, [n8n 2.34.5 / node
0.2.0](docs/capacity/n8n-2.34.5-node-0.2.0.json), holds a different set, as does the previous
frozen head, [n8n 2.30.7 / node 0.2.0](docs/capacity/n8n-2.30.7-node-0.2.0.json). Read digests from
the capacity record matching both your n8n anchor and your node version.
Registry metadata, provenance, and tarball digests must be read back and matched before promotion.

The immutable FFmpeg Corresponding Source Bundle is
[`n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz`](https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz),
SHA-256 `3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882`.
The complete immutable source list and digests for yt-dlp, Deno, EJS, FFmpeg, and the Linux runtime
are in [CORRESPONDING_SOURCE.md](packages/linux-x64/CORRESPONDING_SOURCE.md).

After extracting the FFmpeg bundle, follow its `toolchain/README.md` and run:

```bash
./toolchain/rebuild.sh /absolute/output/directory
```

The rebuild consumes the bundled exact sources and uses network-isolated Docker build phases.
The Linux runtime is reproduced separately from pinned images with:

```bash
./toolchain/linux-x64/build-runtime.sh /absolute/output/directory
```

Run the repository gates with:

```bash
npm run verify:ffmpeg-compliance
npm run verify:ffmpeg-release
```

Publication remains blocked while the Toolchain Lock records the combined runtime Corresponding
Source gate as `pending`, or until the immutable source assets, clean isolated rebuild evidence,
and maintainer license review all pass. A mutable upstream link or source-on-request is not a
substitute for a versioned source asset.

## Operations and troubleshooting

For queue, worker, container, temp, Postgres, Redis, binary storage, capacity, stale cleanup, and
targeted recreation procedures, use the [operator runbook](docs/operator-runbook.md).
