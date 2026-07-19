import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	INVALID_ARGUMENTS,
	InvalidArgumentsError,
	createYtDlpExecutionPlan,
	type YtDlpExecutionPlan,
} from './arguments';
import {
	INVALID_SOURCE_URL,
	InvalidSourceUrlError,
	createDownloadRequest,
} from './source-url';
import {
	DEFAULT_MAXIMUM_ARTIFACT_COUNT,
	DEFAULT_MAXIMUM_ARTIFACT_SIZE_MIB,
	DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
	DEFAULT_REQUEST_TIMEOUT_MINUTES,
	MAXIMUM_EXECUTION_DURATION_MS,
	MAXIMUM_EXECUTION_INPUTS,
	MAXIMUM_ARTIFACT_COUNT,
	MAXIMUM_ARTIFACT_SIZE_MIB,
	MAXIMUM_REQUEST_TIMEOUT_MINUTES,
	MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
	RESOURCE_LIMIT,
	YtDlpExecutionResourceLimitError,
	YtDlpRequestResourceLimitError,
	createResourceEnvelope,
	type ResourceEnvelope,
} from './resource-envelope';
import { YtDlpProcessError } from './process';

export type DownloadRequestExecutor = (
	plan: YtDlpExecutionPlan,
	itemIndex: number,
	resourceEnvelope: ResourceEnvelope,
	signal: AbortSignal,
) => Promise<INodeExecutionData[]>;

const pendingDownloadRequestExecutor: DownloadRequestExecutor = () => Promise.resolve([]);

function executionResourceLimitError(execution: IExecuteFunctions, message: string): NodeOperationError {
	const error = new NodeOperationError(
		execution.getNode(),
		new YtDlpExecutionResourceLimitError(message),
		{ description: RESOURCE_LIMIT },
	);
	error.context.errorCode = RESOURCE_LIMIT;
	return error;
}

function throwIfExecutionTimedOut(
	execution: IExecuteFunctions,
	terminationReason: 'cancelled' | 'timeout' | undefined,
): void {
	if (terminationReason !== 'timeout') return;
	throw executionResourceLimitError(
		execution,
		`The execution exceeded the ${MAXIMUM_EXECUTION_DURATION_MS / (60 * 60 * 1000)}-hour Resource Envelope.`,
	);
}

