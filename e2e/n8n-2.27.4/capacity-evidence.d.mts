export interface CapacityLaneProgress {
	[measurement: string]: unknown;
	startedAt?: number;
	step?: string;
}

export interface PartialCapacityEvidence {
	[measurement: string]: unknown;
	capacityDecision: {
		concurrentRequests: number;
		nodeHardCapsChanged: boolean;
		safeAtConcurrency10: boolean;
		supportedScope: string;
	};
	durationMs?: number;
	outcome: 'partial';
	partial: {
		failedStep: string;
		reason: string;
	};
	schemaVersion: number;
}

export interface CapacityEvidenceRecord {
	outcome?: string;
	partial?: {
		failedStep: string;
		reason: string;
	};
	scenarios: Record<string, unknown>;
}

export function boundedFailureReason(error: unknown, limit?: number): string;

export function captureCapacityEvidence(options: {
	evidence: CapacityEvidenceRecord;
	lane: (progress: CapacityLaneProgress) => Promise<unknown>;
	now?: number;
	onPartial: (record: PartialCapacityEvidence) => Promise<void>;
}): Promise<void>;

export function markPartialRun(
	evidence: CapacityEvidenceRecord,
	step: string,
	error: unknown,
): CapacityEvidenceRecord;

export function partialCapacityEvidence(
	progress: CapacityLaneProgress,
	error: unknown,
	now?: number,
): PartialCapacityEvidence;
