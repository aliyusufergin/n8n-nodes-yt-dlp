import { constants } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	opendir,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EXECUTION_WORKSPACE_PREFIX = 'n8n-nodes-yt-dlp-execution-';
export const EXECUTION_WORKSPACE_MARKER = '.owner.json';
export const STALE_WORKSPACE_AGE_MS = 3 * 60 * 60 * 1000;
export const STALE_WORKSPACE_SCAN_LIMIT = 100;
export const WORKSPACE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

const PACKAGE_NAME = 'n8n-nodes-yt-dlp';
const WORKSPACE_BASE_DIRECTORY = PACKAGE_NAME;
const OWNER_MARKER = JSON.stringify({ schemaVersion: 1, packageName: PACKAGE_NAME });

export type WorkspaceCleanupErrorCode =
	| 'STALE_WORKSPACE_CLEANUP_FAILED'
	| 'WORKSPACE_CLEANUP_FAILED';

export class WorkspaceCleanupError extends Error {
	constructor(
		readonly code: WorkspaceCleanupErrorCode,
		cause: unknown,
	) {
		super(
			code === 'STALE_WORKSPACE_CLEANUP_FAILED'
				? 'A verified stale Execution Workspace could not be removed.'
				: 'The current Execution Workspace could not be removed.',
			{ cause },
		);
		this.name = 'WorkspaceCleanupError';
	}
}

export interface ExecutionWorkspace {
	readonly path: string;
	close(options?: { preserve?: boolean }): Promise<void>;
}

export interface CreateExecutionWorkspaceOptions {
	temporaryDirectory?: string;
}

export async function removeWorkspace(
	workspacePath: string,
	errorCode: WorkspaceCleanupErrorCode = 'WORKSPACE_CLEANUP_FAILED',
): Promise<void> {
	try {
		await rm(workspacePath, {
			force: true,
			maxRetries: 2,
			recursive: true,
			retryDelay: 50,
		});
	} catch (error) {
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- Global lifecycle failures are converted at the node boundary.
		throw new WorkspaceCleanupError(errorCode, error);
	}
}

function currentUid(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error('Execution Workspaces require a Linux UID.');
	return uid;
}

async function assertWorkspaceBase(baseDirectory: string): Promise<void> {
	await mkdir(baseDirectory, { mode: 0o700, recursive: true });
	const stat = await lstat(baseDirectory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.uid !== currentUid() ||
		(stat.mode & 0o777) !== 0o700 ||
		(await realpath(baseDirectory)) !== baseDirectory
	) {
		throw new Error('The Execution Workspace base directory is not trusted.');
	}
}

async function markerIsVerifiedAndStale(
	workspacePath: string,
	nowMs: number,
): Promise<boolean> {
	try {
		const workspaceStat = await lstat(workspacePath);
		if (
			!workspaceStat.isDirectory() ||
			workspaceStat.isSymbolicLink() ||
			workspaceStat.uid !== currentUid() ||
			(workspaceStat.mode & 0o777) !== 0o700 ||
			(await realpath(workspacePath)) !== workspacePath
		) {
			return false;
		}

		const markerPath = join(workspacePath, EXECUTION_WORKSPACE_MARKER);
		const markerHandle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const markerStat = await markerHandle.stat();
			if (
				!markerStat.isFile() ||
				markerStat.nlink !== 1 ||
				markerStat.uid !== currentUid() ||
				(markerStat.mode & 0o777) !== 0o600 ||
				markerStat.size !== Buffer.byteLength(OWNER_MARKER) ||
				nowMs - markerStat.mtimeMs <= STALE_WORKSPACE_AGE_MS
			) {
				return false;
			}
			return (await markerHandle.readFile({ encoding: 'utf8' })) === OWNER_MARKER;
		} finally {
			await markerHandle.close();
		}
	} catch {
		return false;
	}
}

async function sweepStaleWorkspaces(baseDirectory: string): Promise<void> {
	const names: string[] = [];
	const directory = await opendir(baseDirectory);
	for await (const entry of directory) {
		if (!entry.name.startsWith(EXECUTION_WORKSPACE_PREFIX)) continue;
		names.push(entry.name);
		if (names.length === STALE_WORKSPACE_SCAN_LIMIT) break;
	}

	for (const name of names) {
		const workspacePath = join(baseDirectory, name);
		if (!(await markerIsVerifiedAndStale(workspacePath, Date.now()))) continue;
		await removeWorkspace(workspacePath, 'STALE_WORKSPACE_CLEANUP_FAILED');
	}
}

async function heartbeatMarker(workspacePath: string): Promise<void> {
	const markerHandle = await open(
		join(workspacePath, EXECUTION_WORKSPACE_MARKER),
		constants.O_WRONLY | constants.O_NOFOLLOW,
	);
	try {
		const markerStat = await markerHandle.stat();
		if (
			!markerStat.isFile() ||
			markerStat.nlink !== 1 ||
			markerStat.uid !== currentUid() ||
			(markerStat.mode & 0o777) !== 0o600
		) {
			throw new Error('The Execution Workspace owner marker is not trusted.');
		}
		const heartbeat = new Date();
		await markerHandle.utimes(heartbeat, heartbeat);
	} finally {
		await markerHandle.close();
	}
}

export async function createExecutionWorkspace(
	options: CreateExecutionWorkspaceOptions = {},
): Promise<ExecutionWorkspace> {
	const temporaryDirectory = await realpath(options.temporaryDirectory ?? tmpdir());
	const baseDirectory = join(temporaryDirectory, WORKSPACE_BASE_DIRECTORY);
	await assertWorkspaceBase(baseDirectory);
	await sweepStaleWorkspaces(baseDirectory);

	const workspacePath = await mkdtemp(join(baseDirectory, EXECUTION_WORKSPACE_PREFIX));
	try {
		await writeFile(join(workspacePath, EXECUTION_WORKSPACE_MARKER), OWNER_MARKER, {
			flag: 'wx',
			mode: 0o600,
		});
	} catch (error) {
		await removeWorkspace(workspacePath);
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- Global lifecycle failures are converted at the node boundary.
		throw error;
	}

	let closed = false;
	let heartbeatFailure: unknown;
	let heartbeat = Promise.resolve();
	let heartbeatTimer: NodeJS.Timeout;
	const scheduleHeartbeat = (): void => {
		heartbeatTimer = setTimeout(() => {
			heartbeat = heartbeatMarker(workspacePath)
				.catch((error: unknown) => {
					heartbeatFailure ??= error;
				})
				.finally(() => {
					if (!closed) scheduleHeartbeat();
				});
		}, WORKSPACE_HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	};
	scheduleHeartbeat();

	return {
		path: workspacePath,
		async close(closeOptions = {}): Promise<void> {
			if (closed) return;
			closed = true;
			clearTimeout(heartbeatTimer);
			await heartbeat;
			if (closeOptions.preserve === true) return;
			await removeWorkspace(workspacePath);
			if (heartbeatFailure !== undefined) throw heartbeatFailure;
		},
	};
}
