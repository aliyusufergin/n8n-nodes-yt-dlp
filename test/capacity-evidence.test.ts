import { describe, expect, it } from 'vitest';

import {
	boundedFailureReason,
	captureCapacityEvidence,
	markPartialRun,
	partialCapacityEvidence,
} from '../e2e/n8n-2.27.4/capacity-evidence.mjs';

const summarizedProgress = {
	acceptance: { allRequestsSucceeded: true, ffmpegThreadsRestricted: true },
	capacityDecision: {
		concurrentRequests: 10,
		nodeHardCapsChanged: false,
		safeAtConcurrency10: true,
		supportedScope: 'one frozen-head worker at concurrency 10 on the measured topology',
	},
	measurements: { sampleCount: 900 },
	outcome: 'pass',
	rawSamples: [{ at: '2026-08-15T09:00:00.000Z' }],
	startedAt: 1_000,
	step: 'stale sweep recovery',
};

describe('capacity lane partial evidence', () => {
	it('keeps every measurement the lane had taken before it failed', () => {
		const partial = partialCapacityEvidence(
			summarizedProgress,
			new Error('stale sweep recovery retained a workspace.'),
			1_500,
		);

		expect(partial.acceptance).toEqual(summarizedProgress.acceptance);
		expect(partial.measurements).toEqual({ sampleCount: 900 });
		expect(partial.rawSamples).toEqual([{ at: '2026-08-15T09:00:00.000Z' }]);
	});

	it('marks the record partial with the step it stopped at and why', () => {
		const partial = partialCapacityEvidence(
			summarizedProgress,
			new Error('stale sweep recovery retained a workspace.'),
			1_500,
		);

		expect(partial.outcome).toBe('partial');
		expect(partial.partial).toEqual({
			failedStep: 'stale sweep recovery',
			reason: 'Error: stale sweep recovery retained a workspace.',
		});
	});

	it('refuses to report a safe capacity decision for a run that did not finish', () => {
		const partial = partialCapacityEvidence(summarizedProgress, new Error('killed'), 1_500);

		expect(partial.capacityDecision).toEqual({
			concurrentRequests: 1,
			nodeHardCapsChanged: false,
			safeAtConcurrency10: false,
			supportedScope: 'unsupported: the capacity lane stopped before it measured its full envelope',
		});
	});

	it('reports how long the lane ran before it stopped', () => {
		expect(partialCapacityEvidence(summarizedProgress, new Error('killed'), 1_500).durationMs).toBe(
			500,
		);
	});

	it('leaves the duration out of a lane that failed before it started measuring', () => {
		const partial = partialCapacityEvidence(
			{ step: 'container identification' },
			new Error('no such service: worker'),
			1_500,
		);

		expect(partial).not.toHaveProperty('durationMs');
		expect(partial.partial.failedStep).toBe('container identification');
	});

	it('records an unnamed step rather than losing the record', () => {
		expect(partialCapacityEvidence({}, new Error('killed'), 1_500).partial.failedStep).toBe(
			'unrecorded step',
		);
	});

	it('carries the schema version every capacity record carries', () => {
		expect(partialCapacityEvidence({}, new Error('killed'), 1_500).schemaVersion).toBe(1);
	});

	it('keeps the progress bookkeeping out of the written record', () => {
		const partial = partialCapacityEvidence(summarizedProgress, new Error('killed'), 1_500);

		expect(partial).not.toHaveProperty('step');
		expect(partial).not.toHaveProperty('startedAt');
	});

	it('bounds the recorded reason so a flooded failure cannot bloat the evidence', () => {
		const reason = boundedFailureReason(new Error('x'.repeat(4_000)), 200);

		expect(reason).toHaveLength(200);
		expect(reason.endsWith('… (truncated)')).toBe(true);
		expect(reason.startsWith('Error: xxx')).toBe(true);
	});

	it('records a thrown value that is not an error', () => {
		expect(boundedFailureReason('worker container vanished')).toBe('worker container vanished');
	});

	it('describes a thrown value that cannot be turned into a string', () => {
		expect(boundedFailureReason(Object.create(null))).toBe('unprintable thrown value');
	});

	it('describes an error whose own message cannot be turned into a string', () => {
		const error = new Error('placeholder');
		Object.defineProperty(error, 'message', { value: Symbol('unstoppable') });

		expect(boundedFailureReason(error)).toBe('unprintable thrown value');
	});
});

