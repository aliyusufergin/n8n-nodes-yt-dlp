import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createYtDlpExecutionPlan } from '../nodes/YtDlp/arguments';
import {
	PROCESS_OUTPUT_LIMIT_BYTES,
	PROCESS_STREAM_TAIL_BYTES,
	YtDlpProcessError,
	spawnYtDlpExecutionPlan,
	superviseYtDlpExecutionPlan,
	type SpawnProcess,
} from '../nodes/YtDlp/process';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
});

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

async function waitForPidFile(path: string): Promise<number[]> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return (await readFile(path, 'utf8')).trim().split('\n').map(Number);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return Promise.reject(error);
			await delay(20);
		}
	}
	throw new Error('The controlled executable did not publish its PIDs.');
}

async function waitForProcessesToDisappear(pids: readonly number[]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		let unexpectedError: unknown;
		const remaining = pids.filter((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
				unexpectedError = error;
				return false;
			}
		});
		if (unexpectedError !== undefined) return Promise.reject(unexpectedError);
		if (remaining.length === 0) return;
		await delay(20);
	}
	throw new Error(`Processes remained after group termination: ${pids.join(', ')}`);
}

describe('yt-dlp process boundary', () => {
	it('drains both streams and resolves after a normal close', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-normal-close-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		await writeFile(
			executablePath,
			`#!${process.execPath}\nprocess.stdout.write('stdout'); process.stderr.write('stderr');\n`,
			{ mode: 0o700 },
		);

		await expect(
			superviseYtDlpExecutionPlan(executablePath, { argv: [] }, { cwd: workspace }),
		).resolves.toBeUndefined();
	});

	it('classifies non-zero exit with bounded redacted stream tails', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-non-zero-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`process.stdout.write('stdout-tail');\n` +
				`process.stderr.write('x'.repeat(70 * 1024) + 'secret-across');\n` +
				`setImmediate(() => { process.stderr.write('-chunks'); process.exitCode = 9; });\n`,
			{ mode: 0o700 },
		);

		const error = await superviseYtDlpExecutionPlan(
			executablePath,
			{ argv: [] },
			{ cwd: workspace, redactValues: ['secret-across-chunks'] },
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(YtDlpProcessError);
		expect(error).toMatchObject({ code: 'YTDLP_FAILED', stdoutTail: 'stdout-tail' });
		expect(Buffer.byteLength((error as YtDlpProcessError).stderrTail)).toBeLessThanOrEqual(
			PROCESS_STREAM_TAIL_BYTES,
		);
		expect((error as YtDlpProcessError).stderrTail.endsWith('<redacted>')).toBe(true);
		expect((error as YtDlpProcessError).stderrTail).not.toContain('secret-across-chunks');
	});

	it('terminates output floods above the combined eight MiB limit', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-output-flood-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`process.stdout.write(Buffer.alloc(${PROCESS_OUTPUT_LIMIT_BYTES}, 'o'));\n` +
				`process.stderr.write('x');\n` +
				`setInterval(() => {}, 1000);\n` +
				`setTimeout(() => process.exit(0), 500);\n`,
			{ mode: 0o700 },
		);

		await expect(
			superviseYtDlpExecutionPlan(executablePath, { argv: [] }, { cwd: workspace }),
		).rejects.toMatchObject({ code: 'PROCESS_OUTPUT_LIMIT' });
	});

	it('emits one cancellation classification when cancellation races an output flood', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-output-cancel-race-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`process.stdout.write(Buffer.alloc(${PROCESS_OUTPUT_LIMIT_BYTES + 1}, 'o'));\n` +
				`setInterval(() => {}, 1000);\n`,
			{ mode: 0o700 },
		);
		const controller = new AbortController();
		const sendSignal = process.kill.bind(process);
		const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
			if (signal === 'SIGTERM') queueMicrotask(() => controller.abort());
			return sendSignal(pid, signal);
		});

		try {
			await expect(
				superviseYtDlpExecutionPlan(
					executablePath,
					{ argv: [] },
					{ cwd: workspace, signal: controller.signal },
				),
			).rejects.toMatchObject({ name: 'YtDlpProcessCancellationError' });
			expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(1);
		} finally {
			kill.mockRestore();
		}
	});

	it('times out before a delayed descendant can start', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-timeout-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		const descendantStartedPath = join(workspace, 'descendant-started');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`const { spawn } = require('node:child_process');\n` +
				`const { writeFileSync } = require('node:fs');\n` +
				`setTimeout(() => { writeFileSync(${JSON.stringify(descendantStartedPath)}, 'yes'); spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); }, 200);\n` +
				`setInterval(() => {}, 1000);\n`,
			{ mode: 0o700 },
		);

		await expect(
			superviseYtDlpExecutionPlan(
				executablePath,
				{ argv: [] },
				{ cwd: workspace, timeoutMs: 25 },
			),
		).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
		await expect(readFile(descendantStartedPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it(
		'times out after a TERM-cooperative leader creates an ignored-SIGTERM descendant',
		async () => {
			const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-descendant-timeout-'));
			temporaryDirectories.push(workspace);
			const executablePath = join(workspace, 'controlled-executable');
			const pidPath = join(workspace, 'pids');
			await writeFile(
				executablePath,
				`#!${process.execPath}\n` +
					`const { spawn } = require('node:child_process');\n` +
					`const { writeFileSync } = require('node:fs');\n` +
					`const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 8000)"], { stdio: 'ignore' });\n` +
					`writeFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n' + descendant.pid);\n` +
					`setInterval(() => {}, 1000);\n`,
				{ mode: 0o700 },
			);
			const supervision = superviseYtDlpExecutionPlan(
				executablePath,
				{ argv: [] },
				{ cwd: workspace, timeoutMs: 500 },
			);
			const pids = await waitForPidFile(pidPath);
			const timeoutObservedAt = Date.now();

			await expect(supervision).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

			expect(Date.now() - timeoutObservedAt).toBeGreaterThanOrEqual(4_900);
			await waitForProcessesToDisappear(pids);
		},
		12_000,
	);

	it('treats a process-group signal failure as a global invariant', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-signal-failure-'));
		temporaryDirectories.push(workspace);
		const executablePath = join(workspace, 'controlled-executable');
		await writeFile(
			executablePath,
			`#!${process.execPath}\nsetInterval(() => {}, 1000); setTimeout(() => process.exit(0), 300);\n`,
			{ mode: 0o700 },
		);
		const signalError = Object.assign(new Error('signal denied'), { code: 'EPERM' });
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
			throw signalError;
		});

		try {
			await expect(
				superviseYtDlpExecutionPlan(
					executablePath,
					{ argv: [] },
					{ cwd: workspace, timeoutMs: 25 },
				),
			).rejects.toMatchObject({
				name: 'YtDlpProcessTerminationError',
				processClosed: false,
			});
		} finally {
			kill.mockRestore();
		}
	});

	it(
		'cancels an ignored-SIGTERM leader and descendant without leaving zombies',
		async () => {
			const workspace = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-cancellation-'));
			temporaryDirectories.push(workspace);
			const executablePath = join(workspace, 'controlled-executable');
			const pidPath = join(workspace, 'pids');
			const stdinClosedPath = join(workspace, 'stdin-closed');
			await writeFile(
				executablePath,
				`#!${process.execPath}\n` +
					`const { spawn } = require('node:child_process');\n` +
					`const { writeFileSync } = require('node:fs');\n` +
					`process.on('SIGTERM', () => {});\n` +
					`process.stdin.resume();\n` +
					`process.stdin.on('end', () => writeFileSync(${JSON.stringify(stdinClosedPath)}, 'yes'));\n` +
					`const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });\n` +
					`writeFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n' + descendant.pid);\n` +
					`setInterval(() => {}, 1000);\n` +
					`setTimeout(() => { try { process.kill(descendant.pid, 'SIGKILL'); } catch {} process.exit(0); }, 8000);\n`,
				{ mode: 0o700 },
			);
			const controller = new AbortController();
			const supervision = superviseYtDlpExecutionPlan(
				executablePath,
				{ argv: [] },
				{ cwd: workspace, signal: controller.signal },
			);
			const pids = await waitForPidFile(pidPath);
			await expect(readFile(stdinClosedPath)).rejects.toMatchObject({ code: 'ENOENT' });

			const cancellationStartedAt = Date.now();
			controller.abort();
			await expect(supervision).rejects.toMatchObject({
				name: 'YtDlpProcessCancellationError',
			});

			expect(Date.now() - cancellationStartedAt).toBeGreaterThanOrEqual(4_900);
			expect(await readFile(stdinClosedPath, 'utf8')).toBe('yes');
			await waitForProcessesToDisappear(pids);
		},
		12_000,
	);

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

		const child = spawnYtDlpExecutionPlan(executablePath, plan, { cwd: workspace });
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

	it('spawns an absolute executable as a detached process group with a minimal environment', () => {
		const child = {} as ChildProcessWithoutNullStreams;
		const spawnProcess = vi.fn<SpawnProcess>(() => child);
		const plan = { argv: ['--format', 'best', '--', 'https://example.com/video'] };

		expect(
			spawnYtDlpExecutionPlan('/opt/yt-dlp', plan, { cwd: '/tmp/request' }, spawnProcess),
		).toBe(child);
		expect(spawnProcess).toHaveBeenCalledWith('/opt/yt-dlp', plan.argv, {
			cwd: '/tmp/request',
			detached: true,
			env: {
				DENO_NO_UPDATE_CHECK: '1',
				HOME: '/tmp/request',
				LANG: 'C.UTF-8',
				LC_ALL: 'C.UTF-8',
				NO_COLOR: '1',
				TMPDIR: '/tmp/request',
			},
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
				{ cwd: '/tmp/request' },
				spawnProcess,
			),
		).toThrow('absolute');
		expect(spawnProcess).not.toHaveBeenCalled();
	});
});
