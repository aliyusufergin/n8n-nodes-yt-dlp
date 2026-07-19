import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { ToolchainAttestationError } from 'n8n-nodes-yt-dlp-platform';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	YtDlp,
	executeYtDlpNode,
	type DownloadRequestExecutor,
} from '../nodes/YtDlp/YtDlp.node';
import type { YtDlpAuthenticationData } from '../nodes/YtDlp/authentication';
import { InvalidArgumentsError } from '../nodes/YtDlp/arguments';
import {
	BinaryTransferError,
	InvalidArtifactSetError,
} from '../nodes/YtDlp/download';
import {
	YtDlpProcessCancellationError,
	YtDlpProcessError,
	YtDlpProcessTerminationError,
} from '../nodes/YtDlp/process';
import { YtDlpRequestResourceLimitError } from '../nodes/YtDlp/resource-envelope';
import { InvalidSourceUrlError } from '../nodes/YtDlp/source-url';
import { WorkspaceCleanupError } from '../nodes/YtDlp/workspace';

interface NodeParameters {
	sourceUrl: string;
	arguments: string;
	requestTimeoutMinutes?: number;
	maximumArtifactCount?: number;
	maximumArtifactSizeMiB?: number;
	maximumTotalArtifactSizeMiB?: number;
}

const createTestWorkspace = async () => ({
	path: '/tmp/n8n-nodes-yt-dlp-test-execution',
	close: vi.fn(async () => {}),
});

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			async (server) =>
				await new Promise<void>((resolveClose) => server.close(() => resolveClose())),
		),
	);
});

