import { chmod, lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeYtDlpNode, type DownloadRequestExecutor } from '../nodes/YtDlp/YtDlp.node';
import { YtDlpProcessError, YtDlpProcessTerminationError } from '../nodes/YtDlp/process';
import { MAXIMUM_EXECUTION_INPUTS } from '../nodes/YtDlp/resource-envelope';
import {
	EXECUTION_WORKSPACE_MARKER,
	EXECUTION_WORKSPACE_PREFIX,
	STALE_WORKSPACE_AGE_MS,
	WorkspaceCleanupError,
	createExecutionWorkspace,
} from '../nodes/YtDlp/workspace';

const WORKSPACE_BASE_DIRECTORY = 'n8n-nodes-yt-dlp';
const LEFTOVER_ARTIFACT = 'leftover-artifact.part';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { recursive: true, force: true })),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-execution-cleanup-test-'));
	temporaryDirectories.push(directory);
	return directory;
}

function createExecutionContext(
	itemCount = 1,
	continueOnFail = false,
): IExecuteFunctions {
	const node: INode = {
		id: 'node-id',
		name: 'yt-dlp',
		type: 'n8n-nodes-yt-dlp.ytDlp',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};

	return {
		continueOnFail: vi.fn(() => continueOnFail),
		getExecutionId: vi.fn(() => 'execution-workspace-cleanup-execution'),
		getExecutionCancelSignal: vi.fn(() => undefined),
		getInputData: vi.fn(() => Array.from({ length: itemCount }, () => ({ json: {} }))),
		getNode: vi.fn(() => node),
		getCredentials: vi.fn(async () => ({})),
		getNodeParameter: vi.fn((name: string, _itemIndex: number, fallbackValue?: unknown) => {
			if (name === 'sourceUrl') return 'https://example.com/video';
			if (name === 'arguments') return '';
			return fallbackValue;
		}),
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	} as unknown as IExecuteFunctions;
}

/** Wraps the real factory so a test can assert on the Execution Workspaces the node owns. */
function trackExecutionWorkspaces(temporaryDirectory: string): {
	startWorkspace: () => Promise<Awaited<ReturnType<typeof createExecutionWorkspace>>>;
	ownedPaths: string[];
} {
	const ownedPaths: string[] = [];
	return {
		ownedPaths,
		startWorkspace: async () => {
			const workspace = await createExecutionWorkspace({ temporaryDirectory });
			ownedPaths.push(workspace.path);
			return workspace;
		},
	};
}

/**
 * Stands in for the Download Request executor: records the workspace it was handed, proves the
 * owner marker is in place, leaves a partial artifact behind, then settles as the test asks.
 */
function observeRequests(settle: () => Promise<INodeExecutionData[]> = async () => []): {
	startRequest: DownloadRequestExecutor;
	observed: { workspaceParents: string[]; markerSeen: boolean[] };
} {
	const observed = { workspaceParents: [] as string[], markerSeen: [] as boolean[] };
	const startRequest = vi.fn<DownloadRequestExecutor>(
		async (_plan, itemIndex, _resourceEnvelope, _signal, _authentication, workspaceParent) => {
			observed.workspaceParents.push(workspaceParent ?? '<missing>');
			observed.markerSeen.push(
				await lstat(join(workspaceParent ?? '<missing>', EXECUTION_WORKSPACE_MARKER))
					.then((stat) => stat.isFile())
					.catch(() => false),
			);
			await writeFile(
				join(workspaceParent ?? '<missing>', `${itemIndex}-${LEFTOVER_ARTIFACT}`),
				'partial download',
			);
			return await settle();
		},
	);

	return { startRequest, observed };
}

const succeed = async (): Promise<INodeExecutionData[]> => [];

