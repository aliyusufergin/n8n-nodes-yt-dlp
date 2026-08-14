import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflowPath = '.github/workflows/pr-verification.yml';

describe('pull request verification gate', () => {
	it('runs typecheck, lint, and test on every pull request', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).toMatch(/\non:\n {2}pull_request:\n/u);
		expect(workflow).toContain('run: npm run typecheck\n');
		expect(workflow).toContain('run: npm run lint\n');
		expect(workflow).toContain('run: npm test\n');
		expect(workflow).not.toContain('continue-on-error:');
	});

	it('installs pinned, reproducible dependencies before verifying', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).toContain('NODE_VERSION: 24.16.0');
		expect(workflow).toContain('node-version: ${{ env.NODE_VERSION }}');
		expect(workflow).toContain('runs-on: ubuntu-24.04');
		expect(workflow).toContain('- run: npm ci');
		expect(workflow).not.toMatch(/\bnpm install\b/u);
		// The suite packs and inspects the real toolchain binaries, which are LFS objects.
		expect(workflow).toContain('lfs: true');
	});

	it('cannot reach publication secrets or environments', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).toContain('permissions:\n  contents: read\n');
		expect(workflow).not.toMatch(/^\s*environment:/mu);
		expect(workflow).not.toMatch(/^\s*id-token:/mu);
		expect(workflow).not.toContain('secrets.');
	});

	it('leaves the heavy release lanes to the release gates', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).not.toMatch(/\bnpm run test:e2e:/u);
		expect(workflow).not.toMatch(/\bnpm run release:/u);
		// A tight budget would make the gate flaky: the suite alone runs for minutes.
		expect(workflow).toContain('timeout-minutes: 30');
	});

	it('documents the contract, the protection it backs, and the recorded refusal', async () => {
		const documentation = await readFile('docs/ci.md', 'utf8');
		for (const required of [
			'ADR 0035',
			'permissions` is `contents: read` only',
			'`strict: false`',
			'`enforce_admins: false`',
			'refused, HTTP 405',
			'closed unmerged',
			'Do not attempt the merge with `enforce_admins` off',
		]) {
			expect(documentation).toContain(required);
		}
		const decision = await readFile('docs/adr/0035-pull-request-verification-gate.md', 'utf8');
		expect(decision).toContain('status: accepted');
		expect(decision).toContain('ADR 0025, 0030 ve 0032');
	});
});
