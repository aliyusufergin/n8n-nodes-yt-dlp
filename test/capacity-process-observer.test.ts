import { describe, expect, it } from 'vitest';

import {
	observeWorkerProcesses,
	parseWorkerProcessSample,
	type WorkerProcess,
} from '../e2e/n8n-2.27.4/process-observer.mjs';

const restrictedYtDlpArguments =
	'/opt/n8n-nodes-yt-dlp/yt-dlp --postprocessor-args ffmpeg:-threads 1 -o /tmp/out.%(ext)s http://fixture:8080/capacity-playlist';
const unrestrictedYtDlpArguments =
	'/opt/n8n-nodes-yt-dlp/yt-dlp -o /tmp/out.%(ext)s http://fixture:8080/capacity-playlist';

function topOutput(rows: string[]): string {
	return ['PID                 PPID                RSS                 COMMAND             COMMAND', ...rows].join(
		'\n',
	);
}

function row(pid: number, rssKiB: number, command: string, argumentsText: string): string {
	return `${pid}                1                   ${rssKiB}                 ${command}             ${argumentsText}`;
}

function ytDlpProcess(pid: number, restricted: boolean): WorkerProcess {
	return {
		ffmpeg: false,
		ffmpegThreadsOne: false,
		n8nWorker: false,
		pid,
		rssBytes: 1024 * 1024,
		ytDlp: true,
		ytDlpFfmpegThreadsOne: restricted,
	};
}

function ffmpegProcess(pid: number, restricted: boolean): WorkerProcess {
	return {
		ffmpeg: true,
		ffmpegThreadsOne: restricted,
		n8nWorker: false,
		pid,
		rssBytes: 1024 * 1024,
		ytDlp: false,
		ytDlpFfmpegThreadsOne: false,
	};
}

function reader(...reads: WorkerProcess[][]): {
	readProcesses: () => Promise<WorkerProcess[]>;
	readCount: () => number;
} {
	let index = 0;
	return {
		readCount: () => index,
		readProcesses: async () => {
			const read = reads[Math.min(index, reads.length - 1)];
			index += 1;
			return read;
		},
	};
}

async function observe(...reads: WorkerProcess[][]) {
	const { readProcesses } = reader(...reads);
	return await observeWorkerProcesses(readProcesses, {
		confirmationDelayMs: 0,
		wait: async () => {},
	});
}