async function expectRemoved(workspacePath: string, temporaryDirectory: string): Promise<void> {
	await expect(lstat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
	expect(await readdir(join(temporaryDirectory, WORKSPACE_BASE_DIRECTORY))).toEqual([]);
}

describe('owned Execution Workspace cleanup', () => {
	it('removes the owned Execution Workspace after a successful execution', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest, observed } = observeRequests(succeed);

		await executeYtDlpNode(createExecutionContext(), startRequest, startWorkspace);

		expect(observed.markerSeen).toEqual([true]);
		expect(observed.workspaceParents).toEqual(ownedPaths);
		await expectRemoved(ownedPaths[0], temporaryDirectory);
	});

	it('leaves Execution Workspaces it does not own untouched', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const baseDirectory = join(temporaryDirectory, WORKSPACE_BASE_DIRECTORY);
		await mkdir(baseDirectory, { mode: 0o700, recursive: true });
		await mkdir(join(baseDirectory, 'unrelated-root'), { mode: 0o700 });
		const freshForeignRoot = `${EXECUTION_WORKSPACE_PREFIX}fresh-foreign`;
		await mkdir(join(baseDirectory, freshForeignRoot), { mode: 0o700 });
		await writeFile(
			join(baseDirectory, freshForeignRoot, EXECUTION_WORKSPACE_MARKER),
			JSON.stringify({ schemaVersion: 1, packageName: 'n8n-nodes-yt-dlp' }),
			{ mode: 0o600 },
		);
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest } = observeRequests(succeed);

		await executeYtDlpNode(createExecutionContext(), startRequest, startWorkspace);

		await expect(lstat(ownedPaths[0])).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await readdir(baseDirectory)).sort()).toEqual([freshForeignRoot, 'unrelated-root']);
	});

	it('removes one owned Execution Workspace shared by every input item', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest, observed } = observeRequests(succeed);

		await executeYtDlpNode(createExecutionContext(3), startRequest, startWorkspace);

		expect(ownedPaths).toHaveLength(1);
		expect(observed.markerSeen).toEqual([true, true, true]);
		expect(new Set(observed.workspaceParents)).toEqual(new Set(ownedPaths));
		await expectRemoved(ownedPaths[0], temporaryDirectory);
	});

	it('removes the owned Execution Workspace when a Download Request fails under Continue On Fail', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest, observed } = observeRequests(
			async () =>
				await Promise.reject(new YtDlpProcessError('YTDLP_FAILED', 'request failed', '', '')),
		);

		const [outputItems] = await executeYtDlpNode(
			createExecutionContext(2, true),
			startRequest,
			startWorkspace,
		);

		expect(outputItems).toMatchObject([
			{ json: { status: 'error', errorCode: 'YTDLP_FAILED' } },
			{ json: { status: 'error', errorCode: 'YTDLP_FAILED' } },
		]);
		expect(observed.markerSeen).toEqual([true, true]);
		await expectRemoved(ownedPaths[0], temporaryDirectory);
	});

	it.each([
		['the execution fails globally', new Error('unexpected global failure')],
		[
			'a terminated Process Group is confirmed closed',
			new YtDlpProcessTerminationError(true, new Error('termination cause')),
		],
	])('removes the owned Execution Workspace when %s', async (_case, failure) => {
		const temporaryDirectory = await createTemporaryDirectory();
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest, observed } = observeRequests(async () => await Promise.reject(failure));

		await expect(
			executeYtDlpNode(createExecutionContext(), startRequest, startWorkspace),
		).rejects.toBe(failure);

		expect(observed.markerSeen).toEqual([true]);
		await expectRemoved(ownedPaths[0], temporaryDirectory);
	});

	it('removes the owned Execution Workspace when the input count exceeds the Resource Envelope', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest, observed } = observeRequests(succeed);

		await expect(
			executeYtDlpNode(
				createExecutionContext(MAXIMUM_EXECUTION_INPUTS + 1),
				startRequest,
				startWorkspace,
			),
		).rejects.toMatchObject({ context: { errorCode: 'RESOURCE_LIMIT' } });

		expect(observed.workspaceParents).toEqual([]);
		expect(ownedPaths).toHaveLength(1);
		await expectRemoved(ownedPaths[0], temporaryDirectory);
	});

	it('surfaces a real cleanup failure of the owned Execution Workspace as a global invariant', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const startRequest = vi.fn<DownloadRequestExecutor>(
			async (_plan, _itemIndex, _resourceEnvelope, _signal, _authentication, workspaceParent) => {
				await writeFile(join(workspaceParent!, LEFTOVER_ARTIFACT), 'partial download');
				await chmod(workspaceParent!, 0o500);
				return [];
			},
		);

		const error = await executeYtDlpNode(
			createExecutionContext(),
			startRequest,
			startWorkspace,
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(WorkspaceCleanupError);
		expect(error).toMatchObject({ code: 'WORKSPACE_CLEANUP_FAILED' });
		expect((await lstat(ownedPaths[0])).isDirectory()).toBe(true);
		await chmod(ownedPaths[0], 0o700);
	});

	it('preserves the owned Execution Workspace only while a Process Group may still be writing', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const terminationError = new YtDlpProcessTerminationError(false, new Error('termination cause'));
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest } = observeRequests(async () => await Promise.reject(terminationError));

		await expect(
			executeYtDlpNode(createExecutionContext(), startRequest, startWorkspace),
		).rejects.toBe(terminationError);

		expect((await lstat(ownedPaths[0])).isDirectory()).toBe(true);
		expect((await lstat(join(ownedPaths[0], `0-${LEFTOVER_ARTIFACT}`))).isFile()).toBe(true);
	});

	it('reclaims a preserved Execution Workspace on a later execution once it is stale', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const terminationError = new YtDlpProcessTerminationError(false, new Error('termination cause'));
		const { startWorkspace, ownedPaths } = trackExecutionWorkspaces(temporaryDirectory);
		const { startRequest: leakingRequest } = observeRequests(
			async () => await Promise.reject(terminationError),
		);
		await expect(
			executeYtDlpNode(createExecutionContext(), leakingRequest, startWorkspace),
		).rejects.toBe(terminationError);
		const preservedPath = ownedPaths[0];
		const staleDate = new Date(Date.now() - STALE_WORKSPACE_AGE_MS - 1);
		await utimes(join(preservedPath, EXECUTION_WORKSPACE_MARKER), staleDate, staleDate);

		const { startRequest } = observeRequests(succeed);
		await executeYtDlpNode(createExecutionContext(), startRequest, startWorkspace);

		await expect(lstat(preservedPath)).rejects.toMatchObject({ code: 'ENOENT' });
		await expectRemoved(ownedPaths[1], temporaryDirectory);
	});
});
