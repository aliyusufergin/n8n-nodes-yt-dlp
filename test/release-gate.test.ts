import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('n8n 2.x Release Gate Matrix', () => {
	it('lists the three digest-pinned anchors frozen for the 0.2.0 release', async () => {
		const { stdout } = await execFileAsync(process.execPath, [
			'e2e/release-gate/run.mjs',
			'--list',
		]);

		expect(JSON.parse(stdout)).toEqual({
			anchors: [
				{
					image:
						'docker.n8n.io/n8nio/n8n@sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795',
					indexDigest: 'sha256:5b143d5ed0df23d295037408a8290872c549033709e375f920b33a94c754ea00',
					role: '2.x floor',
					tag: '2.0.0',
				},
				{
					image:
						'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1',
					indexDigest: 'sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d',
					role: 'acceptance',
					tag: '2.27.4',
				},
				{
					image:
						'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
					indexDigest: 'sha256:23a26975c21aa6f7113286668b35e2831ec898d3a7fbfa1ac8ff16f1bdf88c37',
					role: 'frozen stable head',
					tag: '2.30.7',
				},
			],
			frozenAt: '2026-07-17',
		});
	});

	it('attempts every anchor and reports the complete failure list', async () => {
		const executableDirectory = await mkdtemp(join(tmpdir(), 'n8n-release-gate-path-'));
		try {
			await writeFile(join(executableDirectory, 'node'), '#!/bin/sh\nexit 19\n', {
				mode: 0o700,
			});
			let failure: { code: number; stderr: string; stdout: string } | undefined;
			try {
				await execFileAsync(process.execPath, ['e2e/release-gate/run.mjs'], {
					env: { ...process.env, PATH: executableDirectory },
				});
			} catch (error) {
				failure = error as { code: number; stderr: string; stdout: string };
			}
			if (!failure) throw new Error('The release gate unexpectedly succeeded.');

			expect(failure.code).toBe(1);
			expect(
				failure.stdout
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line) as { anchor?: string })
					.filter((entry): entry is { anchor: string } => typeof entry.anchor === 'string')
					.map(({ anchor }) => anchor),
			).toEqual(['2.0.0', '2.27.4', '2.30.7']);
			expect(failure.stderr).toContain('Release Gate Matrix failed: 2.0.0, 2.27.4, 2.30.7');
		} finally {
			await rm(executableDirectory, { force: true, recursive: true });
		}
	});
});
