import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	ToolchainAttestationError,
	getVerifiedToolchain,
	type VerifiedToolchain,
} from 'n8n-nodes-yt-dlp-platform';

import packageMetadata from '../../package.json';

import {
	INVALID_ARGUMENTS,
	InvalidArgumentsError,
	createYtDlpExecutionPlan,
	type YtDlpExecutionPlan,
} from './arguments';
import {
	parseAuthenticationCredential,
	type YtDlpAuthenticationData,
} from './authentication';
import {
	INVALID_SOURCE_URL,
	InvalidSourceUrlError,
	createDownloadRequest,
} from './source-url';
import {
	BinaryTransferError,
	InvalidArtifactSetError,
	executeDownloadRequest,
} from './download';
import {
	DEFAULT_REQUEST_TIMEOUT_MINUTES,
	MAXIMUM_REQUEST_TIMEOUT_MINUTES,
	RESOURCE_LIMIT,
	YtDlpExecutionResourceLimitError,
	YtDlpRequestResourceLimitError,
	createResourceEnvelope,
	readHostExecutionDurationMs,
	readHostResourceConfiguration,
	resourceLimitViolationError,
	type ResourceEnvelope,
	type ResourceLimitTerm,
} from './resource-envelope';
import {
	YtDlpProcessCancellationError,
	YtDlpProcessError,
	YtDlpProcessTerminationError,
} from './process';
import {
	WorkspaceCleanupError,
	createExecutionWorkspace,
	type ExecutionWorkspace,
} from './workspace';

export type DownloadRequestExecutor = (
	plan: YtDlpExecutionPlan,
	itemIndex: number,
	resourceEnvelope: ResourceEnvelope,
	signal: AbortSignal,
	authentication?: YtDlpAuthenticationData,
	workspaceParent?: string,
) => Promise<INodeExecutionData[]>;

export type ExecutionWorkspaceFactory = () => Promise<ExecutionWorkspace>;

export type ToolchainResolver = () => Promise<VerifiedToolchain>;

const REQUEST_FAILURE_MESSAGES = {
	INVALID_SOURCE_URL: 'The Source URL is invalid.',
	INVALID_ARGUMENTS: 'The Arguments value is invalid.',
	YTDLP_FAILED: 'yt-dlp could not complete the Download Request.',
	REQUEST_TIMEOUT: 'The Download Request exceeded its timeout.',
	PROCESS_OUTPUT_LIMIT: 'The Download Request exceeded the process output limit.',
	RESOURCE_LIMIT: 'The Download Request exceeded its Resource Envelope.',
	INVALID_ARTIFACT_SET: 'The Download Request produced an invalid Artifact set.',
	BINARY_TRANSFER_FAILED: 'An Artifact could not be transferred to n8n binary storage.',
} as const;

type RequestFailureCode = keyof typeof REQUEST_FAILURE_MESSAGES;

const LOG_SCHEMA_VERSION = 1;
const PACKAGE_VERSION = packageMetadata.version;
const LOG_ERROR_CODES = new Set<string>([
	...Object.keys(REQUEST_FAILURE_MESSAGES),
	'PROCESS_TERMINATION_FAILED',
	'STALE_WORKSPACE_CLEANUP_FAILED',
	'WORKSPACE_CLEANUP_FAILED',
]);

interface ArtifactTotals {
	artifactCount: number;
	finalBytes: number;
}

function artifactTotals(items: readonly INodeExecutionData[]): ArtifactTotals {
	let artifactCount = 0;
	let finalBytes = 0;
	for (const item of items) {
		if (item.json.status !== 'success') continue;
		artifactCount++;
		const sizeBytes = item.json.sizeBytes;
		if (typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) {
			finalBytes += sizeBytes;
		}
	}
	return { artifactCount, finalBytes };
}

