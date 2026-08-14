export interface WorkerProcess {
	argvWritten: boolean;
	commandLine: string;
	mediaInput: boolean;
	n8nWorker: boolean;
	pid: number;
	program: 'ffmpeg' | 'other' | 'unattributed' | 'yt-dlp';
	rssBytes: number;
	threadRestricted: boolean;
}

export interface WorkerProcessObservation {
	ffmpegArgvUnwrittenCount: number;
	ffmpegCount: number;
	ffmpegRestrictedCount: number;
	ffmpegUnrestrictedCommandLines: string[];
	ffmpegUnrestrictedCount: number;
	ffmpegWithoutMediaInputCount: number;
	unattributedArgvUnwrittenCount: number;
	workerRssBytes: number;
	ytDlpArgvUnwrittenCount: number;
	ytDlpCount: number;
	ytDlpMissingFfmpegThreadRestrictionCount: number;
}

export interface ThreadRestrictionVerdict {
	ffmpegArgvUnwrittenTotal: number;
	ffmpegProcessPeak: number;
	ffmpegThreadRestrictionObserved: boolean;
	ffmpegUnrestrictedCommandLines: string[];
	ffmpegWithoutMediaInputTotal: number;
	ffmpegWithoutThreadRestrictionObserved: boolean;
	observationCount: number;
	proven: boolean;
	unattributedArgvUnwrittenTotal: number;
	ytDlpArgvUnwrittenTotal: number;
	ytDlpProcessPeak: number;
	ytDlpWithoutFfmpegThreadRestrictionObserved: boolean;
}

export function parseWorkerProcessSample(sample: string): WorkerProcess[];

export function summarizeWorkerProcesses(processes: WorkerProcess[]): WorkerProcessObservation;

export function evaluateThreadRestriction(
	observations: WorkerProcessObservation[],
): ThreadRestrictionVerdict;
