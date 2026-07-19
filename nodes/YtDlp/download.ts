import { constants, type Stats } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rm,
	type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';

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

export interface DownloadRequestOptions {
	executablePath: string;
	workspaceParent?: string;
}

interface ValidatedArtifact {
	fileName: string;
	fileHandle: FileHandle;
	stat: Stats;
}

interface PinnedDirectory {
	path: string;
	fileHandle: FileHandle;
	realPath: string;
	stat: Stats;
}

function invalidArtifactSet(): Error {
	return new Error('The download request produced an invalid Artifact set.');
}

async function closeArtifacts(artifacts: readonly ValidatedArtifact[]): Promise<void> {
	await Promise.all(artifacts.map(async ({ fileHandle }) => await fileHandle.close()));
}

function descriptorPath(directory: PinnedDirectory): string {
	return `/proc/self/fd/${directory.fileHandle.fd}`;
}

async function pinDirectory(path: string): Promise<PinnedDirectory> {
	const realPath = await realpath(path);
	const fileHandle = await open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const stat = await fileHandle.stat();
		if (!stat.isDirectory()) throw invalidArtifactSet();
		return { path, fileHandle, realPath, stat };
	} catch {
		await fileHandle.close();
		throw invalidArtifactSet();
	}
}

async function assertDirectoryIdentity(directory: PinnedDirectory): Promise<void> {
	const [pathStat, descriptorStat, currentRealPath] = await Promise.all([
		lstat(directory.path),
		directory.fileHandle.stat(),
		realpath(directory.path),
	]);
	if (
		!pathStat.isDirectory() ||
		!descriptorStat.isDirectory() ||
		pathStat.dev !== directory.stat.dev ||
		pathStat.ino !== directory.stat.ino ||
		descriptorStat.dev !== directory.stat.dev ||
		descriptorStat.ino !== directory.stat.ino ||
		currentRealPath !== directory.realPath
	) {
		throw invalidArtifactSet();
	}
}

async function validateArtifactSet(directory: PinnedDirectory): Promise<ValidatedArtifact[]> {
	const artifacts: ValidatedArtifact[] = [];
	try {
		await assertDirectoryIdentity(directory);
		const descriptorDirectoryPath = descriptorPath(directory);
		const artifactNames = (await readdir(descriptorDirectoryPath)).sort();
		if (artifactNames.length === 0) throw invalidArtifactSet();

		for (const fileName of artifactNames) {
			await assertDirectoryIdentity(directory);
			const artifactPath = join(descriptorDirectoryPath, fileName);

			const pathStat = await lstat(artifactPath);
			if (!pathStat.isFile() || pathStat.nlink !== 1) throw invalidArtifactSet();

			const fileHandle = await open(
				artifactPath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const descriptorStat = await fileHandle.stat();
				if (
					!descriptorStat.isFile() ||
					descriptorStat.nlink !== 1 ||
					descriptorStat.dev !== pathStat.dev ||
					descriptorStat.ino !== pathStat.ino ||
					(await realpath(dirname(artifactPath))) !== directory.realPath
				) {
					throw invalidArtifactSet();
				}
				await assertDirectoryIdentity(directory);
				artifacts.push({ fileName, fileHandle, stat: descriptorStat });
			} catch {
				await fileHandle.close();
				throw invalidArtifactSet();
			}
		}

		if ((await readdir(descriptorDirectoryPath)).sort().join('\0') !== artifactNames.join('\0')) {
			throw invalidArtifactSet();
		}
		await assertDirectoryIdentity(directory);
		return artifacts;
	} catch {
		await closeArtifacts(artifacts);
		throw invalidArtifactSet();
	}
}

