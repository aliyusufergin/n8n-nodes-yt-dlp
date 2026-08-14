const workerProcessLine = /^\s*(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(.*)$/u;
const ffmpegCommand = /^ffmpeg(?:\.gnu)?$/u;
const ytDlpCommand = /^yt-dlp(?:\.musl)?$/u;
const ytDlpFfmpegThreadRestriction =
	/(?:^|\s)--postprocessor-args\s+ffmpeg:-threads\s+1(?:\s|$)/u;
const unwrittenArgv = /^(?:|\[.*\])$/u;

function program(command) {
	if (ffmpegCommand.test(command)) return 'ffmpeg';
	if (ytDlpCommand.test(command)) return 'yt-dlp';
	return 'other';
}

function threadRestricted(program_, argumentsText) {
	if (program_ === 'yt-dlp') return ytDlpFfmpegThreadRestriction.test(argumentsText);
	if (program_ !== 'ffmpeg') return false;
	const arguments_ = argumentsText.split(/\s+/u);
	return arguments_.some(
		(argument, index) => argument === '-threads' && arguments_[index + 1] === '1',
	);
}

/**
 * Parses one `docker top <container> -eo pid,ppid,rss,comm,args` sample.
 *
 * A process caught inside its execve window already reports its new `comm`
 * while `/proc/<pid>/cmdline` is still unwritten, which `ps` renders as the
 * bracketed comm. Such a row carries no argv to check and is marked
 * `argvWritten: false`; the kernel publishes the argument vector in one step,
 * so a row is either bracketed or complete and never half a command line.
 */
export function parseWorkerProcessSample(sample) {
	return sample
		.trim()
		.split('\n')
		.slice(1)
		.map((line) => {
			const match = workerProcessLine.exec(line);
			if (!match) throw new Error(`Cannot parse worker process sample: ${line}`);
			const argumentsText = match[4].trim();
			const program_ = program(match[3]);
			return {
				argvWritten: !unwrittenArgv.test(argumentsText),
				n8nWorker: argumentsText
					.split(/\s+/u)
					.some(
						(argument, index, arguments_) =>
							argument.endsWith('/n8n') && arguments_[index + 1] === 'worker',
					),
				pid: Number(match[1]),
				program: program_,
				rssBytes: Number(match[2]) * 1024,
				threadRestricted: threadRestricted(program_, argumentsText),
			};
		});
}

function programCounts(processes, program_) {
	const matching = processes.filter(({ program: candidate }) => candidate === program_);
	const measurable = matching.filter(({ argvWritten }) => argvWritten);
	return {
		argvUnwrittenCount: matching.length - measurable.length,
		count: matching.length,
		unrestrictedCount: measurable.filter(({ threadRestricted: restricted }) => !restricted)
			.length,
	};
}

/**
 * Summarizes one worker process sample into the thread-restriction state of
 * every packaged yt-dlp and FFmpeg process in it.
 *
 * A process whose argv the kernel has not published yet cannot be checked, so
 * it is counted as an unwritten-argv read rather than as a violation, and it
 * is never folded into a restriction count in either direction. This does not
 * relax the invariant: the node builds the restriction into its only yt-dlp
 * spawn unconditionally, and a real invocation of either program always
 * carries a full argument vector, so a genuinely unrestricted process is
 * always measurable and is still counted the first time it is sampled.
 */
export function summarizeWorkerProcesses(processes) {
	const ffmpeg = programCounts(processes, 'ffmpeg');
	const ytDlp = programCounts(processes, 'yt-dlp');
	return {
		ffmpegArgvUnwrittenCount: ffmpeg.argvUnwrittenCount,
		ffmpegCount: ffmpeg.count,
		ffmpegUnrestrictedCount: ffmpeg.unrestrictedCount,
		workerRssBytes: processes
			.filter(({ n8nWorker }) => n8nWorker)
			.reduce((total, process_) => total + process_.rssBytes, 0),
		ytDlpArgvUnwrittenCount: ytDlp.argvUnwrittenCount,
		ytDlpCount: ytDlp.count,
		ytDlpMissingFfmpegThreadRestrictionCount: ytDlp.unrestrictedCount,
	};
}
