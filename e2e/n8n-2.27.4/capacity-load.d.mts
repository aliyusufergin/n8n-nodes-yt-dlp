export interface CapacityRequest {
	artifactCount?: number;
	errorCode?: string;
	errorName?: string;
	executionId: string;
	queueLatencyMs?: number;
	status: string;
	stoppedStatus?: string;
	timedOut?: boolean;
	waitedMs?: number;
}

export interface TimedOutRequest {
	executionId: string;
	stoppedStatus?: string;
	waitedMs?: number;
}

export interface RequestTimeLimitSummary {
	limitMs: number;
	timedOutRequestCount: number;
	timedOutRequests: TimedOutRequest[];
}

export const requestTimeLimitMs: number;

export function settleRequestWait<TExecution extends { status: string }>(
	executionId: string,
	limitMs: number,
	wait: () => Promise<TExecution>,
	verify: () => Promise<TExecution>,
): Promise<
	{ execution: TExecution; waitedMs?: undefined } | { execution?: undefined; waitedMs: number }
>;

export function timedOutRequestRecord(
	executionId: string,
	waitedMs: number,
): Required<Pick<CapacityRequest, 'artifactCount' | 'executionId' | 'status' | 'stoppedStatus' | 'timedOut' | 'waitedMs'>>;

export function summarizeRequestTimeLimit(
	requests: CapacityRequest[],
	limitMs?: number,
): RequestTimeLimitSummary;

export function failureCodeCounts(requests: CapacityRequest[]): Record<string, number>;

export function queueLatencies(requests: CapacityRequest[]): number[];