describe('capacity lane worker process observer', () => {
	it('parses pid, resident memory, command, and thread-restriction flags from a docker top sample', () => {
		const processes = parseWorkerProcessSample(
			topOutput([
				row(7, 327176, 'n8n', '/usr/local/bin/node /usr/local/bin/n8n worker --concurrency 10'),
				row(1240, 4096, 'yt-dlp', restrictedYtDlpArguments),
				row(1241, 8192, 'ffmpeg', '/opt/n8n-nodes-yt-dlp/ffmpeg -threads 1 -i a.mp4 out.mp4'),
			]),
		);

		expect(processes).toEqual([
			{
				ffmpeg: false,
				ffmpegThreadsOne: false,
				n8nWorker: true,
				pid: 7,
				rssBytes: 327176 * 1024,
				ytDlp: false,
				ytDlpFfmpegThreadsOne: false,
			},
			{
				ffmpeg: false,
				ffmpegThreadsOne: false,
				n8nWorker: false,
				pid: 1240,
				rssBytes: 4096 * 1024,
				ytDlp: true,
				ytDlpFfmpegThreadsOne: true,
			},
			{
				ffmpeg: true,
				ffmpegThreadsOne: true,
				n8nWorker: false,
				pid: 1241,
				rssBytes: 8192 * 1024,
				ytDlp: false,
				ytDlpFfmpegThreadsOne: false,
			},
		]);
	});

	it('reads a fully written argv without the restriction and a bracketed exec-window argv alike', () => {
		const processes = parseWorkerProcessSample(
			topOutput([
				row(1242, 512, 'yt-dlp', '[yt-dlp]'),
				row(1243, 512, 'yt-dlp', unrestrictedYtDlpArguments),
			]),
		);

		expect(processes).toMatchObject([
			{ pid: 1242, ytDlp: true, ytDlpFfmpegThreadsOne: false },
			{ pid: 1243, ytDlp: true, ytDlpFfmpegThreadsOne: false },
		]);
	});

	it('takes counts and worker memory from the first read only', async () => {
		const observation = await observe([
			{ ...ytDlpProcess(1, true), rssBytes: 0 },
			ytDlpProcess(2, true),
			{
				ffmpeg: false,
				ffmpegThreadsOne: false,
				n8nWorker: true,
				pid: 7,
				rssBytes: 335_028_224,
				ytDlp: false,
				ytDlpFfmpegThreadsOne: false,
			},
			ffmpegProcess(3, true),
		]);

		expect(observation).toEqual({
			ffmpegCount: 1,
			ffmpegThreadsOne: true,
			ffmpegUnconfirmedRestrictionReadCount: 0,
			ffmpegUnrestrictedCount: 0,
			workerRssBytes: 335_028_224,
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
			ytDlpUnconfirmedFfmpegThreadRestrictionCount: 0,
		});
	});

	it('does not re-read the process table when the first read is clean', async () => {
		const { readCount, readProcesses } = reader([ytDlpProcess(1, true)]);

		await observeWorkerProcesses(readProcesses, { confirmationDelayMs: 0, wait: async () => {} });

		expect(readCount()).toBe(1);
	});

	it('discards a partial exec-window read that carries the restriction on re-read', async () => {
		const observation = await observe(
			[ytDlpProcess(1, true), ytDlpProcess(2, false)],
			[ytDlpProcess(1, true), ytDlpProcess(2, true)],
		);

		expect(observation).toMatchObject({
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
			ytDlpUnconfirmedFfmpegThreadRestrictionCount: 1,
		});
	});

	it('discards a suspect that left the process table before it could be re-read', async () => {
		const observation = await observe([ytDlpProcess(1, false)], []);

		expect(observation).toMatchObject({
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
			ytDlpUnconfirmedFfmpegThreadRestrictionCount: 1,
		});
	});

	it('discards a suspect whose pid was reused by another program before the re-read', async () => {
		const observation = await observe([ytDlpProcess(1, false)], [ffmpegProcess(1, false)]);

		expect(observation).toMatchObject({
			ffmpegUnrestrictedCount: 0,
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
			ytDlpUnconfirmedFfmpegThreadRestrictionCount: 1,
		});
	});

	it('counts a yt-dlp process that still carries no restriction on re-read as a violation', async () => {
		const observation = await observe(
			[ytDlpProcess(1, true), ytDlpProcess(2, false)],
			[ytDlpProcess(1, true), ytDlpProcess(2, false)],
		);

		expect(observation).toMatchObject({
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 1,
			ytDlpUnconfirmedFfmpegThreadRestrictionCount: 0,
		});
	});

	it('counts an ffmpeg process that still carries no one-thread restriction on re-read as a violation', async () => {
		const observation = await observe([ffmpegProcess(9, false)], [ffmpegProcess(9, false)]);

		expect(observation).toMatchObject({
			ffmpegCount: 1,
			ffmpegThreadsOne: false,
			ffmpegUnconfirmedRestrictionReadCount: 0,
			ffmpegUnrestrictedCount: 1,
		});
	});

	it('reports no restricted ffmpeg evidence when no ffmpeg process was sampled', async () => {
		const observation = await observe([ytDlpProcess(1, true)]);

		expect(observation).toMatchObject({ ffmpegCount: 0, ffmpegThreadsOne: false });
	});

	it('waits the confirmation delay before re-reading the process table', async () => {
		const delays: number[] = [];
		const { readProcesses } = reader([ytDlpProcess(1, false)], [ytDlpProcess(1, true)]);

		await observeWorkerProcesses(readProcesses, {
			confirmationDelayMs: 250,
			wait: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});

		expect(delays).toEqual([250]);
	});
});
