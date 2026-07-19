import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

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

interface NodeParameters {
	sourceUrl: string;
	arguments: string;
	requestTimeoutMinutes?: number;
	maximumArtifactCount?: number;
	maximumArtifactSizeMiB?: number;
	maximumTotalArtifactSizeMiB?: number;
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
		getExecutionCancelSignal: vi.fn(() => executionSignal),
		getInputData: vi.fn(() => parameters.map(() => ({ json: {} }))),
		getNode: vi.fn(() => node),
		getCredentials: vi.fn(async () => authentication ?? {}),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => parameters[itemIndex][name as keyof NodeParameters]),
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
		);
	});

	it('stops globally when cancellation races with request settlement', async () => {
		const controller = new AbortController();
		const startRequest = ((...args: unknown[]) => {
			const signal = args[3] as AbortSignal;
			return new Promise<[]>(resolve => {
				signal.addEventListener('abort', () => resolve([]), { once: true });
			});
		}) as DownloadRequestExecutor;
		const context = createExecutionContext(
			[{ sourceUrl: 'https://example.com/video', arguments: '' }],
			true,
			controller.signal,
		);

		const execution = executeYtDlpNode(context, startRequest);
		controller.abort();

		const error = await execution.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as { context?: { itemIndex?: number } }).context?.itemIndex).toBeUndefined();
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
		const startRequest = ((...args: unknown[]) => {
			observedSignal = args[3] as AbortSignal | undefined;
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
			const execution = executeYtDlpNode(context, startRequest).catch(
				(cause: unknown) => cause,
			);
			await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

			expect(observedSignal?.aborted).toBe(true);
			const error = await execution;
			expect(error).toMatchObject({ context: { errorCode: 'RESOURCE_LIMIT' } });
			expect((error as { context: { itemIndex?: number } }).context.itemIndex).toBeUndefined();
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
