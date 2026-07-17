import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import type { YtDlpExecutionPlan } from './arguments';
import { YtDlpProcessTerminationError, superviseYtDlpExecutionPlan } from './process';

const MIME_TYPES: Readonly<Record<string, string>> = {
	'.aac': 'audio/aac',
	'.aiff': 'audio/aiff',
	'.alac': 'audio/alac',
	'.ass': 'text/x-ssa',
	'.avi': 'video/x-msvideo',
	'.flac': 'audio/flac',
	'.flv': 'video/x-flv',
	'.gif': 'image/gif',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.lrc': 'text/plain',
	'.m4a': 'audio/mp4',
	'.mka': 'audio/x-matroska',
	'.mkv': 'video/x-matroska',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.png': 'image/png',
	'.srt': 'application/x-subrip',
	'.vtt': 'text/vtt',
	'.vorbis': 'audio/vorbis',
	'.wav': 'audio/wav',
	'.webm': 'video/webm',
	'.webp': 'image/webp',
};

export interface SingleFileDownloadOptions {
	executablePath: string;
	workspaceParent?: string;
}

function createWorkspacePlan(
	plan: YtDlpExecutionPlan,
	artifactsDirectory: string,
	tempDirectory: string,
): YtDlpExecutionPlan {
	const sourceSeparatorIndex = plan.argv.lastIndexOf('--');
	if (sourceSeparatorIndex < 0) throw new Error('The execution plan has no Source URL separator.');

	return {
		argv: [
			...plan.argv.slice(0, sourceSeparatorIndex),
			'--abort-on-error',
			'--no-progress',
			'--paths',
			artifactsDirectory,
			'--paths',
			`temp:${tempDirectory}`,
			'--output',
			'%(autonumber)06d-%(id)s.%(ext)s',
			'--restrict-filenames',
			'--trim-filenames',
			'160',
			...plan.argv.slice(sourceSeparatorIndex),
		],
	};
}

export async function executeSingleFileDownload(
	execution: IExecuteFunctions,
	plan: YtDlpExecutionPlan,
	itemIndex: number,
	options: SingleFileDownloadOptions,
): Promise<INodeExecutionData[]> {
	const workspace = await mkdtemp(
		join(options.workspaceParent ?? tmpdir(), 'n8n-nodes-yt-dlp-'),
	);
	const artifactsDirectory = join(workspace, 'artifacts');
	const tempDirectory = join(workspace, 'temp');
	const controlDirectory = join(workspace, 'control');
	let cleanupAllowed = true;

	try {
		await Promise.all(
			[artifactsDirectory, tempDirectory, controlDirectory].map(
				async (directory) => await mkdir(directory, { mode: 0o700 }),
			),
		);
		const workspacePlan = createWorkspacePlan(plan, artifactsDirectory, tempDirectory);
		await superviseYtDlpExecutionPlan(options.executablePath, workspacePlan, {
			cwd: workspace,
			signal: execution.getExecutionCancelSignal(),
		}).catch((error: unknown) => {
			if (error instanceof YtDlpProcessTerminationError && !error.processClosed) {
				cleanupAllowed = false;
			}
			return Promise.reject(error);
		});

		const artifactNames = await readdir(artifactsDirectory);
		if (artifactNames.length !== 1) {
			throw new Error('The download request did not produce exactly one Artifact.');
		}

		const fileName = artifactNames[0];
		const artifactPath = join(artifactsDirectory, fileName);
		const artifactStat = await stat(artifactPath);
		if (!artifactStat.isFile()) throw new Error('The download request produced an invalid Artifact.');

		const extension = extname(fileName).toLowerCase();
		const mimeType = MIME_TYPES[extension] ?? 'application/octet-stream';
		const binaryData = await execution.helpers.prepareBinaryData(
			createReadStream(artifactPath),
			fileName,
			mimeType,
		);

		return [
			{
				json: {
					status: 'success',
					artifactIndex: 1,
					artifactCount: 1,
					fileName,
					mimeType,
					sizeBytes: artifactStat.size,
				},
				binary: { data: binaryData },
				pairedItem: { item: itemIndex },
			},
		];
	} finally {
		if (cleanupAllowed) {
			await rm(workspace, { recursive: true, maxRetries: 2, retryDelay: 50 });
		}
	}
}
