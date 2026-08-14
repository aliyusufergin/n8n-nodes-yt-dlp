const workerProcessLine = /^\s*(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(.*)$/u;
const ffmpegCommand = /^ffmpeg(?:\.gnu)?$/u;
const ytDlpCommand = /^yt-dlp(?:\.musl)?$/u;
const bundledLoaderFileName = /^ld-(?:linux-x86-64\.so\.2|musl-x86_64\.so\.1)$/u;
// `comm` is the first fifteen bytes of the file name, which is all the kernel keeps.
const bundledLoaderCommand = /^ld-(?:linux-x86-64|musl-x86_64\.)$/u;
const ytDlpFfmpegThreadRestriction =
	/(?:^|\s)--postprocessor-args\s+ffmpeg:-threads\s+1(?:\s|$)/u;
const unwrittenArgv = /^(?:|\[.*\])$/u;

function fileName(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Resolves the packaged executable a process is running from its argv.
 *
 * `comm` cannot answer this. The Platform Paketi ships each tool as a launcher
 * at `bin/<tool>` that execs the bundled loader with the real payload, so the
 * kernel takes the process name from the loader: a packaged FFmpeg reports
 * `ld-linux-x86-64` and a packaged yt-dlp reports `ld-musl-x86_64.`, never the
 * tool's own name. Matching `comm` therefore missed every FFmpeg the lane ever
 * ran and only ever caught the launcher inside its own execve window. yt-dlp
 * was visible only by accident: its PyInstaller bootloader forks a child that
 * does report `yt-dlp`, so the parent bootloader went uncounted.
 *
 * The argv is unambiguous where `comm` is not. A loader invocation names the
 * payload it is about to run, after an optional `--library-path` pair, and a
 * direct invocation names the executable in the first token. Reading the
 * executable rather than scanning the whole command line also keeps a yt-dlp
 * process from being read as FFmpeg because its own argv carries
 * `--ffmpeg-location`.
 */
function executableFileName(argumentsText) {
	const tokens = argumentsText.split(/\s+/u);
	let index = 0;
	if (bundledLoaderFileName.test(fileName(tokens[0]))) {
		index = 1;
		if (tokens[index] === '--library-path') index += 2;
	}
	return fileName(tokens[index] ?? '');
}

/**
 * Names the packaged program a process is running.
 *
 * A process whose argv the kernel has not published yet is left with its
 * `comm`, which names the tool for a launcher caught mid-exec (`[ffmpeg]`) and
 * names the loader for the payload behind it (`[ld-linux-x86-64]`). The second
 * form cannot be attributed to one tool, so it is reported as an unattributed
 * packaged read rather than folded into either program or silently dropped
 * into `other`: it carries no argv to check and is never a violation, but it is
 * still a read the observer could not make.
 */
function program(command, argumentsText, argvWritten) {
	const name = argvWritten ? executableFileName(argumentsText) : command;
	if (ffmpegCommand.test(name)) return 'ffmpeg';
	if (ytDlpCommand.test(name)) return 'yt-dlp';
	if (!argvWritten && bundledLoaderCommand.test(name)) return 'unattributed';
	return 'other';
}

/**
 * Reports whether a packaged FFmpeg process opened a media input.
 *
 * The Toolchain Attestation probes the packaged FFmpeg with `-version` on
 * first use in every main and worker process, and yt-dlp asks the same binary
 * which bitstream filters it carries. Those invocations print and exit without
 * touching media, so ADR 0019's thread bound does not reach them and counting
 * them as violations would fail the lane on the node's own attestation. An
 * FFmpeg that does media work always names its input with `-i`, so a process
 * with no input is excluded from the restriction counts in both directions and
 * reported on its own instead of being dropped.
 */
function mediaInput(argumentsText) {
	return argumentsText.split(/\s+/u).includes('-i');
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
			const argvWritten = !unwrittenArgv.test(argumentsText);
			const program_ = program(match[3], argumentsText, argvWritten);
			return {
				argvWritten,
				n8nWorker: argumentsText
					.split(/\s+/u)
					.some(
						(argument, index, arguments_) =>
							argument.endsWith('/n8n') && arguments_[index + 1] === 'worker',
					),
				commandLine: argumentsText,
				mediaInput: program_ !== 'ffmpeg' || mediaInput(argumentsText),
				pid: Number(match[1]),
				program: program_,
				rssBytes: Number(match[2]) * 1024,
				threadRestricted: threadRestricted(program_, argumentsText),
			};
		});
}