function durationSince(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function baseLogMetadata(execution: IExecuteFunctions): Record<string, unknown> {
	return {
		executionId: execution.getExecutionId(),
		packageVersion: PACKAGE_VERSION,
		schemaVersion: LOG_SCHEMA_VERSION,
		toolchainVersion: PACKAGE_VERSION,
	};
}

function logRequestTerminal(
	execution: IExecuteFunctions,
	level: 'debug' | 'error' | 'warn',
	event: ArtifactTotals & {
		durationMs: number;
		errorCode?: string;
		inputIndex: number;
		outcome: 'cancelled' | 'failure' | 'global_failure' | 'success';
	},
): void {
	const metadata: Record<string, unknown> = {
		...baseLogMetadata(execution),
		artifactCount: event.artifactCount,
		durationMs: event.durationMs,
		finalBytes: event.finalBytes,
		inputIndex: event.inputIndex,
		outcome: event.outcome,
	};
	if (event.errorCode !== undefined) metadata.errorCode = event.errorCode;
	execution.logger[level]('yt-dlp request terminal', metadata);
}

function globalErrorCode(error: unknown): string {
	if (error instanceof ToolchainAttestationError) return error.code;
	if (error instanceof WorkspaceCleanupError) return error.code;
	if (error instanceof YtDlpExecutionResourceLimitError) return error.code;
	if (error instanceof YtDlpProcessTerminationError) return 'PROCESS_TERMINATION_FAILED';
	if (
		error instanceof NodeOperationError &&
		typeof error.context.errorCode === 'string' &&
		LOG_ERROR_CODES.has(error.context.errorCode)
	) {
		return error.context.errorCode;
	}
	return 'UNEXPECTED_ERROR';
}

/**
 * An argument rejection authors its own message so the workflow author reads which option to fix;
 * every other typed request failure keeps the fixed per-code message.
 */
function requestFailureMessage(errorCode: RequestFailureCode, error: unknown): string {
	return error instanceof InvalidArgumentsError
		? error.message
		: REQUEST_FAILURE_MESSAGES[errorCode];
}

function requestFailureCode(error: unknown): RequestFailureCode | undefined {
	if (error instanceof YtDlpProcessError) return error.code;
	if (error instanceof InvalidSourceUrlError) return INVALID_SOURCE_URL;
	if (error instanceof InvalidArgumentsError) return INVALID_ARGUMENTS;
	if (error instanceof YtDlpRequestResourceLimitError) return RESOURCE_LIMIT;
	if (error instanceof InvalidArtifactSetError) return error.code;
	if (error instanceof BinaryTransferError) return error.code;
	return undefined;
}

/**
 * The execution-scoped Resource Envelope terms reach the node boundary as global failures. The
 * code and the message come from the term's classification, so this site does not re-decide
 * either one.
 */
function executionResourceLimitError(
	execution: IExecuteFunctions,
	term: ResourceLimitTerm,
): NodeOperationError {
	const violation = resourceLimitViolationError(term);
	const errorCode = violation.code;
	const error = new NodeOperationError(execution.getNode(), violation, {
		description: errorCode,
	});
	error.context.errorCode = errorCode;
	return error;
}

function throwIfExecutionTerminated(
	execution: IExecuteFunctions,
	terminationReason: 'cancelled' | 'timeout' | undefined,
): void {
	if (terminationReason === 'cancelled') {
		throw new NodeOperationError(execution.getNode(), new YtDlpProcessCancellationError());
	}
	if (terminationReason !== 'timeout') return;
	throw executionResourceLimitError(execution, 'executionDuration');
}

export async function executeYtDlpNode(
	execution: IExecuteFunctions,
	startRequest: DownloadRequestExecutor | undefined = undefined,
	startWorkspace: ExecutionWorkspaceFactory = createExecutionWorkspace,
	resolveToolchain: ToolchainResolver = getVerifiedToolchain,
): Promise<INodeExecutionData[][]> {
	const executionStartedAt = Date.now();
	const items = execution.getInputData();
	const outputItems: INodeExecutionData[] = [];
	// n8n owns the error output: for `continueErrorOutput` its engine overwrites the last main
	// output with the items it recognises as errors on the earlier outputs, so a node cannot
	// write that branch itself. The Failure Item is not an engine-recognised error shape, so the
	// error branch would stay silently empty. Warn instead of leaving a dead branch.
	if (execution.getNode().onError === 'continueErrorOutput') {
		execution.addExecutionHints({
			message:
				'This node reports a Download Request failure as a Failure Item on its regular output, so the error output stays empty. Branch on {{ $json.status }} instead.',
			location: 'outputPane',
			type: 'warning',
		});
	}
	const executionController = new AbortController();
	let executionTerminationReason: 'cancelled' | 'timeout' | undefined;
	let executionWorkspace: ExecutionWorkspace | undefined;
	let executionError: unknown;
	let hadRequestFailure = false;
	let workspaceCloseFailed = false;
	const externalSignal = execution.getExecutionCancelSignal?.();
	const cancelExecution = (): void => {
		executionTerminationReason ??= 'cancelled';
		executionController.abort();
	};

	externalSignal?.addEventListener('abort', cancelExecution, { once: true });
	if (externalSignal?.aborted === true) cancelExecution();
	// The execution duration bound is the host's: n8n's own execution timeout, resolved the way n8n
	// resolves it. Where n8n imposes no timeout the node starts no timer, so a long download is
	// bounded by what the operator configured and by nothing the node chose.
	//
	// n8n starts its own timer at execution start and this one starts when the node does, so on a
	// timed-out execution n8n's stop normally arrives first and the request ends as a cancellation.
	// The node cannot read n8n's deadline — `executionTimeoutTimestamp` is on
	// `IWorkflowExecuteAdditionalData`, not on the node's `IExecuteFunctions` — so this timer is
	// the backstop that carries the classification when the host's stop does not reach the worker.
	const executionDurationMs = readHostExecutionDurationMs(
		process.env,
		execution.getWorkflowSettings?.()?.executionTimeout,
	);
	let executionTimer: NodeJS.Timeout | undefined;
	if (executionDurationMs !== undefined) {
		executionTimer = setTimeout(() => {
			executionTerminationReason ??= 'timeout';
			executionController.abort();
		}, executionDurationMs);
		executionTimer.unref?.();
	}

	try {
		if (startRequest === undefined) {
			await resolveToolchain();
			startRequest = async (
				plan,
				itemIndex,
				resourceEnvelope,
				signal,
				authentication,
				workspaceParent,
			) => {
				const toolchain = await resolveToolchain();
				return await executeDownloadRequest(execution, plan, itemIndex, {
					authentication,
					denoPath: toolchain.deno,
					executablePath: toolchain.ytDlp,
					ffmpegPath: toolchain.ffmpeg,
					resourceEnvelope,
					signal,
					workspaceParent,
				});
			};
		}
		executionWorkspace = await startWorkspace();
		throwIfExecutionTerminated(execution, executionTerminationReason);
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const requestStartedAt = Date.now();
			try {
				const sourceUrl = execution.getNodeParameter('sourceUrl', itemIndex);
				const argumentsValue = execution.getNodeParameter('arguments', itemIndex, '') as string;
				const request = createDownloadRequest(sourceUrl, argumentsValue);
				const plan = createYtDlpExecutionPlan(request);
				// The derived bounds are read where the request runs: the workspace disk is measured
				// on the Execution Workspace the request is about to write into.
				const resourceEnvelope = createResourceEnvelope(
					{
						requestTimeoutMinutes: execution.getNodeParameter(
							'requestTimeoutMinutes',
							itemIndex,
							DEFAULT_REQUEST_TIMEOUT_MINUTES,
						) as number,
					},
					await readHostResourceConfiguration(executionWorkspace.path),
				);

				const authentication =
					execution.getNode().credentials?.ytDlpAuthentication === undefined
						? undefined
						: parseAuthenticationCredential(
								await execution.getCredentials('ytDlpAuthentication', itemIndex),
							);

				const requestOutput = await startRequest(
					plan,
					itemIndex,
					resourceEnvelope,
					executionController.signal,
					authentication,
					executionWorkspace.path,
				);
				throwIfExecutionTerminated(execution, executionTerminationReason);
				const totals = artifactTotals(requestOutput);
				logRequestTerminal(execution, 'debug', {
					artifactCount: totals.artifactCount,
					durationMs: durationSince(requestStartedAt),
					finalBytes: totals.finalBytes,
					inputIndex: itemIndex,
					outcome: 'success',
				});
				outputItems.push(...requestOutput);
			} catch (error) {
				let effectiveError = error;
				if (
					!(error instanceof WorkspaceCleanupError) &&
					!(error instanceof YtDlpProcessTerminationError)
				) {
					try {
						throwIfExecutionTerminated(execution, executionTerminationReason);
					} catch (terminationError) {
						effectiveError = terminationError;
					}
				}
				const cancelled =
					!(effectiveError instanceof WorkspaceCleanupError) &&
					!(effectiveError instanceof YtDlpProcessTerminationError) &&
					(executionTerminationReason === 'cancelled' ||
						effectiveError instanceof YtDlpProcessCancellationError);
				const errorCode = requestFailureCode(effectiveError);
				if (cancelled) {
					logRequestTerminal(execution, 'warn', {
						artifactCount: 0,
						durationMs: durationSince(requestStartedAt),
						errorCode: 'CANCELLED',
						finalBytes: 0,
						inputIndex: itemIndex,
						outcome: 'cancelled',
					});
					throw effectiveError;
				}
				if (errorCode !== undefined) {
					hadRequestFailure = true;
					logRequestTerminal(execution, 'warn', {
						artifactCount: 0,
						durationMs: durationSince(requestStartedAt),
						errorCode,
						finalBytes: 0,
						inputIndex: itemIndex,
						outcome: 'failure',
					});
					if (execution.continueOnFail()) {
						outputItems.push({
							json: {
								status: 'error',
								errorCode,
								errorMessage: requestFailureMessage(errorCode, effectiveError),
							},
							pairedItem: { item: itemIndex },
						});
						continue;
					}

					const cause =
						effectiveError instanceof Error
							? effectiveError
							: new Error(requestFailureMessage(errorCode, effectiveError));
					const nodeError = new NodeOperationError(execution.getNode(), cause, {
						description: errorCode,
						itemIndex,
					});
					nodeError.context.errorCode = errorCode;
					throw nodeError;
				}

				logRequestTerminal(execution, 'error', {
					artifactCount: 0,
					durationMs: durationSince(requestStartedAt),
					errorCode: globalErrorCode(effectiveError),
					finalBytes: 0,
					inputIndex: itemIndex,
					outcome: 'global_failure',
				});
				throw effectiveError instanceof Error
					? effectiveError
					: new Error('Unexpected request failure.');
			}
		}
	} catch (error) {
		executionError = error;
	} finally {
		clearTimeout(executionTimer);
		externalSignal?.removeEventListener('abort', cancelExecution);
		if (executionWorkspace !== undefined) {
			const preserve =
				executionError instanceof YtDlpProcessTerminationError &&
				!executionError.processClosed;
			try {
				await executionWorkspace.close({ preserve });
			} catch (error) {
				workspaceCloseFailed = true;
				executionError = error;
			}
		}
		const totals = artifactTotals(outputItems);
		const cancelled =
			!workspaceCloseFailed &&
			!(executionError instanceof WorkspaceCleanupError) &&
			!(executionError instanceof YtDlpProcessTerminationError) &&
			(executionTerminationReason === 'cancelled' ||
				executionError instanceof YtDlpProcessCancellationError);
		const summaryMetadata: Record<string, unknown> = {
			...baseLogMetadata(execution),
			artifactCount: totals.artifactCount,
			durationMs: durationSince(executionStartedAt),
			finalBytes: totals.finalBytes,
			outcome:
				executionError !== undefined
					? cancelled
						? 'cancelled'
						: 'failure'
					: hadRequestFailure
						? 'partial_failure'
						: 'success',
		};
		if (executionError !== undefined) {
			summaryMetadata.errorCode = cancelled ? 'CANCELLED' : globalErrorCode(executionError);
		}
		execution.logger.info('yt-dlp execution summary', summaryMetadata);
	}

	if (executionError !== undefined) throw executionError;
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
		credentials: [{ name: 'ytDlpAuthentication', required: false }],
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await executeYtDlpNode(this);
	}
}
