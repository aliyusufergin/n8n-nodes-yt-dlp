import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

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
					'n8n-nodes-yt-dlp@0.2.0',
					'n8n-nodes-yt-dlp-platform@0.2.0',
					'n8n-nodes-yt-dlp-linux-x64@0.2.0',
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
					'| Request timeout | 30 minutes | 60 minutes |',
					'| Artifacts per request | 20 | 50 |',
					'| One Artifact | 128 MiB | 256 MiB |',
					'| All final Artifacts | 256 MiB | 512 MiB |',
				],
				'## Security boundary': [
					'not an application-layer SSRF firewall',
					'Operators who accept untrusted URLs are responsible',
					'S3 binary storage',
					'n8n AI Agent tool use',
				],
				'## License and Corresponding Source': [
					'[Toolchain Lock](packages/linux-x64/TOOLCHAIN.lock.json)',
					'`c944fb08ee3125c7cb30b9772f8a23f5ff57957911ea4179db8be80f4ffedc8e`',
					'`3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882`',
					'./toolchain/rebuild.sh /absolute/output/directory',
				],
			}),
		).toEqual([]);
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
				'## Frozen-head v0.2.0 capacity decision': [
					'capacity/n8n-2.34.5-node-0.2.0.json',
					'worker concurrency 1',
					'greater than 1 second',
					'greater than 4,694,474,752 bytes',
					'less than 6 GiB',
				],
				'## Diagnose': [
					'`N8N_REINSTALL_MISSING_PACKAGES=true`',
					'`BINARY_TRANSFER_FAILED`',
					'Do not install a `PATH` tool',
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
