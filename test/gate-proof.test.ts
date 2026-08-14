import { describe, expect, it } from 'vitest';

const unusedOnPurpose = 'this commit exists to prove the PR gate blocks red';

describe('deliberate gate proof', () => {
	it('fails on purpose', () => {
		expect(1).toBe(2);
	});
});