interface CapturedCapacityRecord {
	capacityDecision?: { safeAtConcurrency10: boolean };
	outcome?: string;
	partial?: { failedStep: string; reason: string };
	rawSamples?: unknown;
	schemaVersion?: number;
}

describe('capacity lane evidence capture', () => {
	function evidenceRecord() {
		return {
			outcome: undefined as string | undefined,
			scenarios: {} as Record<string, CapturedCapacityRecord>,
		};
	}

	it('keeps the lane result of a run that completed', async () => {
		const evidence = evidenceRecord();
		const written: unknown[] = [];

		await captureCapacityEvidence({
			evidence,
			lane: async () => ({ outcome: 'pass', schemaVersion: 1 }),
			onPartial: async (record: unknown) => {
				written.push(record);
			},
		});

		expect(evidence.scenarios.capacity).toEqual({ outcome: 'pass', schemaVersion: 1 });
		expect(evidence.outcome).toBeUndefined();
		expect(written).toEqual([]);
	});

	it('keeps the measurements of a lane that threw and marks the run partial', async () => {
		const evidence = evidenceRecord();
		const written: unknown[] = [];

		await expect(
			captureCapacityEvidence({
				evidence,
				lane: async (progress: Record<string, unknown>) => {
					progress.step = 'stale sweep recovery';
					progress.rawSamples = [{ at: '2026-08-15T09:00:00.000Z' }];
					throw new Error('stale sweep recovery retained a workspace.');
				},
				onPartial: async (record: unknown) => {
					written.push(record);
				},
			}),
		).rejects.toThrow('stale sweep recovery retained a workspace.');

		expect(evidence.outcome).toBe('partial');
		expect(evidence.scenarios.capacity.rawSamples).toEqual([{ at: '2026-08-15T09:00:00.000Z' }]);
		expect(evidence.scenarios.capacity.outcome).toBe('partial');
		expect(evidence.scenarios.capacity.capacityDecision?.safeAtConcurrency10).toBe(false);
		expect(evidence.scenarios.capacity.partial?.failedStep).toBe('stale sweep recovery');
		expect(written).toEqual([evidence.scenarios.capacity]);
	});

	it('still records a lane that threw a value no string can describe', async () => {
		const evidence = evidenceRecord();
		const thrown = Object.create(null) as object;
		let rethrown: unknown;

		await captureCapacityEvidence({
			evidence,
			lane: async (progress: Record<string, unknown>) => {
				progress.step = 'load window';
				throw thrown;
			},
			onPartial: async () => {},
		}).catch((error: unknown) => {
			rethrown = error;
		});

		expect(rethrown).toBe(thrown);
		expect(evidence.scenarios.capacity.partial).toEqual({
			failedStep: 'load window',
			reason: 'unprintable thrown value',
		});
	});

	it('reports rather than substitutes a failure to record the partial evidence', async () => {
		const evidence = evidenceRecord();
		const stderr: string[] = [];
		const write = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;

		try {
			await expect(
				captureCapacityEvidence({
					evidence,
					lane: async () => {
						throw new Error('targeted recreation left a stale workspace.');
					},
					onPartial: async () => {
						throw new Error('ENOSPC: no space left on device');
					},
				}),
			).rejects.toThrow('targeted recreation left a stale workspace.');
		} finally {
			process.stderr.write = write;
		}

		expect(stderr.join('')).toContain('ENOSPC: no space left on device');
	});
});

describe('run marked partial after the capacity lane', () => {
	it('marks the run partial at the step that closed it, keeping the lane record intact', () => {
		const evidence = {
			outcome: undefined as string | undefined,
			partial: undefined as { failedStep: string; reason: string } | undefined,
			scenarios: { capacity: { outcome: 'pass' } },
		};

		markPartialRun(evidence, 'registry request evidence', new Error('Registry saw no metadata.'));

		expect(evidence.outcome).toBe('partial');
		expect(evidence.partial).toEqual({
			failedStep: 'registry request evidence',
			reason: 'Error: Registry saw no metadata.',
		});
		expect(evidence.scenarios.capacity).toEqual({ outcome: 'pass' });
	});
});
