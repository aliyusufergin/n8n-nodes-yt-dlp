export interface WorkerProcess {
	argvWritten: boolean;
	n8nWorker: boolean;
	pid: number;
	program: 'ffmpeg' | 'other' | 'yt-dlp';
	rssBytes: number;
	threadRestricted: boolean;
}

export interface WorkerProcessObservation {
	ffmpegArgvUnwrittenCount: number;
	ffmpegCount: number;
	ffmpegRestrictedCount: number;
	ffmpegUnrestrictedCount: number;
	workerRssBytes: number;
	ytDlpArgvUnwrittenCount: number;
	ytDlpCount: number;
	ytDlpMissingFfmpegThreadRestrictionCount: number;
}

export interface ThreadRestrictionVerdict {
	ffmpegArgvUnwrittenTotal: number;
	ffmpegProcessPeak: number;
	ffmpegThreadRestrictionObserved: boolean;
	ffmpegWithoutThreadRestrictionObserved: boolean;
	observationCount: number;
	proven: boolean;
	ytDlpArgvUnwrittenTotal: number;
	ytDlpProcessPeak: number;
	ytDlpWithoutFfmpegThreadRestrictionObserved: boolean;
}

export function parseWorkerProcessSample(sample: string): WorkerProcess[];

export function summarizeWorkerProcesses(processes: WorkerProcess[]): WorkerProcessObservation;

export function evaluateThreadRestriction(
	observations: WorkerProcessObservation[],
): ThreadRestrictionVerdict;
