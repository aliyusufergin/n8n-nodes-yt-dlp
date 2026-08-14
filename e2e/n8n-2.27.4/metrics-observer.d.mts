export interface MetricsReadingFailure {
	at: string;
	reason: string;
}

export interface MetricsSampleToleranceLimits {
	maxConsecutiveFailures?: number;
	maxTotalFailures?: number;
}

export interface MetricsSamplingSummary {
	limits: Required<MetricsSampleToleranceLimits>;
	longestFailureRun: number;
	readingCount: number;
	skippedReadingCount: number;
	skippedReadings: MetricsReadingFailure[];
}

export interface MetricsSampleTolerance {
	recordFailure(failure: MetricsReadingFailure): void;
	recordSuccess(): void;
	summary(): MetricsSamplingSummary;
}

export type WorkerMetrics = Record<string, number>;

export function parseWorkerMetrics(sample: string): WorkerMetrics;

export function describeMetricsFailure(error: unknown): string;

export function settleMetricsRead(
	read: () => Promise<WorkerMetrics>,
): Promise<{ metrics: WorkerMetrics; reason?: undefined } | { metrics?: undefined; reason: string }>;

export function createMetricsSampleTolerance(
	limits?: MetricsSampleToleranceLimits,
): MetricsSampleTolerance;
