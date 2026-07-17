import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	YtDlp,
	executeYtDlpNode,
	type DownloadRequestExecutor,
} from '../nodes/YtDlp/YtDlp.node';

interface NodeParameters {
	sourceUrl: string;
	arguments: string;
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

		expect(propertyNames).toEqual(['sourceUrl', 'arguments']);
	});
});

describe('yt-dlp node adapter', () => {
	it('rejects an invalid Source URL before starting a child process', async () => {
		const startRequest = vi.fn<DownloadRequestExecutor>();
		const context = createExecutionContext([{ sourceUrl: 'file:///tmp/video.mp4', arguments: '' }]);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'INVALID_SOURCE_URL', itemIndex: 0 },
		});
		expect(startRequest).not.toHaveBeenCalled();
	});

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