function programCounts(processes, program_) {
	const matching = processes.filter(({ program: candidate }) => candidate === program_);
	const measurable = matching.filter(({ argvWritten, mediaInput: media }) => argvWritten && media);
	const restricted = measurable.filter(({ threadRestricted: value }) => value);
	const unrestricted = measurable.filter(({ threadRestricted: value }) => !value);
	return {
		argvUnwrittenCount: matching.filter(({ argvWritten }) => !argvWritten).length,
		count: matching.length,
		restrictedCount: restricted.length,
		unrestrictedCommandLines: unrestricted.map(({ commandLine }) => commandLine),
		unrestrictedCount: unrestricted.length,
		withoutMediaInputCount: matching.filter(
			({ argvWritten, mediaInput: media }) => argvWritten && !media,
		).length,
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
 *
 * One packaged invocation is more than one process on this toolchain. A yt-dlp
 * request is the bundled-loader bootloader plus the PyInstaller child it forks,
 * both carrying the same argument vector, so the counts read as processes and
 * not as requests.
 */
export function summarizeWorkerProcesses(processes) {
	const ffmpeg = programCounts(processes, 'ffmpeg');
	const ytDlp = programCounts(processes, 'yt-dlp');
	return {
		ffmpegArgvUnwrittenCount: ffmpeg.argvUnwrittenCount,
		ffmpegCount: ffmpeg.count,
		ffmpegRestrictedCount: ffmpeg.restrictedCount,
		ffmpegUnrestrictedCommandLines: ffmpeg.unrestrictedCommandLines,
		ffmpegUnrestrictedCount: ffmpeg.unrestrictedCount,
		ffmpegWithoutMediaInputCount: ffmpeg.withoutMediaInputCount,
		unattributedArgvUnwrittenCount: processes.filter(
			({ program: candidate }) => candidate === 'unattributed',
		).length,
		workerRssBytes: processes
			.filter(({ n8nWorker }) => n8nWorker)
			.reduce((total, process_) => total + process_.rssBytes, 0),
		ytDlpArgvUnwrittenCount: ytDlp.argvUnwrittenCount,
		ytDlpCount: ytDlp.count,
		ytDlpMissingFfmpegThreadRestrictionCount: ytDlp.unrestrictedCount,
	};
}

function total(observations, field) {
	return observations.reduce((sum, observation) => sum + observation[field], 0);
}

function peak(observations, field) {
	return observations.reduce((highest, observation) => Math.max(highest, observation[field]), 0);
}

/**
 * Turns a window of worker process observations into the lane's
 * thread-restriction verdict.
 *
 * The verdict is bounded from below on both programs before it can be proven.
 * `every(unrestricted === 0)` is satisfied for free by a window that sampled
 * neither program, and it was satisfied for free on the FFmpeg side by every
 * capacity run so far: the packaged FFmpeg lives only as long as a merge of a
 * few kilobytes, which no 100 ms sampler catches, so the boolean rested on the
 * yt-dlp command lines carrying `--postprocessor-args ffmpeg:-threads 1` and
 * on the inference that FFmpeg then honours them. ADR 0019 claims a bound on
 * FFmpeg's own threads, so the verdict now requires a packaged FFmpeg process
 * that was sampled, whose argv was readable, and that carried `-threads 1`.
 *
 * The lower bound is a restricted-process count rather than a process count:
 * an FFmpeg process sampled inside its execve window carries no argv to check,
 * and one that only reported its version did no media work, so admitting
 * either would replace one vacuous pass with another.
 */
export function evaluateThreadRestriction(observations) {
	const ffmpegThreadRestrictionObserved = observations.some(
		({ ffmpegRestrictedCount }) => ffmpegRestrictedCount > 0,
	);
	const ytDlpProcessPeak = peak(observations, 'ytDlpCount');
	const noViolation = observations.every(
		({ ffmpegUnrestrictedCount, ytDlpMissingFfmpegThreadRestrictionCount }) =>
			ffmpegUnrestrictedCount === 0 && ytDlpMissingFfmpegThreadRestrictionCount === 0,
	);
	return {
		ffmpegArgvUnwrittenTotal: total(observations, 'ffmpegArgvUnwrittenCount'),
		ffmpegProcessPeak: peak(observations, 'ffmpegCount'),
		ffmpegThreadRestrictionObserved,
		// A failed verdict has to say what failed it, so the command lines behind it are reported
		// rather than only counted. The node passes every secret through yt-dlp's stdin config, so
		// no argument vector it builds carries one.
		ffmpegUnrestrictedCommandLines: [
			...new Set(observations.flatMap(({ ffmpegUnrestrictedCommandLines }) => ffmpegUnrestrictedCommandLines)),
		],
		ffmpegWithoutMediaInputTotal: total(observations, 'ffmpegWithoutMediaInputCount'),
		ffmpegWithoutThreadRestrictionObserved: observations.some(
			({ ffmpegUnrestrictedCount }) => ffmpegUnrestrictedCount > 0,
		),
		observationCount: observations.length,
		proven: ytDlpProcessPeak > 0 && ffmpegThreadRestrictionObserved && noViolation,
		unattributedArgvUnwrittenTotal: total(observations, 'unattributedArgvUnwrittenCount'),
		ytDlpArgvUnwrittenTotal: total(observations, 'ytDlpArgvUnwrittenCount'),
		ytDlpProcessPeak,
		ytDlpWithoutFfmpegThreadRestrictionObserved: observations.some(
			({ ytDlpMissingFfmpegThreadRestrictionCount }) =>
				ytDlpMissingFfmpegThreadRestrictionCount > 0,
		),
	};
}
