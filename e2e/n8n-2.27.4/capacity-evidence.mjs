/**
 * The longest failure reason the partial record carries.
 *
 * A thrown error can carry a whole command's output behind its first line, and
 * the record exists to say where the lane stopped, not to become a second log.
 */
const failureReasonLimit = 500;

const truncationMarker = '… (truncated)';

/**
 * Describes a thrown failure in one bounded line.
 *
 * The reason is written into committed evidence, so it is truncated to `limit`
 * characters — the marker included, so the documented bound is the real one —
 * and a value thrown that is not an `Error` is still described rather than
 * dropped. Describing the failure must never fail in turn: a thrown symbol or a
 * null-prototype object rejects `String()`, and that stringification error must
 * not replace the lane's own failure, so it settles into an unprintable value
 * rather than throwing out of the record the caller is trying to write.
 */
export function boundedFailureReason(error, limit = failureReasonLimit) {
	let described;
	try {
		described = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} catch {
		described = 'unprintable thrown value';
	}
	if (described.length <= limit) return described;
	return `${described.slice(0, limit - truncationMarker.length)}${truncationMarker}`;
}

/**
 * Turns the measurements a failed capacity lane had already taken into evidence.
 *
 * The lane's last two steps are SIGKILL recovery runs that assert from end to
 * end, so the step likeliest to throw is also the last one — and a throw there
 * used to discard the whole run: a fifteen-minute sample series, 300+ process
 * observations, the container and host extrema, the FFmpeg probe, the pruning
 * proof, and the request time-limit measurement, none of which a rerun
 * reproduces because every disposable run measures a different spread.
 *
 * The lane's verdict is not softened by writing them. The record is marked
 * `partial` with the step it stopped at and a bounded description of the
 * failure, its capacity decision is forced to the unsupported one whatever the
 * summary had already computed, and the caller still rethrows: the run's exit
 * code and the release gate's behaviour are unchanged. A partial record can
 * therefore never be read as a pass, and it can never enter a capacity decision
 * as `safe`.
 */
export function partialCapacityEvidence(progress, error, now = Date.now()) {
	const { startedAt, step, ...collected } = progress;
	const duration = Number.isFinite(startedAt) ? { durationMs: now - startedAt } : {};
	return {
		...collected,
		...duration,
		capacityDecision: {
			concurrentRequests: 1,
			nodeHardCapsChanged: false,
			safeAtConcurrency10: false,
			supportedScope: 'unsupported: the capacity lane stopped before it measured its full envelope',
		},
		outcome: 'partial',
		partial: {
			failedStep: step ?? 'unrecorded step',
			reason: boundedFailureReason(error),
		},
		schemaVersion: 1,
	};
}

/**
 * Runs the capacity lane and keeps whatever it measured, pass or fail.
 *
 * The lane is handed the progress record it fills as it goes. When it throws,
 * the evidence object is marked `partial` and given the partial capacity
 * record, `onPartial` is invoked so the caller can write and report it, and the
 * lane's own error is rethrown unchanged.
 *
 * A failure inside `onPartial` — an unwritable evidence path, a full disk —
 * cannot replace the lane's failure: it would swap the run's real result for a
 * bookkeeping error and hide which assertion actually failed. The lane's error
 * is therefore always the one that reaches the caller.
 */
/**
 * Marks a run that measured the capacity lane but never reached its own end.
 *
 * The steps after the lane — reading the fixture service's evidence, reading
 * and asserting the registry's requests — run once the lane's 25 minutes of
 * measurement are already in hand, and a failure there used to discard them
 * just as surely as a failure inside the lane. They are a result of the run,
 * not of the lane, so the lane's own record keeps whatever outcome it earned
 * and the incompleteness is recorded at the top of the file.
 */
export function markPartialRun(evidence, step, error) {
	evidence.outcome = 'partial';
	evidence.partial = { failedStep: step, reason: boundedFailureReason(error) };
	return evidence;
}

export async function captureCapacityEvidence({ evidence, lane, now, onPartial }) {
	const progress = {};
	try {
		evidence.scenarios.capacity = await lane(progress);
	} catch (error) {
		evidence.outcome = 'partial';
		evidence.scenarios.capacity = partialCapacityEvidence(progress, error, now);
		try {
			await onPartial(evidence.scenarios.capacity);
		} catch (writeError) {
			process.stderr.write(
				`Partial capacity evidence could not be recorded: ${boundedFailureReason(writeError)}\n`,
			);
		}
		throw error;
	}
}
