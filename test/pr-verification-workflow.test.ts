import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflowPath = '.github/workflows/pr-verification.yml';

describe('pull request verification gate', () => {
	it('runs typecheck, lint, and test on every pull request', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).toMatch(/\non:\n {2}pull_request:\n/u);
		expect(workflow).toContain('npm run typecheck');
		expect(workflow).toContain('npm run lint');
		expect(workflow).toContain('npm test');
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
		expect(workflow).not.toContain('secrets.');
		expect(workflow).not.toContain('environment:');
		expect(workflow).not.toContain('id-token:');
	});

	it('leaves the heavy release lanes to the release gates', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).not.toContain('test:e2e:');
		expect(workflow).not.toContain('release:');
		// A tight budget would make the gate flaky: the suite alone runs for minutes.
		expect(workflow).toContain('timeout-minutes: 30');
	});
});
