import { describe, expect, it } from 'vitest';

import {
	failureCodeCounts,
	queueLatencies,
	requestTimeLimitMs,
	settleRequestWait,
	summarizeRequestTimeLimit,
	timedOutRequestRecord,
} from '../e2e/n8n-2.27.4/capacity-load.mjs';

function waitTimeout(executionId: string): Error {
	return new Error(`execution ${executionId} timed out.`);
}

const successfulRequest = {
	artifactCount: 2,
	executionId: '1',
	queueLatencyMs: 120,
	status: 'success',
};

describe('capacity lane request time limit', () => {
	it('settles a request that finished inside the limit into its execution', async () => {
		await expect(
			settleRequestWait(
				'22',
				requestTimeLimitMs,
				async () => ({ status: 'success' }),
				async () => {
					throw new Error('The confirming read must not run for a request that finished.');
				},
			),
		).resolves.toEqual({ execution: { status: 'success' } });
	});

	it('settles a request the instance still reports as running into the time it waited', async () => {
		await expect(
			settleRequestWait(
				'22',
				900_000,
				async () => {
					throw waitTimeout('22');
				},
				async () => ({ status: 'running' }),
			),
		).resolves.toEqual({ waitedMs: 900_000 });
	});

	it('settles a limit failure that carries the last polling error behind it', async () => {
		await expect(
			settleRequestWait(
				'22',
				900_000,
				async () => {
					throw new Error('execution 22 timed out. GET /executions/22 returned 503: unavailable');
				},
				async () => ({ status: 'waiting' }),
			),
		).resolves.toEqual({ waitedMs: 900_000 });
	});

	it('settles a request that finished as the wait gave up into its execution', async () => {
		await expect(
			settleRequestWait(
				'22',
				900_000,
				async () => {
					throw waitTimeout('22');
				},
				async () => ({ status: 'success' }),
			),
		).resolves.toEqual({ execution: { status: 'success' } });
	});

	it('rejects the limit when the instance cannot serve the confirming read', async () => {
		await expect(
			settleRequestWait(
				'22',
				900_000,
				async () => {
					throw waitTimeout('22');
				},
				async () => {
					throw new Error('GET /executions/22 returned 503: unavailable');
				},
			),
		).rejects.toThrow('GET /executions/22 returned 503');
	});

	it('rejects a wait that failed for any reason other than the limit', async () => {
		await expect(
			settleRequestWait(
				'22',
				900_000,
				async () => {
					throw new Error('POST /workflows/9/run returned 500: internal error');
				},
				async () => ({ status: 'running' }),
			),
		).rejects.toThrow('POST /workflows/9/run returned 500');
	});

	it('rejects a limit failure raised for a different execution', async () => {
		await expect(
			settleRequestWait(
				'22',
				900_000,
				async () => {
					throw waitTimeout('23');
				},
				async () => ({ status: 'running' }),
			),
		).rejects.toThrow('execution 23 timed out.');
	});

	it('records an exceeded request as a measurement rather than a completed status', () => {
		expect(timedOutRequestRecord('22', 900_000)).toEqual({
			artifactCount: 0,
			executionId: '22',
			status: 'timed_out',
			stoppedStatus: 'unstopped',
			timedOut: true,
			waitedMs: 900_000,
		});
	});

	it('reports the enforced limit and every request that exceeded it', () => {
		expect(
			summarizeRequestTimeLimit(
				[successfulRequest, { ...timedOutRequestRecord('22', 900_000), stoppedStatus: 'canceled' }],
				900_000,
			),
		).toEqual({
			limitMs: 900_000,
			timedOutRequestCount: 1,
			timedOutRequests: [{ executionId: '22', stoppedStatus: 'canceled', waitedMs: 900_000 }],
		});
	});

	it('reports no exceeded request when every request finished inside the limit', () => {
		expect(summarizeRequestTimeLimit([successfulRequest], 900_000)).toEqual({
			limitMs: 900_000,
			timedOutRequestCount: 0,
			timedOutRequests: [],
		});
	});

	it('fails the lane when every request exceeded the limit', () => {
		expect(() =>
			summarizeRequestTimeLimit(
				[timedOutRequestRecord('22', 900_000), timedOutRequestRecord('23', 900_000)],
				900_000,
			),
		).toThrow('All 2 capacity requests exceeded the 900000 ms request time limit');
	});

	it('fails the lane when the load retained no request at all', () => {
		expect(() => summarizeRequestTimeLimit([], 900_000)).toThrow(
			'The capacity lane retained no request to judge.',
		);
	});

	it('counts a failed request under the error code the execution reported', () => {
		expect(
			failureCodeCounts([
				successfulRequest,
				{ errorCode: 'BINARY_TRANSFER_FAILED', executionId: '2', status: 'error' },
				{ errorCode: 'BINARY_TRANSFER_FAILED', executionId: '3', status: 'error' },
				{ executionId: '4', status: 'crashed' },
			]),
		).toEqual({ BINARY_TRANSFER_FAILED: 2, UNKNOWN: 1 });
	});

	it('keeps an exceeded request out of the failure codes it never reported', () => {
		expect(
			failureCodeCounts([
				successfulRequest,
				{ errorCode: 'BINARY_TRANSFER_FAILED', executionId: '2', status: 'error' },
				timedOutRequestRecord('22', 900_000),
			]),
		).toEqual({ BINARY_TRANSFER_FAILED: 1 });
	});

	it('measures queue latency only over the requests that reported a start', () => {
		expect(
			queueLatencies([
				successfulRequest,
				{
					errorCode: 'BINARY_TRANSFER_FAILED',
					executionId: '2',
					queueLatencyMs: 400,
					status: 'error',
				},
				timedOutRequestRecord('22', 900_000),
			]),
		).toEqual([120, 400]);
	});

	it('enforces a fifteen-minute request time limit by default', () => {
		expect(requestTimeLimitMs).toBe(900_000);
	});
});
