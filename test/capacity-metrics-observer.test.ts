import { describe, expect, it } from 'vitest';

import {
	createMetricsSampleTolerance,
	describeMetricsFailure,
	parseWorkerMetrics,
	settleMetricsRead,
} from '../e2e/n8n-2.27.4/metrics-observer.mjs';

const eventLoopSample = [
	'# HELP n8n_nodejs_eventloop_lag_max_seconds Maximum event loop lag.',
	'# TYPE n8n_nodejs_eventloop_lag_max_seconds gauge',
	'n8n_nodejs_eventloop_lag_max_seconds 0.031',
].join('\n');

function commandFailure(stderr: string): Error {
	return Object.assign(new Error('Command failed: docker compose exec -T worker node -e ...'), {
		stderr,
	});
}

describe('capacity lane worker metrics observer', () => {
	it('keeps only the capacity metric families and drops comments and unrelated series', () => {
		expect(
			parseWorkerMetrics(
				[
					eventLoopSample,
					'n8n_process_resident_memory_bytes 3.27176e+08',
					'n8n_scaling_mode_queue_jobs_active 4',
					'n8n_redis_latency_seconds 0.002',
					'n8n_version_info{version="2.34.5"} 1',
					'n8n_nodejs_heap_size_total_bytes 1024',
				].join('\n'),
			),
		).toEqual({
			n8n_nodejs_eventloop_lag_max_seconds: 0.031,
			n8n_process_resident_memory_bytes: 327_176_000,
			n8n_redis_latency_seconds: 0.002,
			n8n_scaling_mode_queue_jobs_active: 4,
		});
	});

	it('keeps the highest value across the labelled series of one metric', () => {
		expect(
			parseWorkerMetrics(
				[
					eventLoopSample,
					'n8n_scaling_mode_queue_jobs_active{queue="jobs"} 2',
					'n8n_scaling_mode_queue_jobs_active{queue="other"} 7',
				].join('\n'),
			),
		).toMatchObject({ n8n_scaling_mode_queue_jobs_active: 7 });
	});

	it('ignores an unparsable value instead of writing a NaN measurement', () => {
		expect(
			parseWorkerMetrics([eventLoopSample, 'n8n_redis_latency_seconds none'].join('\n')),
		).toEqual({ n8n_nodejs_eventloop_lag_max_seconds: 0.031 });
	});

	it('rejects a reading that exposes no event-loop health measurement', () => {
		expect(() => parseWorkerMetrics('n8n_redis_latency_seconds 0.002')).toThrow(
			'Worker metrics exposed no event-loop health measurement.',
		);
	});

	it('describes a failed reading from the status and body the worker reported', () => {
		expect(
			describeMetricsFailure(
				commandFailure('metrics status 500:\n  {"message":"queue metrics unavailable"}\n'),
			),
		).toBe('metrics status 500: {"message":"queue metrics unavailable"}');
	});

	it('falls back to the command error when the worker reported no diagnosable output', () => {
		expect(describeMetricsFailure({ message: 'exec timed out', stderr: '  ' })).toBe(
			'exec timed out',
		);
	});

	it('bounds a described failure so one reading cannot flood the lane output', () => {
		const reason = describeMetricsFailure({ stderr: `metrics status 500: ${'x'.repeat(1_000)}` });

		expect(reason).toHaveLength(401);
		expect(reason.endsWith('…')).toBe(true);
	});

	it('describes a failure that carries no reported text at all', () => {
		expect(describeMetricsFailure(undefined)).toBe(
			'Worker metrics read failed without a diagnosable reason.',
		);
	});

	it('settles a successful reading into its measurements', async () => {
		await expect(
			settleMetricsRead(async () => parseWorkerMetrics(eventLoopSample)),
		).resolves.toEqual({ metrics: { n8n_nodejs_eventloop_lag_max_seconds: 0.031 } });
	});

	it('settles a failed status from the endpoint into a reason instead of rejecting', async () => {
		await expect(
			settleMetricsRead(async () => {
				throw commandFailure('metrics status 500: queue metrics unavailable');
			}),
		).resolves.toEqual({ reason: 'metrics status 500: queue metrics unavailable' });
	});

	it('settles an endpoint that is not listening yet into a reason', async () => {
		await expect(
			settleMetricsRead(async () => {
				throw commandFailure('fetch failed');
			}),
		).resolves.toEqual({ reason: 'fetch failed' });
	});

	it('settles a reading that exposed no event-loop measurement into a reason', async () => {
		await expect(
			settleMetricsRead(async () => parseWorkerMetrics('n8n_redis_latency_seconds 0.002')),
		).resolves.toEqual({ reason: 'Worker metrics exposed no event-loop health measurement.' });
	});

	it('recognises an endpoint failure behind the warnings docker compose writes first', async () => {
		await expect(
			settleMetricsRead(async () => {
				throw commandFailure(
					'time="..." level=warning msg="a warning"\nmetrics status 503: unavailable',
				);
			}),
		).resolves.toMatchObject({ reason: expect.stringContaining('metrics status 503') });
	});

	it('rejects a reading the worker container itself could not serve', async () => {
		await expect(
			settleMetricsRead(async () => {
				throw commandFailure('Error response from daemon: container worker is not running');
			}),
		).rejects.toThrow('Command failed: docker compose exec');
	});

	it('lets a transient failed reading pass without failing the run', () => {
		const tolerance = createMetricsSampleTolerance();

		tolerance.recordSuccess();
		expect(() =>
			tolerance.recordFailure({ at: '2026-08-14T10:00:01.000Z', reason: 'metrics status 500' }),
		).not.toThrow();
		tolerance.recordSuccess();

		expect(tolerance.summary()).toMatchObject({
			longestFailureRun: 1,
			readingCount: 2,
			skippedReadingCount: 1,
			skippedReadings: [{ at: '2026-08-14T10:00:01.000Z', reason: 'metrics status 500' }],
		});
	});

	it('fails the run when the readings stay broken for longer than the consecutive budget', () => {
		const tolerance = createMetricsSampleTolerance({ maxConsecutiveFailures: 2 });

		tolerance.recordFailure({ at: '2026-08-14T10:00:01.000Z', reason: 'metrics status 500' });
		tolerance.recordFailure({ at: '2026-08-14T10:00:02.000Z', reason: 'metrics status 500' });

		expect(() =>
			tolerance.recordFailure({ at: '2026-08-14T10:00:03.000Z', reason: 'metrics status 503' }),
		).toThrow('Worker metrics failed 3 consecutive readings (limit 2): metrics status 503');
	});

	it('counts a recovered reading as the end of a failure run', () => {
		const tolerance = createMetricsSampleTolerance({ maxConsecutiveFailures: 2 });

		tolerance.recordFailure({ at: '2026-08-14T10:00:01.000Z', reason: 'metrics status 500' });
		tolerance.recordFailure({ at: '2026-08-14T10:00:02.000Z', reason: 'metrics status 500' });
		tolerance.recordSuccess();

		expect(() =>
			tolerance.recordFailure({ at: '2026-08-14T10:00:04.000Z', reason: 'metrics status 500' }),
		).not.toThrow();
		expect(tolerance.summary()).toMatchObject({ longestFailureRun: 2, skippedReadingCount: 3 });
	});

	it('fails the run when scattered failures exhaust the whole-run budget', () => {
		const tolerance = createMetricsSampleTolerance({
			maxConsecutiveFailures: 2,
			maxTotalFailures: 2,
		});

		tolerance.recordFailure({ at: '2026-08-14T10:00:01.000Z', reason: 'metrics status 500' });
		tolerance.recordSuccess();
		tolerance.recordFailure({ at: '2026-08-14T10:00:03.000Z', reason: 'metrics status 500' });
		tolerance.recordSuccess();

		expect(() =>
			tolerance.recordFailure({ at: '2026-08-14T10:00:05.000Z', reason: 'metrics status 500' }),
		).toThrow('Worker metrics failed 3 readings in this run (limit 2): metrics status 500');
	});

	it('reports the budget it enforced alongside what it skipped', () => {
		expect(
			createMetricsSampleTolerance({ maxConsecutiveFailures: 5, maxTotalFailures: 15 }).summary(),
		).toEqual({
			limits: { maxConsecutiveFailures: 5, maxTotalFailures: 15 },
			longestFailureRun: 0,
			readingCount: 0,
			skippedReadingCount: 0,
			skippedReadings: [],
		});
	});

	it('skips only the reading that failed and keeps reading after it', async () => {
		const tolerance = createMetricsSampleTolerance();
		const readings = [
			async () => parseWorkerMetrics(eventLoopSample),
			async () => {
				throw commandFailure('metrics status 500');
			},
			async () => parseWorkerMetrics(eventLoopSample),
		];
		const measured = [];

		for (const [index, read] of readings.entries()) {
			const settled = await settleMetricsRead(read);
			if (settled.reason === undefined) {
				tolerance.recordSuccess();
				measured.push(settled.metrics);
				continue;
			}
			tolerance.recordFailure({ at: `2026-08-14T10:00:0${index}.000Z`, reason: settled.reason });
		}

		expect(measured).toHaveLength(2);
		expect(tolerance.summary()).toMatchObject({
			readingCount: 2,
			skippedReadingCount: 1,
			skippedReadings: [{ at: '2026-08-14T10:00:01.000Z', reason: 'metrics status 500' }],
		});
	});
});
