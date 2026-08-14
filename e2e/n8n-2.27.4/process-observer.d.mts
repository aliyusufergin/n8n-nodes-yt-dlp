export interface WorkerProcess {
	ffmpeg: boolean;
	ffmpegThreadsOne: boolean;
	n8nWorker: boolean;
	pid: number;
	rssBytes: number;
	ytDlp: boolean;
	ytDlpFfmpegThreadsOne: boolean;
}

export interface WorkerProcessObservation {
	ffmpegCount: number;
	ffmpegThreadsOne: boolean;
	ffmpegUnconfirmedRestrictionReadCount: number;
	ffmpegUnrestrictedCount: number;
	workerRssBytes: number;
	ytDlpCount: number;
	ytDlpMissingFfmpegThreadRestrictionCount: number;
	ytDlpUnconfirmedFfmpegThreadRestrictionCount: number;
}

export function parseWorkerProcessSample(sample: string): WorkerProcess[];

export function observeWorkerProcesses(
	readProcesses: () => Promise<WorkerProcess[]>,
	options?: {
		confirmationDelayMs?: number;
		wait?: (milliseconds: number) => Promise<void>;
	},
): Promise<WorkerProcessObservation>;
