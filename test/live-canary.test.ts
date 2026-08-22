import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve('.');
const testId = 'YE7VzlLtp-4';
const denoChallengeLine = '[youtube] [jsc:deno] Solving JS challenges using deno';
// yt-dlp logs one of these per script type at debug level once a source wins the
// `python package -> cache -> builtin -> web` race, so the lane sees both `lib` and `core`.
const solverLibLine =
	'[debug] [youtube] [jsc:deno] Using challenge solver lib script v0.8.0 (source: python package, variant: minified)';
const solverCoreLine =
	'[debug] [youtube] [jsc:deno] Using challenge solver core script v0.8.0 (source: python package, variant: minified)';
const solvedLines = [denoChallengeLine, solverLibLine, solverCoreLine];
let fixtureRoot: string;
let candidatePath: string;
let ytDlpPath: string;
let denoPath: string;
let invocationPath: string;
let outputPath: string;
let toolchainLockPath: string;

beforeEach(async () => {
	fixtureRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-live-canary-'));
	candidatePath = join(fixtureRoot, 'release-candidate.json');
	ytDlpPath = join(fixtureRoot, 'yt-dlp');
	denoPath = join(fixtureRoot, 'deno');
	invocationPath = join(fixtureRoot, 'invocation');
	outputPath = join(fixtureRoot, 'live-canary.json');
	toolchainLockPath = join(fixtureRoot, 'TOOLCHAIN.lock.json');
	await writeFile(
		candidatePath,
		`${JSON.stringify({
			schemaVersion: 1,
			version: '0.2.0',
			commit: 'a'.repeat(40),
			packages: [
				{
					name: 'n8n-nodes-yt-dlp-linux-x64',
					sha256: 'b'.repeat(64),
					version: '0.2.0',
				},
			],
			source: {
				bundles: [
					{
						name: 'source.tar.xz',
						sha256: 'd'.repeat(64),
						url: 'https://github.com/example/release/source.tar.xz',
					},
				],
			},
			toolchain: {
				components: ['yt-dlp', 'deno', 'yt-dlp-ejs'],
				lockSha256: 'c'.repeat(64),
			},
		})}\n`,
	);
	await writeFile(denoPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
	const candidateBytes = await readFile(candidatePath);
	await writeFile(
		join(fixtureRoot, 'registry-readback.json'),
		`${JSON.stringify({
			schemaVersion: 1,
			candidateSha256: createHash('sha256').update(candidateBytes).digest('hex'),
			identities: {
				packages: [
					{
						name: 'n8n-nodes-yt-dlp-linux-x64',
						sha256: 'b'.repeat(64),
						version: '0.2.0',
					},
				],
			},
			lane: 'registry-readback',
			outcome: 'pass',
			registry: 'https://registry.npmjs.org',
			waived: false,
		})}\n`,
	);
	await writeFile(
		toolchainLockPath,
		`${JSON.stringify({
			schemaVersion: 1,
			packageVersion: '0.2.0',
			components: [
				{ name: 'yt-dlp', upstream: { tag: '2026.07.14.233956' } },
				{ name: 'ffmpeg', upstream: { tag: 'autobuild-2026-07-12-15-07' } },
				{ name: 'deno', upstream: { tag: 'v2.9.3' } },
				{ name: 'yt-dlp-ejs', upstream: { tag: '0.8.0' } },
			],
		})}\n`,
	);
});

afterEach(async () => {
	await rm(fixtureRoot, { force: true, recursive: true });
});

async function runCanary(environment: Record<string, string> = {}): Promise<void> {
	await execFileAsync(process.execPath, ['scripts/live-canary.mjs', candidatePath, outputPath], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			LIVE_CANARY_DENO_PATH: denoPath,
			LIVE_CANARY_INVOCATION_PATH: invocationPath,
			LIVE_CANARY_TEST_OVERRIDE: '1',
			LIVE_CANARY_TOOLCHAIN_LOCK_PATH: toolchainLockPath,
			LIVE_CANARY_YTDLP_PATH: ytDlpPath,
			RUNNER_REGION: 'test-region',
			...environment,
		},
	});
}

