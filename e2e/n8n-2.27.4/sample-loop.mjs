/**
 * Runs `operation` while every observer samples into its own collection, and
 * returns the operation's result once a final sample has been taken.
 *
 * The observers run detached from the operation they measure, so a failed
 * observer latches its error and stops the others instead of rejecting on its
 * own: an unhandled rejection would abort the process before the caller could
 * remove the disposable stack. The latched failure ends the run as soon as the
 * observers have stopped, so a broken observer does not measure nothing until
 * a load that runs for tens of minutes finishes.
 */
export async function collectUntilComplete(operation, observers) {
	let complete = false;
	let observerError;
	const observe = async ({ collection, intervalMs, snapshot }) => {
		while (!complete) {
			collection.push(await snapshot());
			await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
		}
		collection.push(await snapshot());
	};
	const observed = Promise.all(
		observers.map(async (observer) => {
			try {
				await observe(observer);
			} catch (error) {
				observerError ??= error;
				complete = true;
			}
		}),
	);
	const observerFailure = observed.then(async () => {
		if (observerError === undefined) await new Promise(() => {});
		throw observerError;
	});
	try {
		const result = await Promise.race([operation(), observerFailure]);
		complete = true;
		await observed;
		if (observerError !== undefined) throw observerError;
		return result;
	} catch (error) {
		complete = true;
		await observed;
		throw error;
	}
}