async function assertArtifactSetUnchanged(
	directory: PinnedDirectory,
	artifacts: readonly ValidatedArtifact[],
): Promise<void> {
	await assertDirectoryIdentity(directory);
	const directoryPath = descriptorPath(directory);
	const expectedNames = artifacts.map(({ fileName }) => fileName);
	if ((await readdir(directoryPath)).sort().join('\0') !== expectedNames.join('\0')) {
		throw invalidArtifactSet();
	}

	for (const artifact of artifacts) {
		const [pathStat, descriptorStat] = await Promise.all([
			lstat(join(directoryPath, artifact.fileName)),
			artifact.fileHandle.stat(),
		]);
		if (
			!pathStat.isFile() ||
			!descriptorStat.isFile() ||
			pathStat.nlink !== 1 ||
			descriptorStat.nlink !== 1 ||
			pathStat.dev !== artifact.stat.dev ||
			pathStat.ino !== artifact.stat.ino ||
			descriptorStat.dev !== artifact.stat.dev ||
			descriptorStat.ino !== artifact.stat.ino ||
			descriptorStat.size !== artifact.stat.size
		) {
			throw invalidArtifactSet();
		}
	}
	await assertDirectoryIdentity(directory);
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

export async function executeDownloadRequest(
	execution: IExecuteFunctions,
	plan: YtDlpExecutionPlan,
	itemIndex: number,
	options: DownloadRequestOptions,
): Promise<INodeExecutionData[]> {
	const workspace = await mkdtemp(
		join(options.workspaceParent ?? tmpdir(), 'n8n-nodes-yt-dlp-'),
	);
	const artifactsDirectory = join(workspace, 'artifacts');
	const tempDirectory = join(workspace, 'temp');
	const controlDirectory = join(workspace, 'control');
	let cleanupAllowed = true;
	let artifacts: ValidatedArtifact[] = [];
	const pinnedDirectories: PinnedDirectory[] = [];

	try {
		await Promise.all(
			[artifactsDirectory, tempDirectory, controlDirectory].map(
				async (directory) => await mkdir(directory, { mode: 0o700 }),
			),
		);
		const artifactsDirectoryIdentity = await pinDirectory(artifactsDirectory);
		pinnedDirectories.push(artifactsDirectoryIdentity);
		const tempDirectoryIdentity = await pinDirectory(tempDirectory);
		pinnedDirectories.push(tempDirectoryIdentity);
		const controlDirectoryIdentity = await pinDirectory(controlDirectory);
		pinnedDirectories.push(controlDirectoryIdentity);
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

		await Promise.all([
			assertDirectoryIdentity(artifactsDirectoryIdentity),
			assertDirectoryIdentity(tempDirectoryIdentity),
			assertDirectoryIdentity(controlDirectoryIdentity),
		]);
		const [workspaceNames, temporaryNames, controlNames] = await Promise.all([
			readdir(workspace),
			readdir(descriptorPath(tempDirectoryIdentity)),
			readdir(descriptorPath(controlDirectoryIdentity)),
		]);
		if (
			workspaceNames.sort().join('\0') !== 'artifacts\0control\0temp' ||
			temporaryNames.length > 0 ||
			controlNames.length > 0
		) {
			throw new Error('The download request left unexpected workspace residue.');
		}
		await Promise.all([
			assertDirectoryIdentity(tempDirectoryIdentity),
			assertDirectoryIdentity(controlDirectoryIdentity),
		]);

		artifacts = await validateArtifactSet(artifactsDirectoryIdentity);
		const outputItems: INodeExecutionData[] = [];
		for (const [artifactIndex, artifact] of artifacts.entries()) {
			await assertArtifactSetUnchanged(artifactsDirectoryIdentity, artifacts);
			const extension = extname(artifact.fileName).toLowerCase();
			const mimeType = MIME_TYPES[extension] ?? 'application/octet-stream';
			const binaryData = await execution.helpers.prepareBinaryData(
				artifact.fileHandle.createReadStream({ autoClose: false }),
				artifact.fileName,
				mimeType,
			);
			outputItems.push({
				json: {
					status: 'success',
					artifactIndex: artifactIndex + 1,
					artifactCount: artifacts.length,
					fileName: artifact.fileName,
					mimeType,
					sizeBytes: artifact.stat.size,
				},
				binary: { data: binaryData },
				pairedItem: { item: itemIndex },
			});
		}
		return outputItems;
	} finally {
		try {
			await closeArtifacts(artifacts);
		} finally {
			try {
				await Promise.all(
					pinnedDirectories.map(async ({ fileHandle }) => await fileHandle.close()),
				);
			} finally {
				if (cleanupAllowed) {
					await rm(workspace, { recursive: true, maxRetries: 2, retryDelay: 50 });
				}
			}
		}
	}
}
