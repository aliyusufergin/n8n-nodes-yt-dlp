import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	INVALID_SOURCE_URL,
	InvalidSourceUrlError,
	createDownloadRequest,
	type DownloadRequest,
} from './source-url';

export type DownloadRequestExecutor = (
	request: DownloadRequest,
	itemIndex: number,
) => Promise<INodeExecutionData[]>;

const pendingDownloadRequestExecutor: DownloadRequestExecutor = () => Promise.resolve([]);

export async function executeYtDlpNode(
	execution: IExecuteFunctions,
	startRequest: DownloadRequestExecutor = pendingDownloadRequestExecutor,
): Promise<INodeExecutionData[][]> {
	const items = execution.getInputData();
	const outputItems: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const sourceUrl = execution.getNodeParameter('sourceUrl', itemIndex);
			const argumentsValue = execution.getNodeParameter('arguments', itemIndex, '') as string;
			const request = createDownloadRequest(sourceUrl, argumentsValue);

			outputItems.push(...(await startRequest(request, itemIndex)));
		} catch (error) {
			if (error instanceof InvalidSourceUrlError) {
				const nodeError = new NodeOperationError(execution.getNode(), error, {
					description: INVALID_SOURCE_URL,
					itemIndex,
				});
				nodeError.context.errorCode = INVALID_SOURCE_URL;
				throw nodeError;
			}

			const cause = error instanceof Error ? error : new Error('Unexpected request failure.');
			throw new NodeOperationError(execution.getNode(), cause, { itemIndex });
		}
	}

	return [outputItems];
}

export class YtDlp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'yt-dlp',
		name: 'ytDlp',
		icon: { light: 'file:yt-dlp.svg', dark: 'file:yt-dlp.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Download media with yt-dlp',
		subtitle: '={{$parameter["sourceUrl"]}}',
		defaults: {
			name: 'yt-dlp',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Source URL',
				name: 'sourceUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/video',
				description: 'Absolute HTTP(S) URL to download',
			},
			{
				displayName: 'Arguments',
				name: 'arguments',
				type: 'string',
				default: '',
				typeOptions: {
					rows: 3,
				},
				description: 'Supported yt-dlp options, without the Source URL',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await executeYtDlpNode(this);
	}
}
