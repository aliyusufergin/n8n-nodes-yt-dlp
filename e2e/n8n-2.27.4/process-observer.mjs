const workerProcessLine = /^\s*(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(.*)$/u;
const ffmpegCommand = /^ffmpeg(?:\.gnu)?$/u;
const ytDlpCommand = /^yt-dlp(?:\.musl)?$/u;
const ytDlpFfmpegThreadRestriction =
	/(?:^|\s)--postprocessor-args\s+ffmpeg:-threads\s+1(?:\s|$)/u;

/**
 * Parses one `docker top <container> -eo pid,ppid,rss,comm,args` sample.
 *
 * A process caught inside the execve window reports its new `comm` while
 * `/proc/<pid>/cmdline` is still empty or partly written, so `args` can be the
 * bracketed comm or a short prefix. Such a row parses as carrying no thread
 * restriction; `observeWorkerProcesses` is what separates that unfinished read
 * from a real violation.
 */
export function parseWorkerProcessSample(sample) {
	return sample
		.trim()
		.split('\n')
		.slice(1)
		.map((line) => {
			const match = workerProcessLine.exec(line);
			if (!match) throw new Error(`Cannot parse worker process sample: ${line}`);
			const command = match[3];
			const argumentsText = match[4].trim();
			const arguments_ = argumentsText.split(/\s+/u);
			const ffmpeg = ffmpegCommand.test(command);
			const ytDlp = ytDlpCommand.test(command);
			return {
				ffmpeg,
				ffmpegThreadsOne:
					ffmpeg &&
					arguments_.some(
						(argument, index) =>
							argument === '-threads' && arguments_[index + 1] === '1',
					),
				n8nWorker: arguments_.some(
					(argument, index) =>
						argument.endsWith('/n8n') && arguments_[index + 1] === 'worker',
				),
				pid: Number(match[1]),
				rssBytes: Number(match[2]) * 1024,
				ytDlp,
				ytDlpFfmpegThreadsOne: ytDlp && ytDlpFfmpegThreadRestriction.test(argumentsText),
			};
		});
}

function isRestrictionSuspect(process_) {
	return (
		(process_.ffmpeg && !process_.ffmpegThreadsOne) ||
		(process_.ytDlp && !process_.ytDlpFfmpegThreadsOne)
	);
}

async function confirmedSuspectPids(suspects, readProcesses, confirmationDelayMs, wait) {
	await wait(confirmationDelayMs);
	const reread = new Map(
		(await readProcesses()).map((process_) => [process_.pid, process_]),
	);
	return new Set(
		suspects
			.filter((suspect) => {
				const confirmation = reread.get(suspect.pid);
				return (
					confirmation !== undefined &&
					confirmation.ffmpeg === suspect.ffmpeg &&
					confirmation.ytDlp === suspect.ytDlp &&
					isRestrictionSuspect(confirmation)
				);
			})
			.map(({ pid }) => pid),
	);
}

/**
 * Observes the worker process table once and reports the thread-restriction
 * state of every packaged yt-dlp and FFmpeg process in it.
 *
 * Counts and worker memory come from the first read alone, so peaks stay a
 * measurement of that instant. Only processes that read as unrestricted are
 * re-read: a real unrestricted process is still unrestricted on the second
 * read and is counted as a violation, while a process whose argv was merely
 * unfinished, whose pid vanished, or whose pid now belongs to another program
 * is counted as unconfirmed instead. An unconfirmed read is a measurement the
 * observer could not complete, not a permitted violation.
 */
export async function observeWorkerProcesses(readProcesses, options = {}) {
	const {
		confirmationDelayMs = 250,
		wait = async (milliseconds) =>
			await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
	} = options;
	const processes = await readProcesses();
	const suspects = processes.filter((process_) => isRestrictionSuspect(process_));
	const confirmed =
		suspects.length === 0
			? new Set()
			: await confirmedSuspectPids(suspects, readProcesses, confirmationDelayMs, wait);
	const ffmpegSuspects = suspects.filter(({ ffmpeg }) => ffmpeg);
	const ytDlpSuspects = suspects.filter(({ ytDlp }) => ytDlp);
	const ffmpegUnrestrictedCount = ffmpegSuspects.filter(({ pid }) => confirmed.has(pid)).length;
	const ffmpegCount = processes.filter(({ ffmpeg }) => ffmpeg).length;
	return {
		ffmpegCount,
		ffmpegThreadsOne: ffmpegCount > 0 && ffmpegUnrestrictedCount === 0,
		ffmpegUnconfirmedRestrictionReadCount: ffmpegSuspects.length - ffmpegUnrestrictedCount,
		ffmpegUnrestrictedCount,
		workerRssBytes: processes
			.filter(({ n8nWorker }) => n8nWorker)
			.reduce((total, process_) => total + process_.rssBytes, 0),
		ytDlpCount: processes.filter(({ ytDlp }) => ytDlp).length,
		ytDlpMissingFfmpegThreadRestrictionCount: ytDlpSuspects.filter(({ pid }) =>
			confirmed.has(pid),
		).length,
		ytDlpUnconfirmedFfmpegThreadRestrictionCount: ytDlpSuspects.filter(
			({ pid }) => !confirmed.has(pid),
		).length,
	};
}