async function startSyntheticOrigin(body: Buffer): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'video/mp4' });
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/fixture`;
}

function createExecutionContext(
	parameters: NodeParameters[],
	continueOnFail = false,
	executionSignal?: AbortSignal,
	authentication?: YtDlpAuthenticationData,
): IExecuteFunctions {
	const node: INode = {
		id: 'node-id',
		name: 'yt-dlp',
		type: 'n8n-nodes-yt-dlp.ytDlp',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
		credentials:
			authentication === undefined
				? undefined
				: { ytDlpAuthentication: { id: 'credential-id', name: 'credential-name' } },
	};

	return {
		continueOnFail: vi.fn(() => continueOnFail),
		getExecutionId: vi.fn(() => 'execution-id'),
		getExecutionCancelSignal: vi.fn(() => executionSignal),
		getInputData: vi.fn(() => parameters.map(() => ({ json: {} }))),
		getNode: vi.fn(() => node),
		getCredentials: vi.fn(async () => authentication ?? {}),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => parameters[itemIndex][name as keyof NodeParameters]),
		helpers: {
			prepareBinaryData: vi.fn(async (_data, fileName?: string, mimeType?: string) => ({
				data: 'stored',
				fileName,
				mimeType,
			})),
		},
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IExecuteFunctions;
}

describe('yt-dlp node metadata', () => {
	it('declares one main output and is not usable as an AI tool', () => {
		const description = new YtDlp().description;

		expect(description.outputs).toEqual([NodeConnectionTypes.Main]);
		expect(description).not.toHaveProperty('usableAsTool');
	});

	it('declares Source URL separately from Arguments', () => {
		const description = new YtDlp().description;
		const propertyNames = description.properties.map(({ name }) => name);

		expect(propertyNames).toEqual([
			'sourceUrl',
			'arguments',
			'requestTimeoutMinutes',
			'maximumArtifactCount',
			'maximumArtifactSizeMiB',
			'maximumTotalArtifactSizeMiB',
		]);
		expect(description.credentials).toEqual([
			{ name: 'ytDlpAuthentication', required: false },
		]);
	});
});

describe('yt-dlp node adapter', () => {
	it('fails toolchain attestation before creating an Execution Workspace', async () => {
		const attestationError = new ToolchainAttestationError();
		const resolveToolchain = vi.fn().mockRejectedValue(attestationError);
		const startWorkspace = vi.fn(createTestWorkspace);
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/video', arguments: '' },
		]);

		await expect(
			executeYtDlpNode(context, undefined, startWorkspace, resolveToolchain),
		).rejects.toBe(attestationError);
		expect(startWorkspace).not.toHaveBeenCalled();
		expect(context.logger.info).toHaveBeenCalledWith(
			'yt-dlp execution summary',
			expect.objectContaining({
				errorCode: 'TOOLCHAIN_ATTESTATION_FAILED',
				outcome: 'failure',
			}),
		);
	});

	it('uses the attested packaged yt-dlp for the default request executor', async () => {
		const fixture = Buffer.from('default packaged yt-dlp');
		const sourceUrl = await startSyntheticOrigin(fixture);
		const context = createExecutionContext([
			{ sourceUrl, arguments: '' },
		]);

		await expect(executeYtDlpNode(context)).resolves.toMatchObject([[
			{
				json: {
					status: 'success',
					fileName: '000001-fixture.mp4',
					sizeBytes: fixture.byteLength,
				},
			},
		]]);
	}, 30_000);

	it('logs one bounded success terminal event and one execution summary', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([
			{
				json: {
					status: 'success',
					fileName: 'secret-title.mp4',
					sizeBytes: 123,
				},
				pairedItem: { item: 0 },
			},
		]);
		const context = createExecutionContext([
			{
				sourceUrl: 'https://example.com/secret-video?token=secret',
				arguments: '--format secret-format',
			},
		]);

		await executeYtDlpNode(context, startRequest);

		expect(context.logger.debug).toHaveBeenCalledOnce();
		expect(context.logger.debug).toHaveBeenCalledWith('yt-dlp request terminal', {
			artifactCount: 1,
			durationMs: expect.any(Number),
			executionId: 'execution-id',
			finalBytes: 123,
			inputIndex: 0,
			outcome: 'success',
			packageVersion: '0.2.0',
			schemaVersion: 1,
			toolchainVersion: '0.2.0',
		});
		expect(context.logger.info).toHaveBeenCalledOnce();
		expect(context.logger.info).toHaveBeenCalledWith('yt-dlp execution summary', {
			artifactCount: 1,
			durationMs: expect.any(Number),
			executionId: 'execution-id',
			finalBytes: 123,
			outcome: 'success',
			packageVersion: '0.2.0',
			schemaVersion: 1,
			toolchainVersion: '0.2.0',
		});
		expect(context.logger.warn).not.toHaveBeenCalled();
		expect(context.logger.error).not.toHaveBeenCalled();
		const logs = JSON.stringify([
			...(context.logger.debug as ReturnType<typeof vi.fn>).mock.calls,
			...(context.logger.info as ReturnType<typeof vi.fn>).mock.calls,
		]);
		expect(logs).not.toContain('secret');
		expect(logs).not.toContain('example.com');
		expect(logs).not.toContain('secret-title.mp4');
	});

	it('resolves an optional credential by reference and passes only accepted authentication fields', async () => {
		const authentication: YtDlpAuthenticationData = {
			cookies: 'cookie-secret',
			username: 'site-user',
			password: 'site-password',
			videoPassword: 'video-password',
			proxyUrl: 'http://proxy-user:proxy-password@proxy.test:8080',
		};
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/video', arguments: '' }],
			false,
			undefined,
			authentication,
		);

		await executeYtDlpNode(context, startRequest);

		expect(context.getCredentials).toHaveBeenCalledWith('ytDlpAuthentication', 0);
		expect(startRequest).toHaveBeenCalledWith(
			expect.any(Object),
			0,
			expect.any(Object),
			expect.any(AbortSignal),
			authentication,
			expect.stringMatching(/\/n8n-nodes-yt-dlp\/n8n-nodes-yt-dlp-execution-/),
		);
		expect(JSON.stringify(context.getNode())).not.toContain('cookie-secret');
		expect(JSON.stringify(context.getNode())).not.toContain('site-password');
		expect(JSON.stringify(context.getNode())).not.toContain('proxy-password');
	});

	it('does not resolve credentials when the workflow has no credential reference', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/video', arguments: '' },
		]);

		await executeYtDlpNode(context, startRequest);

		expect(context.getCredentials).not.toHaveBeenCalled();
		expect(startRequest).toHaveBeenCalledWith(
			expect.any(Object),
			0,
			expect.any(Object),
			expect.any(AbortSignal),
			undefined,
			expect.stringMatching(/\/n8n-nodes-yt-dlp\/n8n-nodes-yt-dlp-execution-/),
		);
	});

	it('logs a typed request failure once without process output or input data', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>().mockRejectedValue(
			new YtDlpProcessError(
				'YTDLP_FAILED',
				'secret process failure',
				'secret stdout',
				'secret stderr',
			),
		);
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/secret', arguments: '--format secret' }],
			true,
		);

		await executeYtDlpNode(context, startRequest);

		expect(context.logger.warn).toHaveBeenCalledOnce();
		expect(context.logger.warn).toHaveBeenCalledWith('yt-dlp request terminal', {
			artifactCount: 0,
			durationMs: expect.any(Number),
			errorCode: 'YTDLP_FAILED',
			executionId: 'execution-id',
			finalBytes: 0,
			inputIndex: 0,
			outcome: 'failure',
			packageVersion: '0.2.0',
			schemaVersion: 1,
			toolchainVersion: '0.2.0',
		});
		expect(context.logger.info).toHaveBeenCalledWith(
			'yt-dlp execution summary',
			expect.objectContaining({ outcome: 'partial_failure' }),
		);
		expect(context.logger.debug).not.toHaveBeenCalled();
		expect(context.logger.error).not.toHaveBeenCalled();
		expect(JSON.stringify((context.logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
			'secret',
		);
	});

	it('logs a cleanup failure as one secret-safe global terminal event', async () => {
		const startRequest = vi
			.fn<DownloadRequestExecutor>()
			.mockRejectedValue(
				new WorkspaceCleanupError('WORKSPACE_CLEANUP_FAILED', new Error('secret path')),
			);
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/secret', arguments: '--format secret' }],
			true,
		);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			code: 'WORKSPACE_CLEANUP_FAILED',
		});

		expect(context.logger.error).toHaveBeenCalledOnce();
		expect(context.logger.error).toHaveBeenCalledWith('yt-dlp request terminal', {
			artifactCount: 0,
			durationMs: expect.any(Number),
			errorCode: 'WORKSPACE_CLEANUP_FAILED',
			executionId: 'execution-id',
			finalBytes: 0,
			inputIndex: 0,
			outcome: 'global_failure',
			packageVersion: '0.2.0',
			schemaVersion: 1,
			toolchainVersion: '0.2.0',
		});
		expect(context.logger.info).toHaveBeenCalledOnce();
		expect(context.logger.warn).not.toHaveBeenCalled();
		expect(context.logger.debug).not.toHaveBeenCalled();
		expect(JSON.stringify((context.logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
			'secret',
		);
	});

	it('allowlists global error codes before logging them', async () => {
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/video', arguments: '' },
		]);
		const injectedError = new NodeOperationError(context.getNode(), 'failure');
		injectedError.context.errorCode = 'secret\nmultiline-code';
		const startRequest = vi.fn<DownloadRequestExecutor>().mockRejectedValue(injectedError);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toBe(injectedError);

		expect(context.logger.error).toHaveBeenCalledWith(
			'yt-dlp request terminal',
			expect.objectContaining({ errorCode: 'UNEXPECTED_ERROR' }),
		);
		expect(JSON.stringify((context.logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
			'secret',
		);
		expect(JSON.stringify((context.logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
			'multiline',
		);
	});

	it('reports cleanup failure instead of cancellation in the execution summary', async () => {
		const controller = new AbortController();
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		const startRequest = ((...args: unknown[]) => {
			const signal = args[3] as AbortSignal;
			requestStarted();
			return new Promise<[]>(resolve => {
				signal.addEventListener('abort', () => resolve([]), { once: true });
			});
		}) as DownloadRequestExecutor;
		const cleanupError = new WorkspaceCleanupError(
			'WORKSPACE_CLEANUP_FAILED',
			new Error('secret path'),
		);
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/video', arguments: '' }],
			true,
			controller.signal,
		);
		const startWorkspace = async () => ({
			path: '/tmp/n8n-nodes-yt-dlp-test-execution',
			close: vi.fn(async () => await Promise.reject(cleanupError)),
		});

		const execution = executeYtDlpNode(context, startRequest, startWorkspace);
		await started;
		controller.abort();
		await expect(execution).rejects.toBe(cleanupError);

		expect(context.logger.info).toHaveBeenCalledWith(
			'yt-dlp execution summary',
			expect.objectContaining({
				errorCode: 'WORKSPACE_CLEANUP_FAILED',
				outcome: 'failure',
			}),
		);
	});

	it('logs a concurrent cleanup invariant as a global request failure', async () => {
		const controller = new AbortController();
		const cleanupError = new WorkspaceCleanupError(
			'WORKSPACE_CLEANUP_FAILED',
			new Error('secret path'),
		);
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		const startRequest = ((...args: unknown[]) => {
			const signal = args[3] as AbortSignal;
			requestStarted();
			return new Promise<[]>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(cleanupError), { once: true });
			});
		}) as DownloadRequestExecutor;
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/video', arguments: '' }],
			true,
			controller.signal,
		);

		const execution = executeYtDlpNode(context, startRequest, createTestWorkspace);
		await started;
		controller.abort();
		await expect(execution).rejects.toBe(cleanupError);

		expect(context.logger.error).toHaveBeenCalledWith(
			'yt-dlp request terminal',
			expect.objectContaining({
				errorCode: 'WORKSPACE_CLEANUP_FAILED',
				outcome: 'global_failure',
			}),
		);
		expect(context.logger.warn).not.toHaveBeenCalled();
	});

	it('stops globally when cancellation races with request settlement', async () => {
		const controller = new AbortController();
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		const startRequest = ((...args: unknown[]) => {
			const signal = args[3] as AbortSignal;
			requestStarted();
			return new Promise<[]>(resolve => {
				signal.addEventListener('abort', () => resolve([]), { once: true });
			});
		}) as DownloadRequestExecutor;
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/video', arguments: '' }],
			true,
			controller.signal,
		);

		const execution = executeYtDlpNode(context, startRequest, createTestWorkspace);
		await started;
		controller.abort();

		const error = await execution.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as { context?: { itemIndex?: number } }).context?.itemIndex).toBeUndefined();
		expect(context.logger.warn).toHaveBeenCalledOnce();
		expect(context.logger.warn).toHaveBeenCalledWith(
			'yt-dlp request terminal',
			expect.objectContaining({ errorCode: 'CANCELLED', outcome: 'cancelled' }),
		);
		expect(context.logger.info).toHaveBeenCalledWith(
			'yt-dlp execution summary',
			expect.objectContaining({ errorCode: 'CANCELLED', outcome: 'cancelled' }),
		);
		expect(context.logger.error).not.toHaveBeenCalled();
	});

	it('runs one request at a time and preserves input output order', async () => {
		let activeRequests = 0;
		let maximumActiveRequests = 0;
		const startRequest = vi.fn<DownloadRequestExecutor>(async (_plan, itemIndex) => {
			activeRequests++;
			maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
			await Promise.resolve();
			activeRequests--;
			return [
				{
					json: { status: 'success', itemIndex },
					pairedItem: { item: itemIndex },
				},
			];
		});
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/first', arguments: '' },
			{ sourceUrl: 'https://example.com/second', arguments: '' },
			{ sourceUrl: 'https://example.com/third', arguments: '' },
		]);

		const [outputItems] = await executeYtDlpNode(context, startRequest);

		expect(maximumActiveRequests).toBe(1);
		expect(outputItems.map(({ pairedItem }) => pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
	});

	it.each([
		['cancellation', new YtDlpProcessCancellationError()],
		[
			'process termination invariant',
			new YtDlpProcessTerminationError(true, new Error('termination invariant')),
		],
		['toolchain invariant', new Error('toolchain invariant')],
		['cleanup invariant', new Error('cleanup invariant')],
		['unknown exception', new Error('unknown exception')],
	] as const)('stops the execution for a %s even with Continue On Fail', async (_name, globalError) => {
		const startRequest = vi
			.fn<DownloadRequestExecutor>()
			.mockRejectedValueOnce(globalError)
			.mockResolvedValueOnce([]);
		const context = createExecutionContext(
			[
				{ sourceUrl: 'https://example.com/first', arguments: '' },
				{ sourceUrl: 'https://example.com/second', arguments: '' },
			],
			true,
		);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toBe(globalError);
		expect(startRequest).toHaveBeenCalledOnce();
	});

	it.each([
		['INVALID_SOURCE_URL', new InvalidSourceUrlError()],
		['INVALID_ARGUMENTS', new InvalidArgumentsError()],
		['YTDLP_FAILED', new YtDlpProcessError('YTDLP_FAILED', 'secret', 'stdout', 'stderr')],
		[
			'REQUEST_TIMEOUT',
			new YtDlpProcessError('REQUEST_TIMEOUT', 'secret', 'stdout', 'stderr'),
		],
		[
			'PROCESS_OUTPUT_LIMIT',
			new YtDlpProcessError('PROCESS_OUTPUT_LIMIT', 'secret', 'stdout', 'stderr'),
		],
		['RESOURCE_LIMIT', new YtDlpRequestResourceLimitError('secret')],
		['INVALID_ARTIFACT_SET', new InvalidArtifactSetError()],
		['BINARY_TRANSFER_FAILED', new BinaryTransferError(new Error('secret'))],
	] as const)(
		'returns a bounded, binary-free %s Failure Item',
		async (errorCode, requestError) => {
			const startRequest = vi
				.fn<DownloadRequestExecutor>()
				.mockRejectedValue(requestError);
			const context = createExecutionContext(
				[{ sourceUrl: 'https://example.com/video', arguments: '' }],
				true,
			);

			const [[failureItem]] = await executeYtDlpNode(context, startRequest);
			const errorMessage = failureItem.json.errorMessage as string;

			expect(failureItem).toEqual({
				json: {
					status: 'error',
					errorCode,
					errorMessage: expect.any(String),
				},
				pairedItem: { item: 0 },
			});
			expect(Buffer.byteLength(errorMessage)).toBeLessThanOrEqual(4 * 1024);
			expect(errorMessage.split('\n')).toHaveLength(1);
			expect(JSON.stringify(failureItem)).not.toContain('secret');
			expect(JSON.stringify(failureItem)).not.toContain('stdout');
			expect(JSON.stringify(failureItem)).not.toContain('stderr');
		},
	);

	it('returns one Failure Item and continues with the next input for a typed request failure', async () => {
		const successItem = {
			json: { status: 'success' },
			pairedItem: { item: 1 },
		};
		const startRequest = vi
			.fn<DownloadRequestExecutor>()
			.mockRejectedValueOnce(
				new YtDlpProcessError(
					'YTDLP_FAILED',
					'sensitive process failure',
					'sensitive stdout',
					'sensitive stderr',
				),
			)
			.mockResolvedValueOnce([successItem]);
		const context = createExecutionContext(
			[
				{ sourceUrl: 'https://example.com/failed', arguments: '' },
				{ sourceUrl: 'https://example.com/succeeded', arguments: '' },
			],
			true,
		);

		const result = await executeYtDlpNode(context, startRequest);

		expect(result).toEqual([
			[
				{
					json: {
						status: 'error',
						errorCode: 'YTDLP_FAILED',
						errorMessage: 'yt-dlp could not complete the Download Request.',
					},
					pairedItem: { item: 0 },
				},
				successItem,
			],
		]);
		expect(startRequest).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(result)).not.toContain('sensitive');
	});

	it('accepts exactly 20 input items', async () => {
		const parameters = Array.from({ length: 20 }, (_, index) => ({
			sourceUrl: `https://example.com/video-${index}`,
			arguments: '',
		}));
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext(parameters, true);

		await expect(executeYtDlpNode(context, startRequest)).resolves.toEqual([[]]);
		expect(startRequest).toHaveBeenCalledTimes(20);
	});

	it('rejects 21 input items as a global Resource Envelope failure', async () => {
		const parameters = Array.from({ length: 21 }, (_, index) => ({
			sourceUrl: `https://example.com/video-${index}`,
			arguments: '',
		}));
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext(parameters, true);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'RESOURCE_LIMIT' },
		});
		expect(startRequest).not.toHaveBeenCalled();
	});

	it('aborts an execution at the two-hour hard cap as a global failure', async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		const startRequest = ((...args: unknown[]) => {
			observedSignal = args[3] as AbortSignal | undefined;
			requestStarted();
			return new Promise<[]>(resolve => {
				observedSignal?.addEventListener('abort', () => resolve([]), {
					once: true,
				});
			});
		}) as DownloadRequestExecutor;
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/video', arguments: '' }],
			true,
		);

		try {
			const execution = executeYtDlpNode(context, startRequest, createTestWorkspace).catch(
				(cause: unknown) => cause,
			);
			await started;
			await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

			expect(observedSignal?.aborted).toBe(true);
			const error = await execution;
			expect(error).toMatchObject({ context: { errorCode: 'RESOURCE_LIMIT' } });
			expect((error as { context: { itemIndex?: number } }).context.itemIndex).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('starts the execution hard cap before workspace recovery', async () => {
		vi.useFakeTimers();
		let resolveWorkspace!: (workspace: Awaited<ReturnType<typeof createTestWorkspace>>) => void;
		const workspace = new Promise<Awaited<ReturnType<typeof createTestWorkspace>>>((resolve) => {
			resolveWorkspace = resolve;
		});
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/video', arguments: '' },
		]);

		try {
			const execution = executeYtDlpNode(context, startRequest, async () => await workspace).catch(
				(cause: unknown) => cause,
			);
			await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
			resolveWorkspace(await createTestWorkspace());

			await expect(execution).resolves.toMatchObject({
				context: { errorCode: 'RESOURCE_LIMIT' },
			});
			expect(startRequest).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects an invalid Source URL before starting a child process', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>();
		const context = createExecutionContext([{ sourceUrl: 'file:///tmp/video.mp4', arguments: '' }]);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'INVALID_SOURCE_URL', itemIndex: 0 },
		});
		expect(startRequest).not.toHaveBeenCalled();
	});

	it('passes accepted hard-cap request limits to the request executor', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext([
			{
				sourceUrl: 'https://example.com/video',
				arguments: '',
				requestTimeoutMinutes: 60,
				maximumArtifactCount: 50,
				maximumArtifactSizeMiB: 256,
				maximumTotalArtifactSizeMiB: 512,
			},
		]);

		await executeYtDlpNode(context, startRequest);

		expect(startRequest).toHaveBeenCalledWith(
			expect.any(Object),
			0,
			{
				requestTimeoutMs: 60 * 60 * 1000,
				maximumArtifactCount: 50,
				maximumArtifactSizeBytes: 256 * 1024 * 1024,
				maximumTotalArtifactSizeBytes: 512 * 1024 * 1024,
				maximumWorkspaceSizeBytes: 1088 * 1024 * 1024,
			},
			expect.any(AbortSignal),
			undefined,
			expect.stringMatching(/\/n8n-nodes-yt-dlp\/n8n-nodes-yt-dlp-execution-/),
		);
	});

	it('classifies above-hard-cap request limits as an indexed request failure', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext([
			{
				sourceUrl: 'https://example.com/video',
				arguments: '',
				maximumArtifactCount: 51,
			},
		]);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'RESOURCE_LIMIT', itemIndex: 0 },
		});
		expect(startRequest).not.toHaveBeenCalled();
	});

	it.each([
		'YTDLP_FAILED',
		'REQUEST_TIMEOUT',
		'PROCESS_OUTPUT_LIMIT',
		'RESOURCE_LIMIT',
	] as const)(
		'classifies %s process termination as an indexed request failure',
		async (errorCode) => {
			const startRequest = vi
				.fn<DownloadRequestExecutor>()
				.mockRejectedValue(new YtDlpProcessError(errorCode, 'request failed', '', ''));
			const context = createExecutionContext([
				{ sourceUrl: 'https://example.com/video', arguments: '' },
			]);

			await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
				context: { errorCode, itemIndex: 0 },
			});
		},
	);

	it('associates an invalid Source URL with the correct input index', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/valid', arguments: '--format best' },
			{ sourceUrl: 'ytsearch:invalid', arguments: '' },
		]);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'INVALID_SOURCE_URL', itemIndex: 1 },
		});
		expect(startRequest).toHaveBeenCalledTimes(1);
		expect(startRequest).toHaveBeenCalledWith(
			{
				argv: [
					'--playlist-items',
					'1:5',
					'--format',
					'best',
					'--',
					'https://example.com/valid',
				],
			},
			0,
			{
				requestTimeoutMs: 30 * 60 * 1000,
				maximumArtifactCount: 20,
				maximumArtifactSizeBytes: 128 * 1024 * 1024,
				maximumTotalArtifactSizeBytes: 256 * 1024 * 1024,
				maximumWorkspaceSizeBytes: 576 * 1024 * 1024,
			},
			expect.any(AbortSignal),
			undefined,
			expect.stringMatching(/\/n8n-nodes-yt-dlp\/n8n-nodes-yt-dlp-execution-/),
		);
	});

	it.each([
		'--output /tmp/file',
		'--paths /tmp',
		'--config-locations /tmp/config',
		'--plugin-dirs /tmp/plugins',
		'--js-runtimes node',
		'--update',
		'--exec id',
		'--username user',
		'--proxy http://proxy',
		'--concurrent-fragments 99',
		'--verbose',
		'--simulate',
		'--load-info-json /tmp/info.json',
		'--unknown-option value',
	])('rejects %j before starting a child process', async (argumentsValue) => {
		const startRequest = vi.fn<DownloadRequestExecutor>();
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/video', arguments: argumentsValue },
		]);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'INVALID_ARGUMENTS', itemIndex: 0 },
		});
		expect(startRequest).not.toHaveBeenCalled();
	});
});
