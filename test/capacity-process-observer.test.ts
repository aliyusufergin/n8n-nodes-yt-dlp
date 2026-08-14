import { describe, expect, it } from 'vitest';

import {
	evaluateThreadRestriction,
	parseWorkerProcessSample,
	summarizeWorkerProcesses,
} from '../e2e/n8n-2.27.4/process-observer.mjs';

const restrictedYtDlpArguments =
	'/opt/n8n-nodes-yt-dlp/yt-dlp --postprocessor-args ffmpeg:-threads 1 -o /tmp/out.%(ext)s http://fixture:8080/capacity-playlist';
const unrestrictedYtDlpArguments =
	'/opt/n8n-nodes-yt-dlp/yt-dlp -o /tmp/out.%(ext)s http://fixture:8080/capacity-playlist';
// The Platform Paketi launches every tool through the bundled loader, so these are the argument
// vectors and `comm` values a packaged process really reports, captured from `docker top` inside
// the pinned n8n image.
const packageRoot = '/home/node/.n8n/nodes/node_modules/n8n-nodes-yt-dlp-linux-x64';
const glibcLoader = `${packageRoot}/runtime/glibc/ld-linux-x86-64.so.2 --library-path ${packageRoot}/runtime/glibc`;
const muslLoader = `${packageRoot}/runtime/musl/ld-musl-x86_64.so.1 --library-path ${packageRoot}/runtime/musl`;
const restrictedFfmpegArguments = `${glibcLoader} ${packageRoot}/bin/ffmpeg.gnu -y -i file:/tmp/out.mp4 -map 0 -dn -ignore_unknown -threads 1 file:/tmp/out.mkv`;
const unrestrictedFfmpegArguments = `${glibcLoader} ${packageRoot}/bin/ffmpeg.gnu -y -i file:/tmp/out.mp4 -map 0 -dn -ignore_unknown file:/tmp/out.mkv`;
const loaderYtDlpArguments = `${muslLoader} ${packageRoot}/bin/yt-dlp.musl --postprocessor-args ffmpeg:-threads 1 --ffmpeg-location ${packageRoot}/bin/ffmpeg http://fixture:8080/recode.mp4`;
const pyInstallerYtDlpArguments = `${packageRoot}/runtime/musl/ld-musl-x86_64.so.1 ${packageRoot}/bin/yt-dlp.musl --postprocessor-args ffmpeg:-threads 1 --ffmpeg-location ${packageRoot}/bin/ffmpeg http://fixture:8080/recode.mp4`;

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

		expect(processes).toMatchObject([
			{ argvWritten: true, n8nWorker: true, pid: 7, program: 'other', rssBytes: 327176 * 1024 },
			{
				argvWritten: true,
				mediaInput: true,
				n8nWorker: false,
				pid: 1240,
				program: 'yt-dlp',
				rssBytes: 4096 * 1024,
				threadRestricted: true,
			},
			{
				argvWritten: true,
				mediaInput: true,
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
			ffmpegRestrictedCount: 1,
			ffmpegUnrestrictedCommandLines: [],
			ffmpegUnrestrictedCount: 0,
			ffmpegWithoutMediaInputCount: 0,
			unattributedArgvUnwrittenCount: 0,
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
			ffmpegRestrictedCount: 0,
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

	it('reads a packaged FFmpeg through the bundled loader that hides it from comm', () => {
		expect(
			summarize([row(1241, 82136, 'ld-linux-x86-64', restrictedFfmpegArguments)]),
		).toMatchObject({
			ffmpegArgvUnwrittenCount: 0,
			ffmpegCount: 1,
			ffmpegRestrictedCount: 1,
			ffmpegUnrestrictedCount: 0,
		});
	});

	it('counts a loader-launched FFmpeg without the restriction as a violation', () => {
		expect(
			summarize([row(1241, 82136, 'ld-linux-x86-64', unrestrictedFfmpegArguments)]),
		).toMatchObject({ ffmpegCount: 1, ffmpegRestrictedCount: 0, ffmpegUnrestrictedCount: 1 });
	});

	it('counts both processes of one packaged yt-dlp invocation', () => {
		expect(
			summarize([
				row(1240, 928, 'ld-musl-x86_64.', loaderYtDlpArguments),
				row(1241, 69220, 'yt-dlp', pyInstallerYtDlpArguments),
			]),
		).toMatchObject({
			ffmpegCount: 0,
			ytDlpCount: 2,
			ytDlpMissingFfmpegThreadRestrictionCount: 0,
		});
	});

	it('does not read a yt-dlp process as FFmpeg because its argv points at FFmpeg', () => {
		expect(summarize([row(1240, 928, 'ld-musl-x86_64.', loaderYtDlpArguments)])).toMatchObject({
			ffmpegCount: 0,
			ytDlpCount: 1,
		});
	});

	it('reports a loader read with no argv as unattributed rather than as a pass', () => {
		expect(
			summarize([
				row(1241, 512, 'ld-linux-x86-64', '[ld-linux-x86-64]'),
				row(1242, 512, 'ld-musl-x86_64.', '[ld-musl-x86_64.]'),
			]),
		).toMatchObject({
			ffmpegCount: 0,
			unattributedArgvUnwrittenCount: 2,
			ytDlpCount: 0,
		});
	});

	it('still attributes a launcher caught inside its own execve window', () => {
		expect(summarize([row(1241, 512, 'ffmpeg', '[ffmpeg]')])).toMatchObject({
			ffmpegArgvUnwrittenCount: 1,
			ffmpegCount: 1,
			unattributedArgvUnwrittenCount: 0,
		});
	});

	it('excludes an FFmpeg invocation that opens no media input from the restriction counts', () => {
		expect(
			summarize([row(1241, 8192, 'ld-linux-x86-64', `${glibcLoader} ${packageRoot}/bin/ffmpeg.gnu -version`)]),
		).toMatchObject({
			ffmpegCount: 1,
			ffmpegRestrictedCount: 0,
			ffmpegUnrestrictedCount: 0,
			ffmpegWithoutMediaInputCount: 1,
		});
	});

	it('records the command line of an FFmpeg process that works on media without the restriction', () => {
		expect(
			summarize([row(1241, 82136, 'ld-linux-x86-64', unrestrictedFfmpegArguments)]),
		).toMatchObject({
			ffmpegUnrestrictedCommandLines: [unrestrictedFfmpegArguments],
			ffmpegUnrestrictedCount: 1,
			ffmpegWithoutMediaInputCount: 0,
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

describe('capacity lane thread-restriction verdict', () => {
	const restrictedYtDlp = row(1240, 4096, 'yt-dlp', restrictedYtDlpArguments);
	const restrictedFfmpeg = row(1241, 8192, 'ffmpeg', restrictedFfmpegArguments);

	function evaluate(observations: string[][]) {
		return evaluateThreadRestriction(observations.map((rows) => summarize(rows)));
	}

	it('proves the restriction from a sampled FFmpeg process that carries it', () => {
		expect(evaluate([[restrictedYtDlp], [restrictedYtDlp, restrictedFfmpeg]])).toEqual({
			ffmpegArgvUnwrittenTotal: 0,
			ffmpegProcessPeak: 1,
			ffmpegThreadRestrictionObserved: true,
			ffmpegUnrestrictedCommandLines: [],
			ffmpegWithoutMediaInputTotal: 0,
			ffmpegWithoutThreadRestrictionObserved: false,
			observationCount: 2,
			proven: true,
			unattributedArgvUnwrittenTotal: 0,
			ytDlpArgvUnwrittenTotal: 0,
			ytDlpProcessPeak: 1,
			ytDlpWithoutFfmpegThreadRestrictionObserved: false,
		});
	});

	it('refuses to prove the restriction from an FFmpeg that only reported its version', () => {
		expect(
			evaluate([
				[
					restrictedYtDlp,
					row(1241, 8192, 'ld-linux-x86-64', `${glibcLoader} ${packageRoot}/bin/ffmpeg.gnu -version`),
				],
			]),
		).toMatchObject({
			ffmpegProcessPeak: 1,
			ffmpegThreadRestrictionObserved: false,
			ffmpegWithoutMediaInputTotal: 1,
			ffmpegWithoutThreadRestrictionObserved: false,
			proven: false,
		});
	});

	it('surfaces the command lines behind a failed verdict', () => {
		expect(
			evaluate([
				[restrictedYtDlp, restrictedFfmpeg],
				[restrictedYtDlp, row(1242, 8192, 'ld-linux-x86-64', unrestrictedFfmpegArguments)],
			]),
		).toMatchObject({
			ffmpegUnrestrictedCommandLines: [unrestrictedFfmpegArguments],
			proven: false,
		});
	});

	it('refuses to prove the restriction when no FFmpeg process was sampled at all', () => {
		expect(evaluate([[restrictedYtDlp], [restrictedYtDlp]])).toMatchObject({
			ffmpegProcessPeak: 0,
			ffmpegThreadRestrictionObserved: false,
			ffmpegWithoutThreadRestrictionObserved: false,
			proven: false,
		});
	});

	it('refuses to prove the restriction from an FFmpeg process whose argv it could not read', () => {
		expect(
			evaluate([[restrictedYtDlp, row(1241, 512, 'ffmpeg', '[ffmpeg]')]]),
		).toMatchObject({
			ffmpegArgvUnwrittenTotal: 1,
			ffmpegProcessPeak: 1,
			ffmpegThreadRestrictionObserved: false,
			proven: false,
		});
	});

	it('refuses to prove the restriction when no yt-dlp process was sampled at all', () => {
		expect(evaluate([[restrictedFfmpeg]])).toMatchObject({
			ffmpegThreadRestrictionObserved: true,
			proven: false,
			ytDlpProcessPeak: 0,
		});
	});

	it('fails the verdict on a single unrestricted FFmpeg observation', () => {
		expect(
			evaluate([
				[restrictedYtDlp, restrictedFfmpeg],
				[restrictedYtDlp, row(1242, 8192, 'ffmpeg', unrestrictedFfmpegArguments)],
			]),
		).toMatchObject({
			ffmpegThreadRestrictionObserved: true,
			ffmpegWithoutThreadRestrictionObserved: true,
			proven: false,
		});
	});

	it('fails the verdict on a single yt-dlp observation missing the restriction', () => {
		expect(
			evaluate([
				[restrictedYtDlp, restrictedFfmpeg],
				[row(1243, 4096, 'yt-dlp', unrestrictedYtDlpArguments)],
			]),
		).toMatchObject({
			proven: false,
			ytDlpWithoutFfmpegThreadRestrictionObserved: true,
		});
	});

	it('keeps an unwritten-argv read out of the verdict in either direction', () => {
		expect(
			evaluate([
				[restrictedYtDlp, restrictedFfmpeg],
				[row(1244, 512, 'yt-dlp', '[yt-dlp]'), row(1245, 512, 'ffmpeg', '[ffmpeg]')],
			]),
		).toMatchObject({
			ffmpegArgvUnwrittenTotal: 1,
			proven: true,
			ytDlpArgvUnwrittenTotal: 1,
		});
	});

	it('refuses to prove the restriction from no observation at all', () => {
		expect(evaluateThreadRestriction([])).toMatchObject({
			ffmpegProcessPeak: 0,
			observationCount: 0,
			proven: false,
			ytDlpProcessPeak: 0,
		});
	});
});
