import { describe, expect, it } from 'vitest';

describe('deliberate gate proof', () => {
	it('fails on purpose', () => {
		expect(1).toBe(2);
	});
});
