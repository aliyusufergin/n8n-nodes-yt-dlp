/**
 * The time one capacity request may take before the lane stops waiting for it.
 *
 * Fifteen minutes is the same bound the lane has always waited, and it is far
 * above what the measured workload needs: a completed request of this load
 * finishes in seconds, and the whole disposable run — load window, FFmpeg
 * probe, and both recovery lanes — is budgeted at about 25 minutes. A request
 * still running after fifteen minutes is therefore not a slow request, it is a
 * hung one, and waiting longer only buys a longer run with the same result.
 * Raising the bound is not the answer to a hang; measuring it is.
 */
export const requestTimeLimitMs = 900_000;

const timedOutStatus = 'timed_out';
const unfinishedStatuses = ['new', 'running', 'waiting'];

/**
 * Waits for one capacity request and turns the time limit into a measurement.
 *
 * The lane submits ten concurrent requests and previously waited for each with
 * a bare timeout, so a single hung execution rejected the whole load window and
 * threw away every sample, process observation, and recovery measurement the
 * run had already taken. Exceeding the limit is a capacity result — it belongs
 * in the evidence — so it settles into the time waited instead of rejecting.
 *
 * The waiting poll swallows the error of every attempt it makes, so the limit
 * failure alone cannot tell a hung execution from an instance that stopped
 * answering. One confirming read decides which happened: an execution the
 * instance still reports as unfinished is the measurement, an execution that
 * finished in the moment the wait gave up is settled as the completed request
 * it is, and a read the instance cannot serve rejects, so an outage is never
 * recorded as ten hung requests.
 */
export async function settleRequestWait(executionId, limitMs, wait, verify) {
	try {
		return { execution: await wait() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith(`execution ${executionId} timed out.`)) throw error;
		const execution = await verify();
		return unfinishedStatuses.includes(execution.status) ? { waitedMs: limitMs } : { execution };
	}
}

/**
 * Describes a request that exceeded the limit.
 *
 * The record carries no status the instance reported, because the instance
 * reported none: the execution was still running when the lane stopped
 * waiting. `stoppedStatus` starts as `unstopped` and is replaced by whatever
 * terminal status the lane's stop attempt reaches, so the evidence separates a
 * request that hung and then cancelled from one that would not stop at all.
 */
export function timedOutRequestRecord(executionId, waitedMs) {
	return {
		artifactCount: 0,
		executionId,
		status: timedOutStatus,
		stoppedStatus: 'unstopped',
		timedOut: true,
		waitedMs,
	};
}

/**
 * Reports the enforced limit and every request that exceeded it.
 *
 * A run where every request hung measured nothing, so tolerating the limit must
 * not turn an empty load into a pass: that run fails here rather than being
 * summarized into a verdict no measurement supports.
 */
export function summarizeRequestTimeLimit(requests, limitMs = requestTimeLimitMs) {
	if (requests.length === 0) throw new Error('The capacity lane retained no request to judge.');
	const timedOut = requests.filter(({ timedOut: exceeded }) => exceeded === true);
	if (timedOut.length === requests.length) {
		throw new Error(
			`All ${requests.length} capacity requests exceeded the ${limitMs} ms request time limit; the lane measured no completed request.`,
		);
	}
	return {
		limitMs,
		timedOutRequestCount: timedOut.length,
		timedOutRequests: timedOut.map(({ executionId, stoppedStatus, waitedMs }) => ({
			executionId,
			stoppedStatus,
			waitedMs,
		})),
	};
}

/**
 * Counts the error codes the failed requests reported.
 *
 * A request that exceeded the time limit is counted separately, under
 * `requestTimeLimit`, and is deliberately absent here: it reported no error
 * code, and folding it in as `UNKNOWN` would make a hang indistinguishable
 * from the `BINARY_TRANSFER_FAILED` class the lane exists to catch.
 */
export function failureCodeCounts(requests) {
	const counts = new Map();
	for (const request of requests) {
		if (request.timedOut === true || request.status === 'success') continue;
		const code = request.errorCode ?? 'UNKNOWN';
		counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
}

/**
 * Collects the queue latencies the requests reported.
 *
 * A request that never started reports no latency, so it contributes nothing
 * rather than a fabricated one; the percentile the lane judges stays a
 * measurement of the requests the queue actually admitted.
 */
export function queueLatencies(requests) {
	return requests
		.map(({ queueLatencyMs }) => queueLatencyMs)
		.filter((latency) => Number.isFinite(latency));
}