export async function executeYtDlpNode(
	execution: IExecuteFunctions,
	startRequest: DownloadRequestExecutor = pendingDownloadRequestExecutor,
): Promise<INodeExecutionData[][]> {
	const items = execution.getInputData();
	const outputItems: INodeExecutionData[] = [];
	if (items.length > MAXIMUM_EXECUTION_INPUTS) {
		throw executionResourceLimitError(
			execution,
			`The execution exceeds the ${MAXIMUM_EXECUTION_INPUTS}-item Resource Envelope.`,
		);
	}
	const executionController = new AbortController();
	let executionTerminationReason: 'cancelled' | 'timeout' | undefined;
	const externalSignal = execution.getExecutionCancelSignal?.();
	const cancelExecution = (): void => {
		executionTerminationReason ??= 'cancelled';
		executionController.abort();
	};
	externalSignal?.addEventListener('abort', cancelExecution, { once: true });
	if (externalSignal?.aborted === true) cancelExecution();
	const executionTimer = setTimeout(() => {
		executionTerminationReason ??= 'timeout';
		executionController.abort();
	}, MAXIMUM_EXECUTION_DURATION_MS);
	executionTimer.unref?.();

	try {
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const sourceUrl = execution.getNodeParameter('sourceUrl', itemIndex);
				const argumentsValue = execution.getNodeParameter('arguments', itemIndex, '') as string;
				const request = createDownloadRequest(sourceUrl, argumentsValue);
				const plan = createYtDlpExecutionPlan(request);
				const resourceEnvelope = createResourceEnvelope({
					requestTimeoutMinutes: execution.getNodeParameter(
						'requestTimeoutMinutes',
						itemIndex,
						DEFAULT_REQUEST_TIMEOUT_MINUTES,
					) as number,
					maximumArtifactCount: execution.getNodeParameter(
						'maximumArtifactCount',
						itemIndex,
						DEFAULT_MAXIMUM_ARTIFACT_COUNT,
					) as number,
					maximumArtifactSizeMiB: execution.getNodeParameter(
						'maximumArtifactSizeMiB',
						itemIndex,
						DEFAULT_MAXIMUM_ARTIFACT_SIZE_MIB,
					) as number,
					maximumTotalArtifactSizeMiB: execution.getNodeParameter(
						'maximumTotalArtifactSizeMiB',
						itemIndex,
						DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
					) as number,
				});

				const requestOutput = await startRequest(
					plan,
					itemIndex,
					resourceEnvelope,
					executionController.signal,
				);
				throwIfExecutionTimedOut(execution, executionTerminationReason);
				outputItems.push(...requestOutput);
			} catch (error) {
				throwIfExecutionTimedOut(execution, executionTerminationReason);
				if (
					error instanceof YtDlpProcessError &&
					(error.code === 'REQUEST_TIMEOUT' || error.code === RESOURCE_LIMIT)
				) {
					const nodeError = new NodeOperationError(execution.getNode(), error, {
						description: error.code,
						itemIndex,
					});
					nodeError.context.errorCode = error.code;
					throw nodeError;
				}
				if (
					error instanceof InvalidSourceUrlError ||
					error instanceof InvalidArgumentsError ||
					error instanceof YtDlpRequestResourceLimitError
				) {
					const errorCode =
						error instanceof InvalidSourceUrlError
							? INVALID_SOURCE_URL
							: error instanceof InvalidArgumentsError
								? INVALID_ARGUMENTS
								: RESOURCE_LIMIT;
					const nodeError = new NodeOperationError(execution.getNode(), error, {
						description: errorCode,
						itemIndex,
					});
					nodeError.context.errorCode = errorCode;
					throw nodeError;
				}

				const cause = error instanceof Error ? error : new Error('Unexpected request failure.');
				throw new NodeOperationError(execution.getNode(), cause, { itemIndex });
			}
		}
	} finally {
		clearTimeout(executionTimer);
		externalSignal?.removeEventListener('abort', cancelExecution);
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
			{
				displayName: 'Request Timeout (Minutes)',
				name: 'requestTimeoutMinutes',
				type: 'number',
				default: DEFAULT_REQUEST_TIMEOUT_MINUTES,
				typeOptions: { minValue: 1, maxValue: MAXIMUM_REQUEST_TIMEOUT_MINUTES },
				description: 'Maximum time allowed for one Download Request',
			},
			{
				displayName: 'Maximum Artifact Count',
				name: 'maximumArtifactCount',
				type: 'number',
				default: DEFAULT_MAXIMUM_ARTIFACT_COUNT,
				typeOptions: { minValue: 1, maxValue: MAXIMUM_ARTIFACT_COUNT },
				description: 'Maximum number of Artifacts allowed for one Download Request',
			},
			{
				displayName: 'Maximum Artifact Size (MiB)',
				name: 'maximumArtifactSizeMiB',
				type: 'number',
				default: DEFAULT_MAXIMUM_ARTIFACT_SIZE_MIB,
				typeOptions: { minValue: 1, maxValue: MAXIMUM_ARTIFACT_SIZE_MIB },
				description: 'Maximum size allowed for one Artifact',
			},
			{
				displayName: 'Maximum Total Artifact Size (MiB)',
				name: 'maximumTotalArtifactSizeMiB',
				type: 'number',
				default: DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
				typeOptions: { minValue: 1, maxValue: MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB },
				description: 'Maximum combined final Artifact size for one Download Request',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await executeYtDlpNode(this);
	}
}
