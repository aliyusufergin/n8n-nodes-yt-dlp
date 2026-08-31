import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { NO_PROGRESS_LIMIT_MS } from '../nodes/YtDlp/resource-envelope';

function sectionContent(markdown: string, heading: string): string {
	const sectionStart = markdown.indexOf(`${heading}\n`);
	if (sectionStart === -1) return '';
	const contentStart = sectionStart + heading.length + 1;
	const nextSectionOffset = markdown.slice(contentStart).search(/^## /mu);
	return nextSectionOffset === -1
		? markdown.slice(contentStart)
		: markdown.slice(contentStart, contentStart + nextSectionOffset);
}

function missingSectionContent(
	markdown: string,
	requirements: Readonly<Record<string, readonly string[]>>,
): string[] {
	return Object.entries(requirements).flatMap(([heading, requiredContent]) => {
		const section = sectionContent(markdown, heading);
		if (section === '') return [`missing section: ${heading}`];
		return requiredContent
			.filter((content) => !section.includes(content))
			.map((content) => `${heading}: ${content}`);
	});
}

describe('public documentation', () => {
	it('documents the supported install-to-first-Artifact workflow', async () => {
		const readme = await readFile('README.md', 'utf8');

		expect(
			missingSectionContent(readme, {
				'## Support boundary': [
					'| Uyumluluk Hedefi (compatibility target) | n8n `>=2.0.0 <3.0.0` |',
					'| Doğrulanmış Destek (exact verified support) | Official n8n Docker Linux x64 images for n8n 2.0.0, 2.27.4, and 2.34.5 |',
					'Only official n8n Docker Linux x64 is supported.',
				],
				'## Install, update, and rollback': [
					'**Settings → Community Nodes**',
					'n8n-nodes-yt-dlp@0.2.1',
					'n8n-nodes-yt-dlp-platform@0.2.1',
					'n8n-nodes-yt-dlp-linux-x64@0.2.1',
					'No custom n8n image',
					'For an operator rollback',
				],
				'## First Artifact': [
					'**Manual Trigger → yt-dlp**',
					'Your authorized absolute `https://` media URL',
					'`binary.data`',
					'project-generated synthetic media',
				],
				'## Source URL': ['absolute `http:` or `https:` URL', 'Search prefixes'],
				'## Playlist expansion': [
					'one independent Download Request per entry',
					'does not\ninvalidate the Artifacts of the entries around it',
					'the same Source URL validation',
					'produces no Download Request',
					'`inputCount` and `requestCount`',
					'`--no-playlist` to pin an input item to a single video',
				],
				'## Arguments Grammar': [
					'no environment, command, tilde, brace, or glob expansion',
					'Outside quotes, backslash may escape only a space, tab, single quote, double quote,',
					'Inside double quotes, only `\\"` and `\\\\` are escapes.',
					'Inside single quotes, backslash',
					'is literal.',
					'256 tokens',
				],
				'## V1 Argument Allowlist': [
					'`-f`, `--format`, `-S`, `--format-sort`',
					'`--remux-video`, `--recode-video`, `--embed-metadata`, `--embed-chapters`, `--no-embed-chapters`',
					'`--merge-output-format` accepts',
					'`avi`, `flv`, `mkv`,',
					'`mov`, `mp4`, `webm`',
					'`--format-sort-force` requires `--format-sort`',
					'`--sub-langs`, `--sub-format`, `--convert-subs`, and `--embed-subs` require',
					'`--convert-thumbnails` and `--embed-thumbnail` require `--write-thumbnail`',
					'`--audio-format` and `--audio-quality` require `--extract-audio`',
					'`--remux-video` and `--recode-video` conflict',
				],
				'## Authentication': [
					'**YT-DLP Authentication**',
					'Netscape cookie-file content',
					'OAuth/browser login',
				],
				'## Result contract': [
					'"status": "success"',
					'`application/octet-stream`',
					'**Continue On Fail**',
					'**On Error** value is',
					'the **Error** output stays empty',
					'an If/Switch on `{{ $json.status }}`',
					'raises an execution warning saying so',
					'overwrites the Error output with what it finds',
					'an n8n-authored error',
					'Cancellation terminates the managed yt-dlp/FFmpeg/Deno process group',
					'### Cancellation example',
					'n8n execution view, use **Stop**',
					'No Artifact Item or Failure Item is returned',
					'Output atomicity is not storage transactionality.',
				],
				'## Resource Envelope': [
					'| Inputs per execution | — | none |',
					'| Artifacts per request | — | none |',
					'| All final Artifacts | — | none |',
					'The node does not cap what you may download with numbers it picked.',
					"The single-Artifact file size limit is not the node's.",
					'`N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE`',
					'`filesystem`, `s3`, and in-memory modes',
					'`database` in queue mode and `filesystem`',
					"falls back to n8n's own default",
					"The execution duration limit is not the node's either.",
					'`EXECUTIONS_TIMEOUT_MAX`',
					'free disk space measured where the',
					'refused before it starts',
					'| Request duration | — | none |',
					'A request has no duration limit, but a stuck one is still stopped.',
					'rather than elapsed time',
					'its process group terminated with `REQUEST_TIMEOUT`',
					"Capacity is the operator's responsibility",
				],
				'## Security boundary': [
					'not an application-layer SSRF firewall',
					'Operators who accept untrusted URLs are responsible',
					'S3 binary storage',
					'n8n AI Agent tool use',
				],
				'## License and Corresponding Source': [
					'[Toolchain Lock](packages/linux-x64/TOOLCHAIN.lock.json)',
					'`04acc71c79e71b8455a2660503c30f4cb9e84d8a127fcb71eb7763de47448a9a`',
					'`3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882`',
					'./toolchain/rebuild.sh /absolute/output/directory',
				],
			}),
		).toEqual([]);
	});

	it('documents the no-progress limit the node actually enforces', async () => {
		// The number in the Resource Envelope table is the node constant, not a paraphrase of it:
		// widening the limit without saying so in the README fails here.
		const readme = await readFile('README.md', 'utf8');

		expect(readme).toContain(
			`terminated after ${NO_PROGRESS_LIMIT_MS / 60_000} minutes without progress`,
		);
	});

	it('provides an actionable operator monitoring and recovery runbook', async () => {
		const runbook = await readFile('docs/operator-runbook.md', 'utf8');

		expect(
			missingSectionContent(runbook, {
				'## Queue and worker monitoring': [
					'active, waiting, completed, failed, retried, and stalled execution trends',
					'node readiness proved by an authorized first-Artifact execution on every worker',
					'`/healthz/readiness`',
				],
				'## Container and host monitoring': [
					'process RSS, container memory',
					'event-loop lag',
					'container writable-layer consumption',
				],
				'## Temp storage monitoring': [
					'`${os.tmpdir()}/n8n-nodes-yt-dlp`',
					'free bytes and free inodes',
					'three-hour stale threshold',
				],
				'## Postgres, Redis, and binary-storage monitoring': [
					'`database` binary storage',
					'database and `binary_data` row/byte growth',
					'Redis',
					'backend writes are not a transaction',
				],
				'## Frozen-head v0.2.1 capacity decision': [
					'capacity/n8n-2.34.5-node-0.2.1.json',
					'worker concurrency 1',
					'greater than 1 second',
					'greater than 4,368,367,616 bytes',
					'less than 6 GiB',
				],
				'## Diagnose': [
					'`N8N_REINSTALL_MISSING_PACKAGES=true`',
					'`BINARY_TRANSFER_FAILED`',
					'Do not install a `PATH` tool',
					'There is no request duration limit to raise',
				],
				'## Recover stale workspaces': [
					'At execution',
					'examines at most 100 direct children',
					'`STALE_WORKSPACE_CLEANUP_FAILED`',
					'Do not manually broaden the match',
				],
				'## Targeted worker recreation': [
					'Recreate only that worker container',
					'Do not recreate Postgres, Redis, main,',
					'or healthy workers',
					'Run an authorized first-Artifact execution',
				],
			}),
		).toEqual([]);
	});
});
