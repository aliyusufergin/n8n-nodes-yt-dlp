import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	YtDlp,
	executeYtDlpNode,
	type DownloadRequestExecutor,
} from '../nodes/YtDlp/YtDlp.node';
import { YtDlpProcessError } from '../nodes/YtDlp/process';

interface NodeParameters {
	sourceUrl: string;
	arguments: string;
	requestTimeoutMinutes?: number;
	maximumArtifactCount?: number;
	maximumArtifactSizeMiB?: number;
	maximumTotalArtifactSizeMiB?: number;
}

function createExecutionContext(parameters: NodeParameters[]): IExecuteFunctions {
	const node: INode = {
		id: 'node-id',
		name: 'yt-dlp',
		type: 'n8n-nodes-yt-dlp.ytDlp',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};

	return {
		getInputData: vi.fn(() => parameters.map(() => ({ json: {} }))),
		getNode: vi.fn(() => node),
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
		const propertyNames = new YtDlp().description.properties.map(({ name }) => name);

		expect(propertyNames).toEqual([
			'sourceUrl',
			'arguments',
			'requestTimeoutMinutes',
			'maximumArtifactCount',
			'maximumArtifactSizeMiB',
			'maximumTotalArtifactSizeMiB',
		]);
	});
});

describe('yt-dlp node adapter', () => {
	it('accepts exactly 20 input items', async () => {
		const parameters = Array.from({ length: 20 }, (_, index) => ({
			sourceUrl: `https://example.com/video-${index}`,
			arguments: '',
		}));
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext(parameters);

		await expect(executeYtDlpNode(context, startRequest)).resolves.toEqual([[]]);
		expect(startRequest).toHaveBeenCalledTimes(20);
	});

	it('rejects 21 input items as a global Resource Envelope failure', async () => {
		const parameters = Array.from({ length: 21 }, (_, index) => ({
			sourceUrl: `https://example.com/video-${index}`,
			arguments: '',
		}));
		const startRequest = vi.fn<DownloadRequestExecutor>().mockResolvedValue([]);
		const context = createExecutionContext(parameters);

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
		const context = createExecutionContext([
			{ sourceUrl: 'https://example.com/video', arguments: '' },
		]);

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

	it.each(['REQUEST_TIMEOUT', 'RESOURCE_LIMIT'] as const)(
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
