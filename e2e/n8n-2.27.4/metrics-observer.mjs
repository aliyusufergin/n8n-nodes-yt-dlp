const metricLine = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([+\-\d.eE]+)$/u;
const capacityMetric = /(eventloop|process_resident_memory|queue|redis)/iu;
const eventLoopMetric = /eventloop/iu;
const missingEventLoopMeasurement = 'Worker metrics exposed no event-loop health measurement.';
const endpointFailure = new RegExp(
	`metrics status \\d{3}\\b|fetch failed|${missingEventLoopMeasurement.replace('.', '\\.')}`,
	'u',
);
const maximumReasonLength = 400;

/**
 * Parses one Prometheus reading of the worker's `/metrics` endpoint into the
 * capacity metric families, keeping the highest value across the labelled
 * series of a metric.
 *
 * A reading that carries no event-loop measurement cannot support the lane's
 * event-loop acceptance check, so it is rejected as a failed reading rather
 * than accepted as a measurement the summary would silently miss.
 */
export function parseWorkerMetrics(sample) {
	const metrics = {};
	for (const line of sample.split('\n')) {
		if (line.startsWith('#')) continue;
		const match = metricLine.exec(line);
		if (!match || !capacityMetric.test(match[1])) continue;
		const value = Number(match[2]);
		if (Number.isFinite(value)) metrics[match[1]] = Math.max(metrics[match[1]] ?? value, value);
	}
	if (!Object.keys(metrics).some((name) => eventLoopMetric.test(name))) {
		throw new Error(missingEventLoopMeasurement);
	}
	return metrics;
}

/**
 * Reduces a failed metrics reading to one bounded diagnosable line.
 *
 * The reading runs inside the worker container, so the status code and the
 * response body the endpoint returned arrive on the command's standard error
 * and are preferred over the command failure itself.
 */
export function describeMetricsFailure(error) {
	const text = [error?.stderr, error?.message]
		.map((value) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''))
		.find((value) => value !== '');
	if (text === undefined) return 'Worker metrics read failed without a diagnosable reason.';
	return text.length > maximumReasonLength ? `${text.slice(0, maximumReasonLength)}…` : text;
}

/**
 * Settles one metrics reading into either its measurements or a described
 * reason, so a failed endpoint never rejects the sampling loop that owns it.
 *
 * Only a failure the endpoint itself reported is settled this way: a served
 * error status, an endpoint that is not listening yet, and a reading without
 * an event-loop measurement. A reading that failed because the command or the
 * worker container failed is not a metrics problem — the capacity lane exists
 * to catch a worker that dies under load, so that failure still rejects.
 */
export async function settleMetricsRead(read) {
	try {
		return { metrics: await read() };
	} catch (error) {
		const reason = describeMetricsFailure(error);
		if (!endpointFailure.test(reason)) throw error;
		return { reason };
	}
}

/**
 * Bounds how many metrics readings a capacity run may lose.
 *
 * A single failed reading is a transient endpoint error, not a capacity
 * result, so its measurements are dropped and sampling continues. A metrics
 * outage that outlasts either budget is a real failure and still fails the
 * lane, which keeps a broken endpoint from degrading into a silently thin
 * measurement set.
 */
export function createMetricsSampleTolerance(limits = {}) {
	const maxConsecutiveFailures = limits.maxConsecutiveFailures ?? 5;
	const maxTotalFailures = limits.maxTotalFailures ?? 15;
	const skippedReadings = [];
	let consecutiveFailures = 0;
	let longestFailureRun = 0;
	let readingCount = 0;
	return {
		recordFailure(failure) {
			skippedReadings.push(failure);
			consecutiveFailures += 1;
			longestFailureRun = Math.max(longestFailureRun, consecutiveFailures);
			if (consecutiveFailures > maxConsecutiveFailures) {
				throw new Error(
					`Worker metrics failed ${consecutiveFailures} consecutive readings (limit ${maxConsecutiveFailures}): ${failure.reason}`,
				);
			}
			if (skippedReadings.length > maxTotalFailures) {
				throw new Error(
					`Worker metrics failed ${skippedReadings.length} readings in this run (limit ${maxTotalFailures}): ${failure.reason}`,
				);
			}
		},
		recordSuccess() {
			consecutiveFailures = 0;
			readingCount += 1;
		},
		summary() {
			return {
				limits: { maxConsecutiveFailures, maxTotalFailures },
				longestFailureRun,
				readingCount,
				skippedReadingCount: skippedReadings.length,
				skippedReadings: skippedReadings.map((failure) => ({ ...failure })),
			};
		},
	};
}
