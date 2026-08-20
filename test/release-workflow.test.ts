import { existsSync } from 'node:fs';
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

		// A maintainer approves each staged package separately with 2FA, so a chain can still go
		// public in part when a later approval or stage publish fails. The audit names exactly which
		// of the three that left visible.
		expect(job(workflow, 'partial-publish-audit')).toContain('audit-registry');
		expect(job(workflow, 'partial-publish-audit')).toContain(
			"needs.publish-next.result != 'skipped'",
		);
		expect(job(workflow, 'partial-publish-audit')).toContain(
			"inputs.publish_mode == 'stage'",
		);
		const promote = job(workflow, 'promote-latest');
		expect(promote).toContain('verify-promotion');
		expect(promote).toContain('npm ci');
		expect(promote).toContain('name: gate-promote-latest');
		expect(promote).not.toContain('npm dist-tag add');
		expect(workflow).not.toMatch(/\bnpm unpublish\b/u);
	});

	// Evidence for a version is published once. A second `verify-existing` run over the same public
	// bytes — the shape a promotion read-back takes — must leave the first run's asset alone without
	// failing the job, or `promote-latest` is skipped for a reason that has nothing to do with the
	// release.
	it('publishes the evidence asset once without failing a repeat run', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		const evidence = job(workflow, 'release-evidence');
		expect(evidence).toContain('gh release upload');
		expect(evidence).not.toContain('--clobber');
		expect(evidence).toContain('is already published');
	});

	// The long-lived granular token published 0.2.0 only because package names that do not exist yet
	// cannot configure a Trusted Publisher. All three names are configured now, so that exception is
	// retired: the sole publication this workflow can perform is `npm stage publish` under OIDC, and
	// staged bytes become public only after a maintainer reviews each tarball and approves it with
	// npm 2FA.
	it('publishes only through the stage-only Trusted Publisher path', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		expect(workflow).not.toMatch(/bootstrap/iu);
		const publish = job(workflow, 'publish-next');
		expect(publish).toContain('environment: npm-release');
		expect(publish).toContain('npm stage publish');
		// No npm credential of any kind reaches the step; the empty `NODE_AUTH_TOKEN` exists so an
		// absent OIDC token fails as `ENEEDAUTH` rather than as an unreplaced npmrc placeholder.
		expect(publish).not.toMatch(/secrets\./u);
		expect(publish).toContain("NODE_AUTH_TOKEN: ''");
		expect(publish).not.toMatch(/(?<!stage )npm publish/u);
		for (const mode of ['stage', 'verify-existing']) {
			expect(workflow, mode).toContain(`- ${mode}\n`);
		}
	});

	// The recovery workflow existed for one recorded partial `0.2.0` publication, which it completed.
	// It is the last holder of the granular token and of the `npm-bootstrap` Environment, so leaving
	// it dispatchable would keep a long-lived-token publish path alive after the token is retired.
	it('retires the token-publish surface with the environment that held it', async () => {
		for (const path of [
			'.github/workflows/recover-bootstrap.yml',
			'scripts/bootstrap-recovery.mjs',
			'scripts/bootstrap-recovery.d.mts',
		]) {
			expect(existsSync(path), path).toBe(false);
		}
		const script = await readFile('scripts/release-candidate.mjs', 'utf8');
		expect(script).not.toContain('verify-bootstrap-retirement');
		expect(script).not.toContain('verify-bootstrap-registry');
	});

	it('runs every published-byte gate only under verify-existing', async () => {
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
		// A run that verifies an interactively promoted candidate must read back the tag state that
		// promotion produced, not the staged one it replaced. The dispatched boolean can arrive as a
		// boolean or as its string form, and the two contexts disagree about the string `false`, so
		// both forms are compared explicitly wherever the input decides something.
		for (const guarded of [readback, job(workflow, 'promote-latest')]) {
			expect(guarded).toContain("inputs.promote_latest == true");
			expect(guarded).toContain("inputs.promote_latest == 'true'");
			expect(guarded).not.toMatch(/inputs\.promote_latest\s*&&/u);
		}
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

	// The n8n lanes build their media fixtures with the packaged FFmpeg from the checkout, not from
	// the candidate artifact, so an unhydrated checkout hands them an LFS pointer to execute and the
	// lane dies on `line 1: version: command not found`.
	it('hydrates packaged toolchain binaries before the n8n lanes run', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		for (const status of ['three-anchor', 'multiworker', 'capacity']) {
			expect(job(workflow, status), `${status} LFS checkout`).toContain('lfs: true');
			// The checkout will not rewrite paths it considers unchanged, so a runner whose
			// workspace persists keeps the pointer files an earlier checkout left behind.
			expect(job(workflow, status), `${status} LFS hydration`).toContain('git lfs pull');
		}
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

	// The regional runner keeps its own ~/.npm between jobs, so the action cache buys nothing there
	// and its post step uploads gigabytes over a home connection instead — slowly enough to hold the
	// single runner and stall every lane queued behind it.
	it('does not upload an npm cache from the regional runner', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		for (const status of ['three-anchor', 'multiworker', 'capacity', 'live-canary']) {
			expect(job(workflow, status), `${status} npm cache`).not.toContain('cache: npm');
		}
	});

	// A hosted runner's address range is refused by YouTube before the extractor is reached, so the
	// lane would record a toolchain failure for bytes that work. It runs from the configured region
	// instead, which is what its recorded `RUNNER_REGION` claims.
	it('runs the live canary from the configured region', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		expect(job(workflow, 'live-canary')).toContain(
			'runs-on: [self-hosted, linux, x64, release-e2e]',
		);
	});

	// The gate runs no test, so a self-hosted runner buys no verification. It would instead write the
	// evidence secret into a persistent workspace, and on the acceptance host it would put arbitrary
	// merged workflow code beside production n8n. The candidate binding lives in the evidence.
	it('validates acceptance-stack evidence on a hosted runner', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		const acceptanceStack = job(workflow, 'acceptance-stack');
		expect(acceptanceStack).toContain('runs-on: ubuntu-24.04');
		expect(acceptanceStack).not.toMatch(/runs-on:.*self-hosted/u);
		expect(acceptanceStack).toContain('environment: acceptance-stack');
	});

	it('retains bounded live-canary evidence when the canary blocks release', async () => {
		const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
		expect(job(workflow, 'live-canary')).toMatch(
			/- uses: actions\/upload-artifact@v7\n\s+if: always\(\)\n\s+with:\n\s+name: gate-live-canary/u,
		);
	});

	it('publishes a release record with the matrix, the unverified facts, and operator duties', async () => {
		const record = await readFile('docs/release-record-0.2.1.md', 'utf8');
		for (const required of [
			'## Supported matrix',
			'## Known unverified facts',
			'## Operator responsibilities',
			'Linux only',
			'x64 only',
			'2.34.6',
			'036a5ae8d9fed314cc1ef465cc3e86ce52eb2562e468974528cd96792573eb47',
			'not a supported-site\n  guarantee',
			'npm 2FA',
			'Never run `npm unpublish`',
		]) {
			expect(record, required).toContain(required);
		}
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
			'stage-only',
			'`npm-release`',
			'Trusted Publisher',
			'Platform Package, Platform Selector, then the main package last',
			'Rollback rehearsal',
			'npm 2FA',
		]) {
			expect(documentation).toContain(required);
		}
	});
});
