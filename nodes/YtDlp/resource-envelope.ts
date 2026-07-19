export const RESOURCE_LIMIT = 'RESOURCE_LIMIT';
export const MEBIBYTE = 1024 * 1024;
export const MAXIMUM_EXECUTION_INPUTS = 20;
export const MAXIMUM_EXECUTION_DURATION_MS = 2 * 60 * 60 * 1000;

export const DEFAULT_REQUEST_TIMEOUT_MINUTES = 30;
export const MAXIMUM_REQUEST_TIMEOUT_MINUTES = 60;
export const DEFAULT_MAXIMUM_ARTIFACT_COUNT = 20;
export const MAXIMUM_ARTIFACT_COUNT = 50;
export const DEFAULT_MAXIMUM_ARTIFACT_SIZE_MIB = 128;
export const MAXIMUM_ARTIFACT_SIZE_MIB = 256;
export const DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB = 256;
export const MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB = 512;
export const WORKSPACE_HEADROOM_BYTES = 64 * MEBIBYTE;

export interface ResourceEnvelopeConfiguration {
	requestTimeoutMinutes?: number;
	maximumArtifactCount?: number;
	maximumArtifactSizeMiB?: number;
	maximumTotalArtifactSizeMiB?: number;
}

export interface ResourceEnvelope {
	requestTimeoutMs: number;
	maximumArtifactCount: number;
	maximumArtifactSizeBytes: number;
	maximumTotalArtifactSizeBytes: number;
	maximumWorkspaceSizeBytes: number;
}

export class YtDlpRequestResourceLimitError extends Error {
	readonly code = RESOURCE_LIMIT;

	constructor(message = 'The download request exceeds the configured Resource Envelope.') {
		super(message);
		this.name = 'YtDlpRequestResourceLimitError';
	}
}

export class YtDlpExecutionResourceLimitError extends Error {
	readonly code = RESOURCE_LIMIT;

	constructor(message: string) {
		super(message);
		this.name = 'YtDlpExecutionResourceLimitError';
	}
}

function boundedInteger(value: number, maximum: number): number {
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new YtDlpRequestResourceLimitError();
	}
	return value;
}

export function createResourceEnvelope(
	configuration: ResourceEnvelopeConfiguration,
): ResourceEnvelope {
	const requestTimeoutMinutes = boundedInteger(
		configuration.requestTimeoutMinutes ?? DEFAULT_REQUEST_TIMEOUT_MINUTES,
		MAXIMUM_REQUEST_TIMEOUT_MINUTES,
	);
	const maximumArtifactCount = boundedInteger(
		configuration.maximumArtifactCount ?? DEFAULT_MAXIMUM_ARTIFACT_COUNT,
		MAXIMUM_ARTIFACT_COUNT,
	);
	const maximumArtifactSizeMiB = boundedInteger(
		configuration.maximumArtifactSizeMiB ?? DEFAULT_MAXIMUM_ARTIFACT_SIZE_MIB,
		MAXIMUM_ARTIFACT_SIZE_MIB,
	);
	const maximumTotalArtifactSizeMiB = boundedInteger(
		configuration.maximumTotalArtifactSizeMiB ?? DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
		MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
	);
	const maximumTotalArtifactSizeBytes = maximumTotalArtifactSizeMiB * MEBIBYTE;

	return {
		requestTimeoutMs: requestTimeoutMinutes * 60 * 1000,
		maximumArtifactCount,
		maximumArtifactSizeBytes: maximumArtifactSizeMiB * MEBIBYTE,
		maximumTotalArtifactSizeBytes,
		maximumWorkspaceSizeBytes:
			2 * maximumTotalArtifactSizeBytes + WORKSPACE_HEADROOM_BYTES,
	};
}
