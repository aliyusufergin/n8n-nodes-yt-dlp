import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createYtDlpExecutionPlan } from '../nodes/YtDlp/arguments';
import { spawnYtDlpExecutionPlan, type SpawnProcess } from '../nodes/YtDlp/process';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
});

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

describe('yt-dlp process boundary', () => {
	it('lets a controlled executable observe the exact planned argv', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-arguments-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		await writeFile(
			executablePath,
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o700 },
		);
		const plan = createYtDlpExecutionPlan({
			sourceUrl: 'https://example.com/video?id=1&list=2',
			arguments: `-f 'best video' --write-subs --sub-langs 'en.*,ja'`,
		});

		const child = spawnYtDlpExecutionPlan(executablePath, plan, { cwd: workspace, env: {} });
		const stdout = collect(child.stdout);
		const stderr = collect(child.stderr);
		const [exitCode, observedArgv, observedStderr] = await Promise.all([
			new Promise<number | null>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', resolve);
			}),
			stdout,
			stderr,
		]);

		expect(exitCode).toBe(0);
		expect(observedStderr).toBe('');
		expect(JSON.parse(observedArgv)).toEqual(plan.argv);
	});

	it('always spawns an absolute executable with shell disabled', () => {
		const child = {} as ChildProcessWithoutNullStreams;
		const spawnProcess = vi.fn<SpawnProcess>(() => child);
		const plan = { argv: ['--format', 'best', '--', 'https://example.com/video'] };

		expect(
			spawnYtDlpExecutionPlan('/opt/yt-dlp', plan, { cwd: '/tmp/request', env: {} }, spawnProcess),
		).toBe(child);
		expect(spawnProcess).toHaveBeenCalledWith('/opt/yt-dlp', plan.argv, {
			cwd: '/tmp/request',
			env: {},
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	});

	it('rejects a non-absolute executable path before spawn', () => {
		const spawnProcess = vi.fn<SpawnProcess>();

		expect(() =>
			spawnYtDlpExecutionPlan(
				'yt-dlp',
				{ argv: [] },
				{ cwd: '/tmp/request', env: {} },
				spawnProcess,
			),
		).toThrow('absolute');
		expect(spawnProcess).not.toHaveBeenCalled();
	});
});
