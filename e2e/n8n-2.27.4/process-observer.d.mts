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
	ffmpegUnrestrictedCount: number;
	workerRssBytes: number;
	ytDlpArgvUnwrittenCount: number;
	ytDlpCount: number;
	ytDlpMissingFfmpegThreadRestrictionCount: number;
}

export function parseWorkerProcessSample(sample: string): WorkerProcess[];

export function summarizeWorkerProcesses(processes: WorkerProcess[]): WorkerProcessObservation;
