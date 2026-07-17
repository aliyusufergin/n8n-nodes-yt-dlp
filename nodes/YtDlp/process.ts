import {
	spawn,
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { isAbsolute } from 'node:path';
import { finished } from 'node:stream/promises';

import type { YtDlpExecutionPlan } from './arguments';

export interface YtDlpSpawnContext {
	cwd: string;
}

export interface YtDlpSupervisorContext extends YtDlpSpawnContext {
	redactValues?: readonly string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

export const PROCESS_STREAM_TAIL_BYTES = 64 * 1024;
export const PROCESS_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const MAXIMUM_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
export const PROCESS_TERMINATION_GRACE_MS = 5_000;

export type YtDlpProcessErrorCode =
	| 'PROCESS_OUTPUT_LIMIT'
	| 'REQUEST_TIMEOUT'
	| 'YTDLP_FAILED';

export class YtDlpProcessError extends Error {
	constructor(
		readonly code: YtDlpProcessErrorCode,
		message: string,
		readonly stdoutTail: string,
		readonly stderrTail: string,
	) {
		super(message);
		this.name = 'YtDlpProcessError';
	}
}

export class YtDlpProcessCancellationError extends Error {
	constructor() {
		super('The yt-dlp request was cancelled.');
		this.name = 'YtDlpProcessCancellationError';
	}
}

export class YtDlpProcessTerminationError extends Error {
	constructor(
		readonly processClosed: boolean,
		cause: unknown,
	) {
		super('The yt-dlp process group could not be terminated safely.', { cause });
		this.name = 'YtDlpProcessTerminationError';
	}
}

const REDACTION_MARKER = Buffer.from('<redacted>');

class BoundedRedactedTail {
	private readonly secrets: readonly Buffer[];
	private readonly maximumSecretBytes: number;
	private pending = Buffer.alloc(0);
	private tail = Buffer.alloc(0);

	constructor(redactValues: readonly string[]) {
		this.secrets = redactValues
			.map((value) => Buffer.from(value))
			.filter((value) => value.length > 0)
			.sort((left, right) => right.length - left.length);
		if (this.secrets.some((value) => value.length > PROCESS_STREAM_TAIL_BYTES)) {
			throw new Error('A process output redaction value exceeds the retained tail limit.');
		}
		this.maximumSecretBytes = this.secrets[0]?.length ?? 1;
	}

	append(chunk: Buffer): void {
		this.pending = Buffer.concat([this.pending, chunk]);
		this.drain(false);
	}

	finish(): string {
		this.drain(true);
		let value = this.tail.toString('utf8');
		while (Buffer.byteLength(value) > PROCESS_STREAM_TAIL_BYTES) value = value.slice(1);
		return value;
	}

	private drain(final: boolean): void {
		const input = this.pending;
		const safeStartLimit = final
			? input.length
			: Math.max(0, input.length - (this.maximumSecretBytes - 1));
		const output: Buffer[] = [];
		let emittedThrough = 0;
		let cursor = 0;

		while (cursor < safeStartLimit) {
			const secret = this.secrets.find(
				(candidate) =>
					cursor + candidate.length <= input.length &&
					input.subarray(cursor, cursor + candidate.length).equals(candidate),
			);
			if (secret === undefined) {
				cursor++;
				continue;
			}

			if (cursor > emittedThrough) output.push(input.subarray(emittedThrough, cursor));
			output.push(REDACTION_MARKER);
			cursor += secret.length;
			emittedThrough = cursor;
		}

		if (cursor > emittedThrough) output.push(input.subarray(emittedThrough, cursor));
		this.pending = input.subarray(cursor);
		this.appendToTail(Buffer.concat(output));
	}

	private appendToTail(value: Buffer): void {
		if (value.length > 0) this.tail = Buffer.concat([this.tail, value]);
		const maximumTailBytes = PROCESS_STREAM_TAIL_BYTES - this.pending.length;
		if (this.tail.length > maximumTailBytes) {
			this.tail = this.tail.subarray(this.tail.length - maximumTailBytes);
		}
	}
}

type YtDlpSpawnOptions = SpawnOptionsWithoutStdio & {
	stdio: ['pipe', 'pipe', 'pipe'];
};

export type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: YtDlpSpawnOptions,
) => ChildProcessWithoutNullStreams;

const spawnProcess: SpawnProcess = (command, args, options) => spawn(command, [...args], options);

export function spawnYtDlpExecutionPlan(
	executablePath: string,
	plan: YtDlpExecutionPlan,
	context: YtDlpSpawnContext,
	startProcess: SpawnProcess = spawnProcess,
): ChildProcessWithoutNullStreams {
	if (!isAbsolute(executablePath)) {
		throw new Error('The yt-dlp executable path must be absolute.');
	}

	return startProcess(executablePath, plan.argv, {
		cwd: context.cwd,
		detached: true,
		env: {
			DENO_NO_UPDATE_CHECK: '1',
			HOME: context.cwd,
			LANG: 'C.UTF-8',
			LC_ALL: 'C.UTF-8',
			NO_COLOR: '1',
			TMPDIR: context.cwd,
		},
		shell: false,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

export async function superviseYtDlpExecutionPlan(
	executablePath: string,
	plan: YtDlpExecutionPlan,
	context: YtDlpSupervisorContext,
): Promise<void> {
	const isCancelled = (): boolean => context.signal?.aborted === true;
	if (isCancelled()) throw new YtDlpProcessCancellationError();

	const timeoutMs = context.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_REQUEST_TIMEOUT_MS) {
		throw new Error('The request timeout is outside the supported range.');
	}

	const stdoutTail = new BoundedRedactedTail(context.redactValues ?? []);
	const stderrTail = new BoundedRedactedTail(context.redactValues ?? []);
	const child = spawnYtDlpExecutionPlan(executablePath, plan, context);
	let outputBytes = 0;
	type TerminationReason =
		| Extract<YtDlpProcessErrorCode, 'PROCESS_OUTPUT_LIMIT' | 'REQUEST_TIMEOUT'>
		| 'CANCELLED';
	let terminationReason: TerminationReason | undefined;
	let terminationStarted = false;
	let processClosed = false;
	let childError: Error | undefined;
	let escalationTimer: ReturnType<typeof setTimeout> | undefined;
	let killConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
	const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
		child.once('error', (error) => {
			childError = error;
		});
		child.once('close', (exitCode, signal) => {
			processClosed = true;
			if (escalationTimer !== undefined) clearTimeout(escalationTimer);
			if (killConfirmationTimer !== undefined) clearTimeout(killConfirmationTimer);
			resolve([exitCode, signal]);
		});
	});
	let rejectTerminationFailure: (error: YtDlpProcessTerminationError) => void = () => {};
	const terminationFailure = new Promise<never>((_resolve, reject) => {
		rejectTerminationFailure = reject;
	});
	let terminationFailed = false;
	const failTermination = (cause: unknown): void => {
		if (terminationFailed) return;
		terminationFailed = true;
		rejectTerminationFailure(new YtDlpProcessTerminationError(processClosed, cause));
	};
	const signalProcessGroup = (signal: NodeJS.Signals): boolean => {
		try {
			if (child.pid === undefined) throw new Error('The process group leader has no PID.');
			process.kill(-child.pid, signal);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
			failTermination(error);
			return false;
		}
	};
	const requestTermination = (reason: TerminationReason): void => {
		if (processClosed) return;
		if (reason === 'CANCELLED') terminationReason = reason;
		else terminationReason ??= reason;
		if (terminationStarted) return;
		terminationStarted = true;
		child.stdin.end();
		if (!signalProcessGroup('SIGTERM')) return;
		escalationTimer = setTimeout(() => {
			if (processClosed || !signalProcessGroup('SIGKILL')) return;
			killConfirmationTimer = setTimeout(() => {
				if (!processClosed) failTermination(new Error('The process group remained after SIGKILL.'));
			}, PROCESS_TERMINATION_GRACE_MS);
		}, PROCESS_TERMINATION_GRACE_MS);
	};

	const consumeOutput = (tail: BoundedRedactedTail, chunk: Buffer | string): void => {
		const value = Buffer.from(chunk);
		tail.append(value);
		outputBytes += value.length;
		if (outputBytes > PROCESS_OUTPUT_LIMIT_BYTES) requestTermination('PROCESS_OUTPUT_LIMIT');
	};
	child.stdout.on('data', (chunk: Buffer | string) => consumeOutput(stdoutTail, chunk));
	child.stderr.on('data', (chunk: Buffer | string) => consumeOutput(stderrTail, chunk));
	const settleStream = async (
		stream: NodeJS.ReadableStream | NodeJS.WritableStream,
		ignoreBrokenPipe = false,
	): Promise<Error | undefined> => {
		try {
			await finished(stream);
			return undefined;
		} catch (error) {
			if (ignoreBrokenPipe && (error as NodeJS.ErrnoException).code === 'EPIPE') return undefined;
			return error instanceof Error ? error : new Error('A child process stream failed.');
		}
	};
	const stdinFinished = settleStream(child.stdin, true);
	const stdoutFinished = settleStream(child.stdout);
	const stderrFinished = settleStream(child.stderr);
	child.stdin.end();
	const timeoutTimer = setTimeout(() => requestTermination('REQUEST_TIMEOUT'), timeoutMs);
	const abortHandler = (): void => requestTermination('CANCELLED');
	context.signal?.addEventListener('abort', abortHandler, { once: true });
	if (isCancelled()) requestTermination('CANCELLED');

	let lifecycle: [
		[number | null, NodeJS.Signals | null],
		Error | undefined,
		Error | undefined,
		Error | undefined,
	];
	try {
		lifecycle = await Promise.race([
			Promise.all([closed, stdinFinished, stdoutFinished, stderrFinished]),
			terminationFailure,
		]);
	} finally {
		if (escalationTimer !== undefined) clearTimeout(escalationTimer);
		if (killConfirmationTimer !== undefined) clearTimeout(killConfirmationTimer);
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
		context.signal?.removeEventListener('abort', abortHandler);
	}
	const [[exitCode, signal], stdinError, stdoutError, stderrError] = lifecycle;
	if (childError !== undefined) {
		throw new Error('The yt-dlp process could not be started.', { cause: childError });
	}
	const streamError = stdinError ?? stdoutError ?? stderrError;
	if (streamError !== undefined) {
		throw new Error('A yt-dlp process stream failed.', { cause: streamError });
	}
	if (terminationReason === 'CANCELLED') throw new YtDlpProcessCancellationError();
	if (terminationReason !== undefined) {
		throw new YtDlpProcessError(
			terminationReason,
			terminationReason === 'PROCESS_OUTPUT_LIMIT'
				? 'yt-dlp exceeded the process output limit.'
				: 'yt-dlp exceeded the request timeout.',
			stdoutTail.finish(),
			stderrTail.finish(),
		);
	}
	if (exitCode !== 0) {
		throw new YtDlpProcessError(
			'YTDLP_FAILED',
			`yt-dlp exited unsuccessfully (${exitCode ?? signal ?? 'unknown'}).`,
			stdoutTail.finish(),
			stderrTail.finish(),
		);
	}
}
