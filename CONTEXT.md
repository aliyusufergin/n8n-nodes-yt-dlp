# yt-dlp Node

This context describes the language used to discuss running yt-dlp from n8n workflows without modifying the n8n runtime image.

## Language

**Self-hosted instance**:
An n8n installation operated by its user, where unverified community packages can be installed.
_Avoid_: n8n Cloud, Cloud instance

**Supported runtime**:
The official n8n 2.x Docker image running as a single instance on Linux amd64 or Linux arm64.
_Avoid_: queue mode, native Linux installation, bare-metal installation, Windows, macOS

**yt-dlp node**:
The community node that makes yt-dlp capabilities available to workflows on a self-hosted instance.
_Avoid_: verified node, Cloud node

**Node package**:
The `n8n-nodes-yt-dlp` npm package containing the TypeScript integration, credential definition, and exact optional dependencies on the platform packages.
_Avoid_: platform package, toolchain package

**Argument line**:
The user-supplied sequence of yt-dlp options, option values, and input URLs, excluding the `yt-dlp` executable name and shell syntax.
_Avoid_: command, shell command, script

**Restricted option**:
A yt-dlp option that can launch an uncontrolled process, load uncontrolled executable code, or replace a packaged executable.
_Avoid_: dangerous option, unsafe flag

**Option catalog**:
The version-specific classification of every accepted yt-dlp option and alias, including whether it is passed through, restricted, or controlled by the node.
_Avoid_: denylist, arbitrary arguments

**Secrets credential**:
The optional encrypted n8n credential containing cookie data and sensitive yt-dlp arguments that must not appear in the workflow's argument line or execution records.
_Avoid_: authentication argument, cookie path, secret parameter

**Trusted workflow author**:
A person allowed to configure the yt-dlp node and therefore trusted with the network reachability available to the n8n container.
_Avoid_: untrusted user, sandboxed user, AI agent

**Download artifact**:
A final file produced by yt-dlp, including requested post-processing, and returned as binary data in one n8n output item.
_Avoid_: container file, output path, temporary file

**Execution workspace**:
An isolated temporary directory that contains every file created during one yt-dlp invocation and is removed after its download artifacts enter n8n binary storage.
_Avoid_: download directory, mounted volume, persistent directory

**Execution environment**:
The minimal, node-constructed set of environment variables made available to an invocation, plus explicitly permitted operator proxy, certificate, and timezone settings.
_Avoid_: container environment, inherited environment, user environment

**Execution result**:
The structured record of one yt-dlp invocation, including its process outcome, captured text streams, duration, toolchain versions, and download-artifact count.
_Avoid_: download artifact, console log, command output

**Invocation**:
One isolated yt-dlp process created from one incoming n8n item and its resolved argument line.
_Avoid_: workflow execution, node execution, job

**Packaged toolchain**:
The yt-dlp, FFmpeg, FFprobe, and required companion assets delivered with the yt-dlp node for its supported runtime.
_Avoid_: system dependency, host executable, preinstalled tool

**Platform package**:
An architecture-specific npm package containing the packaged toolchain for one supported runtime architecture.
_Avoid_: installer, postinstall download, universal binary package

**Corresponding Source Bundle**:
The release-specific archive that provides the source snapshots, build recipes, configuration, patches, licenses, and manifest corresponding to a packaged toolchain.
_Avoid_: source link, repository homepage, binary archive
