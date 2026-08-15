import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

function job(workflow: string, name: string): string {
	const start = workflow.indexOf(`\n  ${name}:\n`);
	if (start === -1) return '';
	const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]+:\n/u);
	return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe('release workflow', () => {
	it('models every independent blocking status without waivers', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		for (const status of [
			'candidate',
			'source-delivery',
			'hermetic',
			'three-anchor',
			'multiworker',
			'capacity',
			'official-ejs',
			'live-canary',
			'publish-next',
			'registry-readback',
			'partial-publish-audit',
			'bootstrap-token-retirement',
			'acceptance-stack',
			'release-evidence',
			'promote-latest',
		]) {
			expect(job(workflow, status), `missing ${status} status`).not.toBe('');
		}
		expect(workflow).not.toContain('continue-on-error:');
		expect(workflow).toContain('NODE_VERSION: 24.16.0');
		expect(job(workflow, 'candidate')).toContain('actions/attest-build-provenance@v4');
		for (const status of ['candidate', 'source-delivery', 'prepublication']) {
			expect(job(workflow, status), `${status} LFS checkout`).toContain('lfs: true');
		}
		expect(job(workflow, 'three-anchor')).toContain('test:e2e:release-gate');
		expect(job(workflow, 'multiworker')).toContain('test:e2e:multiworker');
		expect(job(workflow, 'capacity')).toContain('test:e2e:capacity');
		expect(job(workflow, 'official-ejs')).toContain('solves official frozen EJS');
		expect(job(workflow, 'live-canary')).toContain('release:live-canary');
		expect(job(workflow, 'acceptance-stack')).toContain('environment: acceptance-stack');
		for (const status of [
			'hermetic',
			'three-anchor',
			'multiworker',
			'capacity',
			'official-ejs',
			'live-canary',
		]) {
			expect(job(workflow, status)).toContain('registry-readback');
		}
		expect(job(workflow, 'hermetic')).toContain(
			'node scripts/release-candidate.mjs verify .release-candidate',
		);
		expect(job(workflow, 'hermetic')).toContain('E2E_RELEASE_CANDIDATE_ROOT');
		expect(job(workflow, 'hermetic')).toContain('--network none');
		expect(job(workflow, 'hermetic')).toContain('hermetic-identities.json');
		for (const status of ['three-anchor', 'multiworker', 'capacity']) {
			expect(job(workflow, status)).toContain('E2E_REQUIRE_PUBLISHED_NEXT:');
		}
		expect(job(workflow, 'official-ejs')).toContain('E2E_RELEASE_CANDIDATE_ROOT');
	});

	it('cannot publish the platform package before source review and publishes in dependency order', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		const publish = job(workflow, 'publish-next');
		expect(publish).toContain('source-delivery');
		const platform = publish.indexOf('n8n-nodes-yt-dlp-linux-x64-');
		const selector = publish.indexOf('n8n-nodes-yt-dlp-platform-');
		const main = publish.indexOf('n8n-nodes-yt-dlp-${VERSION}.tgz');
		expect(platform).toBeGreaterThan(-1);
		expect(selector).toBeGreaterThan(platform);
		expect(main).toBeGreaterThan(selector);

		expect(job(workflow, 'bootstrap-token-retirement')).toContain(
			'BOOTSTRAP_RETIREMENT_EVIDENCE_JSON',
		);
		expect(job(workflow, 'partial-publish-audit')).toContain('audit-registry');
		expect(job(workflow, 'partial-publish-audit')).toContain(
			"needs.publish-next.result != 'skipped'",
		);
		expect(job(workflow, 'bootstrap-token-retirement')).toContain('always()');
		expect(job(workflow, 'bootstrap-token-retirement')).toContain('partial-publish-audit');
		const promote = job(workflow, 'promote-latest');
		expect(promote).toContain('verify-promotion');
		expect(promote).not.toContain('NPM_BOOTSTRAP_TOKEN');
		expect(promote).not.toContain('npm dist-tag add');
		expect(workflow).not.toMatch(/\bnpm unpublish\b/u);
	});

	it('stops bootstrap after registry read-back and credential retirement', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		for (const status of [
			'hermetic',
			'three-anchor',
			'multiworker',
			'capacity',
			'official-ejs',
			'live-canary',
			'acceptance-stack',
			'release-evidence',
			'promote-latest',
		]) {
			expect(job(workflow, status), status).toContain(
				"inputs.publish_mode == 'verify-existing'",
			);
		}
	});

	it('runs post-publication gates from the exact public next tarballs', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		const candidate = job(workflow, 'candidate');
		expect(candidate).toContain('PUBLISHED_CANDIDATE_RUN_ID');
		expect(candidate).toContain('PUBLISHED_CANDIDATE_SHA256');
		expect(candidate).toContain('run-id: ${{ env.PUBLISHED_CANDIDATE_RUN_ID }}');
		expect(candidate).toContain('github-token: ${{ github.token }}');

		const readback = job(workflow, 'registry-readback');
		expect(readback).toContain('materialize-registry');
		// npm's automatic first-publish `latest` is readable back only for the bootstrap; a later
		// release leaves `latest` on the previous version and must not be allowed to claim it.
		expect(readback).toContain(
			"${{ inputs.publish_mode == 'bootstrap' && '--bootstrap-latest' || '' }}",
		);
		expect(readback).toContain('name: published-candidate-0.2.1');

		for (const jobName of [
			'hermetic',
			'three-anchor',
			'multiworker',
			'capacity',
			'official-ejs',
			'live-canary',
			'acceptance-stack',
			'release-evidence',
			'promote-latest',
		]) {
			expect(job(workflow, jobName), jobName).toContain('name: published-candidate-0.2.1');
		}
	});

	it('keeps release workflow execution on internal-only container networks', async () => {
		const compose = await readFile('e2e/n8n-2.27.4/compose.yaml', 'utf8');
		expect(compose).toContain(
			'networks:\n  e2e:\n    internal: true\n  control:\n    internal: true',
		);
	});

	it('hydrates packaged toolchain binaries before the hermetic suite runs', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		expect(job(workflow, 'hermetic')).toContain('lfs: true');
	});

	// The hermetic container denies egress, drops every capability, keeps its own root read-only, and
	// runs as the runner's own uid. That uid has no entry in the image's passwd database, so
	// `os.userInfo()` fails and the release build cannot start; and without a reaping init the
	// process-group timeout test sees killed descendants linger as unreaped zombies and reports the
	// group as surviving SIGKILL. Both are properties of the container, not of the candidate, so the
	// isolation flags below are part of the gate's contract.
	it('gives the hermetic container a reaping init, a passwd entry, and a writable home', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		const hermetic = job(workflow, 'hermetic');
		expect(hermetic).toContain('--init');
		expect(hermetic).toContain('target=/etc/passwd,readonly');
		expect(hermetic).toContain('--env HOME=/tmp');
		// The read-only root leaves /tmp as the container's scratch space, and a measured run peaks
		// at 2.43 GiB in it.
		expect(hermetic).toContain('--tmpfs /tmp:rw,nosuid,nodev,exec,size=6g');
	});

	it('retains bounded live-canary evidence when the canary blocks release', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		expect(job(workflow, 'live-canary')).toMatch(
			/- uses: actions\/upload-artifact@v7\n\s+if: always\(\)\n\s+with:\n\s+name: gate-live-canary/u,
		);
	});

	it('recovers only the missing main package from the original signed candidate', async () => {
		const workflow = await readFile('.github/workflows/recover-bootstrap.yml', 'utf8');
		expect(workflow).toContain('environment: npm-bootstrap');
		expect(workflow).toContain('run-id: ${{ env.ORIGINAL_RUN_ID }}');
		expect(workflow).toContain('github-token: ${{ github.token }}');
		expect(workflow).toContain('bootstrap-recovery.mjs prepare');
		expect(workflow).toContain('npm run verify:ffmpeg-release');
		expect(workflow).toContain('RUNNER_REGION: ${{ vars.RUNNER_REGION }}');
		expect(workflow).toContain('bootstrap-recovery-state.json');
		expect(workflow).toContain('n8n-nodes-yt-dlp-${VERSION}.tgz');
		expect(workflow).toContain('--provenance-file');
		expect(workflow).toContain('verify-bootstrap-registry');
		expect(workflow).toContain('partial-publish-audit');
		expect(workflow).toContain('audit-registry');
		expect(workflow).toContain('BOOTSTRAP_RETIREMENT_EVIDENCE_JSON');
		expect(workflow).toContain('environment: npm-bootstrap-retirement');
		expect(workflow).not.toContain('n8n-nodes-yt-dlp-linux-x64-${VERSION}.tgz');
		expect(workflow).not.toContain('n8n-nodes-yt-dlp-platform-${VERSION}.tgz');
		expect(workflow).not.toContain('npm dist-tag');
		expect(workflow).not.toMatch(/\bnpm unpublish\b/u);
	});

	it('documents staged continuation, evidence, and non-unpublish rollback', async () => {
		const documentation = await readFile('docs/release.md', 'utf8');
		for (const required of [
			'Release Candidate Chain',
			'verify-existing',
			'published-candidate-0.2.1',
			'both `e2e` and `control`',
			'networks are internal',
			'exact packaged yt-dlp, FFmpeg',
			'Deno, and EJS versions',
			'`inconclusive` is blocking',
			'ACCEPTANCE_STACK_EVIDENCE_JSON',
			'release-evidence-0.2.1.json',
			'main package first',
			'deprecate',
			'new patch',
			'Never use `npm unpublish`',
			'recover-bootstrap.yml',
			'gh workflow run recover-bootstrap.yml --ref bootstrap-recovery-0.2.0-r2',
			'exact recovery tag',
		]) {
			expect(documentation).toContain(required);
		}
	});
});