async function writeYtDlpStub(stderrLines: string[], printed = testId): Promise<void> {
	const emitted = stderrLines
		.map((line) => `printf "%s\\n" ${JSON.stringify(line)} >&2\n`)
		.join('');
	await writeFile(
		ytDlpPath,
		`#!/bin/sh\nprintf "%s\\n" "$@" > "$LIVE_CANARY_INVOCATION_PATH"\n${emitted}printf "%s\\n" ${JSON.stringify(printed)}\n`,
		{ mode: 0o700 },
	);
}

describe('live extractor/JSC canary', () => {
	it('passes only after a no-download extraction invokes packaged Deno', async () => {
		await writeYtDlpStub(solvedLines);

		await runCanary();

		const candidateBytes = await readFile(candidatePath);
		const evidence = JSON.parse(await readFile(outputPath, 'utf8')) as {
			candidateSha256: string;
			diagnostics: string[];
			identities: {
				registry: { distTag: string; url: string };
				source: { bundles: Array<{ sha256: string }> };
				test: { id: string; upstreamCommit: string };
				toolchain: { versions: Record<string, string> };
			};
			lane: string;
			outcome: string;
			region: string;
			waived: boolean;
		};
		expect(evidence).toMatchObject({
			candidateSha256: createHash('sha256').update(candidateBytes).digest('hex'),
			lane: 'live-canary',
			outcome: 'pass',
			region: 'test-region',
			waived: false,
			identities: {
				registry: {
					distTag: 'next',
					url: 'https://registry.npmjs.org',
				},
				source: {
					bundles: [{ sha256: 'd'.repeat(64) }],
				},
				test: {
					id: 'YE7VzlLtp-4',
					upstreamCommit: 'aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8',
				},
				toolchain: {
					versions: {
						deno: 'v2.9.3',
						ffmpeg: 'autobuild-2026-07-12-15-07',
						'yt-dlp': '2026.07.14.233956',
						'yt-dlp-ejs': '0.8.0',
					},
				},
			},
		});
		expect(evidence.diagnostics).toEqual([
			'yt-dlp-exit=0',
			'extracted-id=YE7VzlLtp-4',
			'deno-challenge=observed',
			'solver-source=python package',
			'solver-version=0.8.0',
			'solver-scripts=lib+core',
			'solver-fallback=not-observed',
		]);
		const invocation = (await readFile(invocationPath, 'utf8')).split('\n');
		expect(invocation).toContain('--skip-download');
		expect(invocation).toContain('--no-remote-components');
		expect(invocation).toContain('youtube:player_client=mweb');
		expect(invocation).toContain(`deno:${denoPath}`);
		// The lane's own observation of the solver source; ADR 0031 keeps it out of production argv.
		expect(invocation).toContain('--verbose');
	});

	it('fails when no challenge solver source line is observed at all', async () => {
		await writeYtDlpStub([denoChallengeLine]);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'fail',
			diagnostics: expect.arrayContaining(['solver-source=unavailable']),
			waived: false,
		});
	});

	// The three sources yt-dlp would fall through to: its own cache, the vendored builtin, and a
	// GitHub release download. None of them is the frozen copy inside the packaged executable.
	it.each(['cache', 'builtin', 'web'])(
		'fails when the solver is selected from %s rather than the python package',
		async (source) => {
			await writeYtDlpStub([
				denoChallengeLine,
				`[debug] [youtube] [jsc:deno] Using challenge solver lib script v0.8.0 (source: ${source}, variant: minified)`,
				`[debug] [youtube] [jsc:deno] Using challenge solver core script v0.8.0 (source: ${source}, variant: minified)`,
			]);

			await expect(runCanary()).rejects.toMatchObject({ code: 1 });
			await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
				lane: 'live-canary',
				outcome: 'fail',
				diagnostics: expect.arrayContaining([`solver-source=${source}`]),
				waived: false,
			});
		},
	);

	it('fails when the solver version does not match the Toolchain Lock yt-dlp-ejs tag', async () => {
		await writeYtDlpStub([
			denoChallengeLine,
			'[debug] [youtube] [jsc:deno] Using challenge solver lib script v0.7.9 (source: python package, variant: minified)',
			'[debug] [youtube] [jsc:deno] Using challenge solver core script v0.7.9 (source: python package, variant: minified)',
		]);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'fail',
			diagnostics: expect.arrayContaining(['solver-version=0.7.9']),
			waived: false,
		});
	});

	it.each([
		'WARNING: [youtube] [jsc:deno] Remote component challenge solver script (deno) was skipped. It may be required to solve JS challenges. You can enable the download with --remote-components ejs:github  (recommended). For more information and alternatives, refer to  https://github.com/yt-dlp/yt-dlp/wiki/EJS',
		'WARNING: [youtube] [jsc:deno] Remote components NPM package (deno) and challenge solver script (deno) were skipped. These may be required to solve JS challenges.',
		'ERROR: [youtube] [jsc:deno] No usable challenge solver lib script available',
	])('fails when yt-dlp reports a solver fallback: %s', async (line) => {
		await writeYtDlpStub([...solvedLines, line]);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'fail',
			diagnostics: expect.arrayContaining(['solver-fallback=observed']),
			waived: false,
		});
	});

	// The diagnostics carry which scripts were seen, so an operator can tell this release-blocking
	// failure apart from an unexplained one: source, version, and fallback all read healthy here.
	it('fails when only one of the two solver scripts is resolved', async () => {
		await writeYtDlpStub([denoChallengeLine, solverLibLine]);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'fail',
			diagnostics: expect.arrayContaining([
				'solver-source=python package',
				'solver-version=0.8.0',
				'solver-scripts=lib',
				'solver-fallback=not-observed',
			]),
			waived: false,
		});
	});

	it('reports no observed scripts when no solver source line is seen', async () => {
		await writeYtDlpStub([denoChallengeLine]);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'fail',
			diagnostics: expect.arrayContaining(['solver-scripts=unavailable']),
			waived: false,
		});
	});

	it('tolerates an added field after the solver variant', async () => {
		await writeYtDlpStub([
			denoChallengeLine,
			'[debug] [youtube] [jsc:deno] Using challenge solver lib script v0.8.0 (source: python package, variant: minified, cached: True)',
			'[debug] [youtube] [jsc:deno] Using challenge solver core script v0.8.0 (source: python package, variant: minified, cached: True)',
		]);

		await runCanary();

		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'pass',
			diagnostics: expect.arrayContaining(['solver-source=python package']),
		});
	});

	// A wrong solver source reproduces on every re-run, so it must outrank the transient reading
	// even when the same stderr carries the retry noise a live run routinely produces.
	it('fails rather than retries when a wrong solver source lands beside transient network noise', async () => {
		await writeYtDlpStub([
			denoChallengeLine,
			'WARNING: [youtube] Unable to download webpage: <urlopen error [Errno 104] Connection reset by peer>. Retrying (1/1)...',
			'[debug] [youtube] [jsc:deno] Using challenge solver lib script v0.8.0 (source: builtin, variant: unminified)',
			'[debug] [youtube] [jsc:deno] Using challenge solver core script v0.8.0 (source: builtin, variant: unminified)',
		]);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'fail',
			diagnostics: expect.arrayContaining(['solver-source=builtin']),
			waived: false,
		});
	});

	// The mirror of the case above: a run that never got far enough to log a solver line is missing
	// evidence, not contradicting it, so the transient reading still wins and the lane stays retryable.
	it('stays inconclusive when the network cuts the run before any solver line', async () => {
		await writeFile(
			ytDlpPath,
			'#!/bin/sh\nprintf "%s\\n" "ERROR: Unable to connect: [Errno 111] Connection refused" >&2\nexit 1\n',
			{ mode: 0o700 },
		);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'inconclusive',
			diagnostics: expect.arrayContaining(['solver-source=unavailable']),
			waived: false,
		});
	});

	it('reads the expected solver version from the Toolchain Lock rather than a fixed string', async () => {
		const lock = JSON.parse(await readFile(toolchainLockPath, 'utf8')) as {
			components: Array<{ name: string; upstream: { tag: string } }>;
		};
		const ejs = lock.components.find(({ name }) => name === 'yt-dlp-ejs');
		if (!ejs) throw new Error('The fixture Toolchain Lock has no yt-dlp-ejs component.');
		ejs.upstream.tag = '0.9.1';
		await writeFile(toolchainLockPath, `${JSON.stringify(lock)}\n`);
		await writeYtDlpStub([
			denoChallengeLine,
			'[debug] [youtube] [jsc:deno] Using challenge solver lib script v0.9.1 (source: python package, variant: minified)',
			'[debug] [youtube] [jsc:deno] Using challenge solver core script v0.9.1 (source: python package, variant: minified)',
		]);

		await runCanary();

		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'pass',
			diagnostics: expect.arrayContaining(['solver-version=0.9.1']),
			identities: { toolchain: { versions: { 'yt-dlp-ejs': '0.9.1' } } },
		});
	});

	it('records a network-limited result as blocking inconclusive evidence', async () => {
		await writeFile(
			ytDlpPath,
			'#!/bin/sh\nprintf "%s\\n" "ERROR: HTTP Error 429: Too Many Requests" >&2\nexit 1\n',
			{ mode: 0o700 },
		);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'inconclusive',
			waived: false,
		});
	});

	it.each([
		'ERROR: Unable to connect: [Errno 111] Connection refused',
		'ERROR: HTTP Error 503: Service Unavailable',
		'ERROR: TLS handshake failure',
		'ERROR: Remote end closed connection without response',
	])('records transient network failure as blocking inconclusive evidence: %s', async (message) => {
		await writeFile(
			ytDlpPath,
			`#!/bin/sh\nprintf "%s\\n" ${JSON.stringify(message)} >&2\nexit 1\n`,
			{ mode: 0o700 },
		);

		await expect(runCanary()).rejects.toMatchObject({ code: 1 });
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'inconclusive',
			waived: false,
		});
	});

	it('records a silent network timeout as blocking inconclusive evidence', async () => {
		await writeFile(ytDlpPath, '#!/bin/sh\nsleep 1\n', { mode: 0o700 });

		await expect(runCanary({ LIVE_CANARY_TIMEOUT_MS: '25' })).rejects.toMatchObject({
			code: 1,
		});
		await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
			lane: 'live-canary',
			outcome: 'inconclusive',
			waived: false,
		});
	});

	it('rejects a canary that is not bound to the public registry read-back', async () => {
		const registryEvidencePath = join(fixtureRoot, 'registry-readback.json');
		const registryEvidence = JSON.parse(await readFile(registryEvidencePath, 'utf8')) as {
			candidateSha256: string;
		};
		registryEvidence.candidateSha256 = '0'.repeat(64);
		await writeFile(registryEvidencePath, `${JSON.stringify(registryEvidence)}\n`);
		await writeFile(
			ytDlpPath,
			'#!/bin/sh\nprintf "%s\\n" invoked > "$LIVE_CANARY_INVOCATION_PATH"\n',
			{ mode: 0o700 },
		);

		await expect(runCanary()).rejects.toMatchObject({
			stderr: expect.stringContaining(
				'The live canary requires candidate-bound public registry evidence.',
			),
		});
		await expect(readFile(invocationPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
