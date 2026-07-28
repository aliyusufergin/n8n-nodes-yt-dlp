import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve('.');
let fixtureRoot: string;
let candidatePath: string;
let ytDlpPath: string;
let denoPath: string;
let invocationPath: string;
let outputPath: string;

beforeEach(async () => {
	fixtureRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-live-canary-'));
	candidatePath = join(fixtureRoot, 'release-candidate.json');
	ytDlpPath = join(fixtureRoot, 'yt-dlp');
	denoPath = join(fixtureRoot, 'deno');
	invocationPath = join(fixtureRoot, 'invocation');
	outputPath = join(fixtureRoot, 'live-canary.json');
	await writeFile(
		candidatePath,
		`${JSON.stringify({
			schemaVersion: 1,
			version: '0.2.0',
			commit: 'a'.repeat(40),
			packages: [
				{
					name: 'n8n-nodes-yt-dlp-linux-x64',
					sha256: 'b'.repeat(64),
					version: '0.2.0',
				},
			],
			source: {
				bundles: [
					{
						name: 'source.tar.xz',
						sha256: 'd'.repeat(64),
						url: 'https://github.com/example/release/source.tar.xz',
					},
				],
			},
			toolchain: {
				components: ['yt-dlp', 'deno', 'yt-dlp-ejs'],
				lockSha256: 'c'.repeat(64),
			},
		})}\n`,
	);
	await writeFile(denoPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
});

afterEach(async () => {
	await rm(fixtureRoot, { force: true, recursive: true });
});

async function runCanary(): Promise<void> {
	await execFileAsync(process.execPath, ['scripts/live-canary.mjs', candidatePath, outputPath], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			LIVE_CANARY_DENO_PATH: denoPath,
			LIVE_CANARY_INVOCATION_PATH: invocationPath,
			LIVE_CANARY_TEST_OVERRIDE: '1',
			LIVE_CANARY_YTDLP_PATH: ytDlpPath,
			RUNNER_REGION: 'test-region',
		},
	});
}

describe('live extractor/JSC canary', () => {
	it('passes only after a no-download extraction invokes packaged Deno', async () => {
		await writeFile(
			ytDlpPath,
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$LIVE_CANARY_INVOCATION_PATH"\nprintf "%s\\n" "[youtube] [jsc:deno] Solving JS challenges using deno" >&2\nprintf "%s\\n" "YE7VzlLtp-4"\n',
			{ mode: 0o700 },
		);

		await runCanary();

		const candidateBytes = await readFile(candidatePath);
		const evidence = JSON.parse(await readFile(outputPath, 'utf8')) as {
			candidateSha256: string;
			diagnostics: string[];
			identities: {
				source: { bundles: Array<{ sha256: string }> };
				test: { id: string; upstreamCommit: string };
			};
			lane: string;
			outcome: string;
			region: string;
			waived: boolean;
		};
		expect(evidence).toMatchObject({
			candidateSha256: createHash('sha256').update(candidateBytes).digest('hex'),
			lane: 'live-canary',
			outcome: 'pass',
			region: 'test-region',
			waived: false,
			identities: {
				source: {
					bundles: [{ sha256: 'd'.repeat(64) }],
				},
				test: {
					id: 'YE7VzlLtp-4',
					upstreamCommit: 'aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8',
				},
			},
		});
		expect(evidence.diagnostics).toEqual([
			'yt-dlp-exit=0',
			'extracted-id=YE7VzlLtp-4',
			'deno-challenge=observed',
		]);
		const invocation = (await readFile(invocationPath, 'utf8')).split('\n');
		expect(invocation).toContain('--skip-download');
		expect(invocation).toContain('--no-remote-components');
		expect(invocation).toContain('youtube:player_client=mweb');
		expect(invocation).toContain(`deno:${denoPath}`);
	});

	it('records a network-limited result as blocking inconclusive evidence', async () => {
		await writeFile(
			ytDlpPath,
			'#!/bin/sh\nprintf "%s\\n" "ERROR: HTTP Error 429: Too Many Requests" >&2\nexit 1\n',
			{ mode: 0o700 },
		);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'inconclusive',
			waived: false,
		});
	});
});
