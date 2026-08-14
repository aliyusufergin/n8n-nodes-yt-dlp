export interface SampleObserver<Sample> {
	collection: Sample[];
	intervalMs: number;
	snapshot: () => Promise<Sample>;
}

export function collectUntilComplete<Result>(
	operation: () => Promise<Result>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	observers: SampleObserver<any>[],
): Promise<Result>;
