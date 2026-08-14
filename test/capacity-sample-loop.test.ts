import { afterEach, describe, expect, it } from 'vitest';

import { collectUntilComplete } from '../e2e/n8n-2.27.4/sample-loop.mjs';

const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
process.on('unhandledRejection', recordUnhandledRejection);

afterEach(() => {
	unhandledRejections.length = 0;
});

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settled(): Promise<void> {
	await wait(50);
}

describe('capacity lane sampling loop', () => {
	it('samples while the operation runs and takes a final sample after it completes', async () => {
		const samples: number[] = [];
		let taken = 0;

		const result = await collectUntilComplete(async () => {
			await wait(60);
			return 'done';
		}, [{ collection: samples, intervalMs: 10, snapshot: async () => (taken += 1) }]);

		expect(result).toBe('done');
		expect(samples.length).toBeGreaterThan(1);
		expect(samples[samples.length - 1]).toBe(taken);
	});

	it('runs every observer at its own interval', async () => {
		const slow: number[] = [];
		const fast: number[] = [];

		await collectUntilComplete(async () => await wait(120), [
			{ collection: slow, intervalMs: 50, snapshot: async () => 1 },
			{ collection: fast, intervalMs: 5, snapshot: async () => 1 },
		]);

		expect(fast.length).toBeGreaterThan(slow.length);
	});

	it('ends the run with the observer failure instead of waiting for the operation', async () => {
		const start = Date.now();

		await expect(
			collectUntilComplete(async () => await wait(5_000), [
				{
					collection: [],
					intervalMs: 5,
					snapshot: async () => {
						throw new Error('Worker metrics failed 6 consecutive readings (limit 5): status 500');
					},
				},
			]),
		).rejects.toThrow('Worker metrics failed 6 consecutive readings');

		expect(Date.now() - start).toBeLessThan(1_000);
	});

	it('leaves no unhandled rejection behind when an observer fails', async () => {
		await expect(
			collectUntilComplete(async () => await wait(100), [
				{
					collection: [],
					intervalMs: 5,
					snapshot: async () => {
						throw new Error('observer failed');
					},
				},
			]),
		).rejects.toThrow('observer failed');
		await settled();

		expect(unhandledRejections).toEqual([]);
	});

	it('stops the other observers once one of them fails', async () => {
		const surviving: number[] = [];

		await expect(
			collectUntilComplete(async () => await wait(1_000), [
				{
					collection: [],
					intervalMs: 5,
					snapshot: async () => {
						throw new Error('observer failed');
					},
				},
				{ collection: surviving, intervalMs: 5, snapshot: async () => 1 },
			]),
		).rejects.toThrow('observer failed');
		const stopped = surviving.length;
		await settled();

		expect(surviving).toHaveLength(stopped);
	});

	it('propagates an operation failure and leaves no unhandled rejection behind', async () => {
		const samples: number[] = [];

		await expect(
			collectUntilComplete(
				async () => {
					await wait(20);
					throw new Error('load failed');
				},
				[{ collection: samples, intervalMs: 5, snapshot: async () => 1 }],
			),
		).rejects.toThrow('load failed');
		const stopped = samples.length;
		await settled();

		expect(samples).toHaveLength(stopped);
		expect(unhandledRejections).toEqual([]);
	});

	it('leaves no unhandled rejection behind on a clean run', async () => {
		await collectUntilComplete(async () => await wait(20), [
			{ collection: [], intervalMs: 5, snapshot: async () => 1 },
		]);
		await settled();

		expect(unhandledRejections).toEqual([]);
	});
});
