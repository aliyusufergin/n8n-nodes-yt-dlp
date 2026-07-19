import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	EXECUTION_WORKSPACE_MARKER,
	EXECUTION_WORKSPACE_PREFIX,
	STALE_WORKSPACE_AGE_MS,
	STALE_WORKSPACE_SCAN_LIMIT,
	WorkspaceCleanupError,
	createExecutionWorkspace,
} from '../nodes/YtDlp/workspace';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await chmod(directory, 0o700).catch(() => {});
			await rm(directory, { recursive: true, force: true });
		}),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-workspace-test-'));
	temporaryDirectories.push(directory);
	return directory;
}

describe('Execution Workspace', () => {
	it('creates an owner-only versioned marker and removes the workspace on close', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const workspace = await createExecutionWorkspace({ temporaryDirectory });

		const workspaceStat = await lstat(workspace.path);
		const markerPath = join(workspace.path, EXECUTION_WORKSPACE_MARKER);
		const markerStat = await lstat(markerPath);
		const marker = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;

		expect(workspaceStat.isDirectory()).toBe(true);
		expect(workspaceStat.mode & 0o777).toBe(0o700);
		expect(markerStat.isFile()).toBe(true);
		expect(markerStat.nlink).toBe(1);
		expect(markerStat.mode & 0o777).toBe(0o600);
		expect(marker).toEqual({ schemaVersion: 1, packageName: 'n8n-nodes-yt-dlp' });

		await workspace.close();

		expect(await readdir(join(temporaryDirectory, 'n8n-nodes-yt-dlp'))).toEqual([]);
	});

	it('removes only verified stale roots and leaves ambiguous roots untouched', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const staleWorkspace = await createExecutionWorkspace({ temporaryDirectory });
		await staleWorkspace.close({ preserve: true });
		const oldDate = new Date(Date.now() - STALE_WORKSPACE_AGE_MS - 1);
		await utimes(join(staleWorkspace.path, EXECUTION_WORKSPACE_MARKER), oldDate, oldDate);

		const baseDirectory = join(temporaryDirectory, 'n8n-nodes-yt-dlp');
		const externalDirectory = join(temporaryDirectory, 'external');
		await mkdir(externalDirectory, { mode: 0o700 });
		await writeFile(join(externalDirectory, 'must-remain'), 'yes');
		const symlinkRoot = join(baseDirectory, `${EXECUTION_WORKSPACE_PREFIX}symlink`);
		await symlink(externalDirectory, symlinkRoot, 'dir');

		const publicMarkerRoot = join(baseDirectory, `${EXECUTION_WORKSPACE_PREFIX}public-marker`);
		await mkdir(publicMarkerRoot, { mode: 0o700 });
		await writeFile(
			join(publicMarkerRoot, EXECUTION_WORKSPACE_MARKER),
			JSON.stringify({ schemaVersion: 1, packageName: 'n8n-nodes-yt-dlp' }),
			{ mode: 0o644 },
		);
		await utimes(join(publicMarkerRoot, EXECUTION_WORKSPACE_MARKER), oldDate, oldDate);

		const linkedMarkerRoot = join(baseDirectory, `${EXECUTION_WORKSPACE_PREFIX}linked-marker`);
		await mkdir(linkedMarkerRoot, { mode: 0o700 });
		const linkedMarker = join(linkedMarkerRoot, EXECUTION_WORKSPACE_MARKER);
		await writeFile(
			linkedMarker,
			JSON.stringify({ schemaVersion: 1, packageName: 'n8n-nodes-yt-dlp' }),
			{ mode: 0o600 },
		);
		await link(linkedMarker, join(temporaryDirectory, 'marker-link'));
		await utimes(linkedMarker, oldDate, oldDate);

		const currentWorkspace = await createExecutionWorkspace({ temporaryDirectory });

		expect(await readdir(staleWorkspace.path).catch(() => undefined)).toBeUndefined();
		expect(await readFile(join(externalDirectory, 'must-remain'), 'utf8')).toBe('yes');
		expect((await lstat(symlinkRoot)).isSymbolicLink()).toBe(true);
		expect((await lstat(publicMarkerRoot)).isDirectory()).toBe(true);
		expect((await lstat(linkedMarkerRoot)).isDirectory()).toBe(true);

		await currentWorkspace.close();
	});

	it('heartbeats the owner marker no more frequently than once per minute', async () => {
		vi.useFakeTimers();
		const now = new Date();
		vi.setSystemTime(now);
		const temporaryDirectory = await createTemporaryDirectory();
		const workspace = await createExecutionWorkspace({ temporaryDirectory });
		const markerPath = join(workspace.path, EXECUTION_WORKSPACE_MARKER);
		const initialMtime = (await lstat(markerPath)).mtimeMs;

		try {
			await vi.advanceTimersByTimeAsync(59_999);
			expect((await lstat(markerPath)).mtimeMs).toBe(initialMtime);

			await vi.advanceTimersByTimeAsync(1);
			await workspace.close({ preserve: true });
			expect((await lstat(markerPath)).mtimeMs).toBeGreaterThan(initialMtime);
		} finally {
			await workspace.close();
			vi.useRealTimers();
		}
	});

	it('examines at most 100 exact-prefix direct children per execution start', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const seed = await createExecutionWorkspace({ temporaryDirectory });
		const baseDirectory = join(temporaryDirectory, 'n8n-nodes-yt-dlp');
		await seed.close();
		const oldDate = new Date(Date.now() - STALE_WORKSPACE_AGE_MS - 1);

		for (let index = 0; index <= STALE_WORKSPACE_SCAN_LIMIT; index++) {
			const root = join(baseDirectory, `${EXECUTION_WORKSPACE_PREFIX}${String(index).padStart(3, '0')}`);
			await mkdir(root, { mode: 0o700 });
			const marker = join(root, EXECUTION_WORKSPACE_MARKER);
			await writeFile(
				marker,
				JSON.stringify({ schemaVersion: 1, packageName: 'n8n-nodes-yt-dlp' }),
				{ mode: 0o600 },
			);
			await utimes(marker, oldDate, oldDate);
		}
		await mkdir(join(baseDirectory, 'unrelated-stale-root'), { mode: 0o700 });

		const currentWorkspace = await createExecutionWorkspace({ temporaryDirectory });
		const remainingNames = await readdir(baseDirectory);

		const remainingWorkspaceNames = remainingNames.filter((name) =>
			name.startsWith(EXECUTION_WORKSPACE_PREFIX),
		);
		expect(remainingWorkspaceNames).toHaveLength(2);
		expect(
			remainingWorkspaceNames.some(
				(name) => name.length === EXECUTION_WORKSPACE_PREFIX.length + 3,
			),
		).toBe(true);
		expect(remainingNames).toContain('unrelated-stale-root');

		await currentWorkspace.close();
	});

	it('reports a bounded cleanup failure as a global invariant', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const workspace = await createExecutionWorkspace({ temporaryDirectory });
		await writeFile(join(workspace.path, 'locked-file'), 'locked');
		await chmod(workspace.path, 0o500);

		const error = await workspace.close().catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(WorkspaceCleanupError);
		expect(error).toMatchObject({
			name: 'WorkspaceCleanupError',
			code: 'WORKSPACE_CLEANUP_FAILED',
		});
		await chmod(workspace.path, 0o700);
	});

	it('fails globally when a verified stale root cannot be removed', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const staleWorkspace = await createExecutionWorkspace({ temporaryDirectory });
		await staleWorkspace.close({ preserve: true });
		const markerPath = join(staleWorkspace.path, EXECUTION_WORKSPACE_MARKER);
		const oldDate = new Date(Date.now() - STALE_WORKSPACE_AGE_MS - 1);
		await utimes(markerPath, oldDate, oldDate);
		const lockedDirectory = join(staleWorkspace.path, 'locked');
		await mkdir(lockedDirectory, { mode: 0o700 });
		await writeFile(join(lockedDirectory, 'file'), 'locked');
		await chmod(lockedDirectory, 0o500);

		const error = await createExecutionWorkspace({ temporaryDirectory }).catch(
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(WorkspaceCleanupError);
		expect(error).toMatchObject({ code: 'STALE_WORKSPACE_CLEANUP_FAILED' });
		await chmod(lockedDirectory, 0o700);
	});
});
