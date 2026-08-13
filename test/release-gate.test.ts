import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
					capacity: false,
					scaleRecovery: false,
					tag: '2.0.0',
				},
				{
					image:
						'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1',
					indexDigest: 'sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d',
					role: 'acceptance',
					capacity: false,
					scaleRecovery: false,
					tag: '2.27.4',
				},
				{
					image:
						'docker.n8n.io/n8nio/n8n@sha256:7e82936bc03d310ddb8759c361f4e225412f0c3daad8d4b4e0d10c7e034c1b11',
					indexDigest: 'sha256:d91033b4fac2f7b75c5c4007e10824c66147f7d7a3cccb488720e97452ee7dc7',
					role: 'frozen stable head',
					capacity: true,
					scaleRecovery: true,
					tag: '2.34.5',
				},
			],
			frozenAt: '2026-08-13',
		});
	});

	it('attempts every anchor and reports the complete failure list', async () => {
		const executableDirectory = await mkdtemp(join(tmpdir(), 'n8n-release-gate-path-'));
		try {
			const invocationLog = join(executableDirectory, 'invocations');
			await writeFile(
				join(executableDirectory, 'node'),
				'#!/bin/sh\nprintf "%s:%s\\n" "$E2E_SCALE_RECOVERY" "$E2E_CAPACITY" >> "$E2E_FAKE_NODE_LOG"\nexit 19\n',
				{ mode: 0o700 },
			);
			let failure: { code: number; stderr: string; stdout: string } | undefined;
			try {
				await execFileAsync(process.execPath, ['e2e/release-gate/run.mjs'], {
					env: {
						...process.env,
						E2E_FAKE_NODE_LOG: invocationLog,
						PATH: executableDirectory,
					},
				});
			} catch (error) {
				failure = error as { code: number; stderr: string; stdout: string };
			}
			if (!failure) throw new Error('The release gate unexpectedly succeeded.');

			expect((await readFile(invocationLog, 'utf8')).trim().split('\n')).toEqual([
				'false:false',
				'false:false',
				'false:false',
			]);
			expect(failure.code).toBe(1);
			expect(
				failure.stdout
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line) as { anchor?: string })
					.filter((entry): entry is { anchor: string } => typeof entry.anchor === 'string')
					.map(({ anchor }) => anchor),
			).toEqual(['2.0.0', '2.27.4', '2.34.5']);
			expect(failure.stderr).toContain('Release Gate Matrix failed: 2.0.0, 2.27.4, 2.34.5');
		} finally {
			await rm(executableDirectory, { force: true, recursive: true });
		}
	});

	it('exposes multiworker and capacity as independent frozen-head lanes', async () => {
		const { stdout } = await execFileAsync(process.execPath, [
			'e2e/release-gate/run.mjs',
			'--list-lanes',
		]);
		expect(JSON.parse(stdout)).toEqual({
			capacity: {
				anchors: ['2.34.5'],
				capacity: true,
				scaleRecovery: true,
			},
			core: {
				anchors: ['2.0.0', '2.27.4', '2.34.5'],
				capacity: false,
				scaleRecovery: false,
			},
			multiworker: {
				anchors: ['2.34.5'],
				capacity: false,
				scaleRecovery: true,
			},
		});
		const { stdout: capacityDescription } = await execFileAsync(process.execPath, [
			'e2e/release-gate/run.mjs',
			'--describe-lane',
			'capacity',
		]);
		expect(JSON.parse(capacityDescription)).toMatchObject({
			lane: 'capacity',
			anchors: [
				{
					tag: '2.34.5',
					image:
						'docker.n8n.io/n8nio/n8n@sha256:7e82936bc03d310ddb8759c361f4e225412f0c3daad8d4b4e0d10c7e034c1b11',
				},
			],
		});

		const executableDirectory = await mkdtemp(join(tmpdir(), 'n8n-release-lanes-path-'));
		try {
			const invocationLog = join(executableDirectory, 'invocations');
			await writeFile(
				join(executableDirectory, 'node'),
				'#!/bin/sh\nprintf "%s:%s\\n" "$E2E_SCALE_RECOVERY" "$E2E_CAPACITY" >> "$E2E_FAKE_NODE_LOG"\nexit 19\n',
				{ mode: 0o700 },
			);
			for (const lane of ['multiworker', 'capacity']) {
				await expect(
					execFileAsync(process.execPath, ['e2e/release-gate/run.mjs', '--lane', lane], {
						env: {
							...process.env,
							E2E_FAKE_NODE_LOG: invocationLog,
							PATH: executableDirectory,
						},
					}),
				).rejects.toMatchObject({ code: 1 });
			}
			expect((await readFile(invocationLog, 'utf8')).trim().split('\n')).toEqual([
				'true:false',
				'true:true',
			]);
		} finally {
			await rm(executableDirectory, { force: true, recursive: true });
		}
	});
});
