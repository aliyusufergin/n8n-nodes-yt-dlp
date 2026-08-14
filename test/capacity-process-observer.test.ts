import { describe, expect, it } from 'vitest';

import {
	parseWorkerProcessSample,
	summarizeWorkerProcesses,
} from '../e2e/n8n-2.27.4/process-observer.mjs';

const restrictedYtDlpArguments =
	'/opt/n8n-nodes-yt-dlp/yt-dlp --postprocessor-args ffmpeg:-threads 1 -o /tmp/out.%(ext)s http://fixture:8080/capacity-playlist';
const unrestrictedYtDlpArguments =
	'/opt/n8n-nodes-yt-dlp/yt-dlp -o /tmp/out.%(ext)s http://fixture:8080/capacity-playlist';

function topOutput(rows: string[]): string {
	return [
		'PID                 PPID                RSS                 COMMAND             COMMAND',
		...rows,
	].join('\n');
}

function row(pid: number, rssKiB: number, command: string, argumentsText: string): string {
	return `${pid}                1                   ${rssKiB}                 ${command}             ${argumentsText}`;
}

function summarize(rows: string[]) {
	return summarizeWorkerProcesses(parseWorkerProcessSample(topOutput(rows)));
}

describe('capacity lane worker process observer', () => {
	it('parses pid, resident memory, program, and thread-restriction state from a docker top sample', () => {
		const processes = parseWorkerProcessSample(
			topOutput([
				row(7, 327176, 'n8n', '/usr/local/bin/node /usr/local/bin/n8n worker --concurrency 10'),
				row(1240, 4096, 'yt-dlp', restrictedYtDlpArguments),
				row(1241, 8192, 'ffmpeg', '/opt/n8n-nodes-yt-dlp/ffmpeg -threads 1 -i a.mp4 out.mp4'),
			]),
		);

		expect(processes).toEqual([
			{
				argvWritten: true,
				n8nWorker: true,
				pid: 7,
				program: 'other',
				rssBytes: 327176 * 1024,
				threadRestricted: false,
			},
			{
				argvWritten: true,
				n8nWorker: false,
				pid: 1240,
				program: 'yt-dlp',
				rssBytes: 4096 * 1024,
				threadRestricted: true,
			},
			{
				argvWritten: true,
				n8nWorker: false,
				pid: 1241,
				program: 'ffmpeg',
				rssBytes: 8192 * 1024,
				threadRestricted: true,
			},
		]);
	});

	it('marks a process still inside its execve window as carrying no argv to check', () => {
		const processes = parseWorkerProcessSample(
			topOutput([
				row(1242, 512, 'yt-dlp', '[yt-dlp]'),
				row(1243, 512, 'yt-dlp', unrestrictedYtDlpArguments),
			]),
		);

		expect(processes).toMatchObject([
			{ argvWritten: false, pid: 1242, program: 'yt-dlp', threadRestricted: false },
			{ argvWritten: true, pid: 1243, program: 'yt-dlp', threadRestricted: false },
		]);
	});

	it('sums worker resident memory and counts every packaged process in the sample', () => {
		expect(
			summarize([
				row(7, 327176, 'n8n', '/usr/local/bin/node /usr/local/bin/n8n worker --concurrency 10'),
				row(8, 100, 'n8n', '/usr/local/bin/node /usr/local/bin/n8n worker --concurrency 10'),
				row(1240, 4096, 'yt-dlp', restrictedYtDlpArguments),
				row(1241, 4096, 'yt-dlp', restrictedYtDlpArguments),
				row(1242, 8192, 'ffmpeg', '/opt/n8n-nodes-yt-dlp/ffmpeg -threads 1 -i a.mp4 out.mp4'),
			]),
		).toEqual({
			ffmpegArgvUnwrittenCount: 0,
			ffmpegCount: 1,
			ffmpegUnrestrictedCount: 0,
			workerRssBytes: (327176 + 100) * 1024,
			ytDlpArgvUnwrittenCount: 0,
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
		});
	});

	it('reports an execve-window read as an unwritten argv rather than as a violation', () => {
		expect(
			summarize([
				row(1240, 4096, 'yt-dlp', restrictedYtDlpArguments),
				row(1241, 512, 'yt-dlp', '[yt-dlp]'),
			]),
		).toMatchObject({
			ytDlpArgvUnwrittenCount: 1,
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
		});
	});

	it('never folds an execve-window read into a restriction count in either direction', () => {
		expect(summarize([row(1241, 512, 'ffmpeg', '[ffmpeg]')])).toMatchObject({
			ffmpegArgvUnwrittenCount: 1,
			ffmpegCount: 1,
			ffmpegUnrestrictedCount: 0,
		});
	});

	it('counts a yt-dlp process whose written argv carries no restriction as a violation', () => {
		expect(
			summarize([
				row(1240, 4096, 'yt-dlp', restrictedYtDlpArguments),
				row(1241, 4096, 'yt-dlp', unrestrictedYtDlpArguments),
			]),
		).toMatchObject({
			ytDlpArgvUnwrittenCount: 0,
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 1,
		});
	});

	it('counts a short-lived unrestricted process the first time it is sampled', () => {
		expect(summarize([row(1241, 4096, 'yt-dlp', unrestrictedYtDlpArguments)])).toMatchObject({
			ytDlpMissingFfmpegThreadRestrictionCount: 1,
		});
	});

	it('counts an ffmpeg process whose written argv carries no one-thread restriction as a violation', () => {
		expect(
			summarize([row(1241, 8192, 'ffmpeg', '/opt/n8n-nodes-yt-dlp/ffmpeg -i a.mp4 out.mp4')]),
		).toMatchObject({
			ffmpegArgvUnwrittenCount: 0,
			ffmpegCount: 1,
			ffmpegUnrestrictedCount: 1,
		});
	});

	it('does not treat an unrelated worker process as a packaged program', () => {
		expect(
			summarize([row(9, 2048, 'node', '/usr/local/bin/node /usr/local/bin/n8n worker')]),
		).toMatchObject({ ffmpegCount: 0, ytDlpCount: 0 });
	});

	it('rejects a process line it cannot parse instead of silently dropping it', () => {
		expect(() => parseWorkerProcessSample(topOutput(['not a process line'])),).toThrow(
			'Cannot parse worker process sample',
		);
	});
});
