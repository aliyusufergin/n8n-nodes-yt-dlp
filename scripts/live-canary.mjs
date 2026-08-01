import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const testId = 'YE7VzlLtp-4';
const testUrl = `https://www.youtube.com/watch?v=${testId}`;
const upstreamCommit = 'aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8';
const outputLimitBytes = 128 * 1024;
const timeoutMs = 120_000;

function fail(message) {
	throw new Error(message);
}

function requiredRegion() {
	const region = process.env.RUNNER_REGION?.trim();
	if (
		region === undefined ||
		region.length === 0 ||
		['n/a', 'unknown', 'unset'].includes(region.toLowerCase())
	) {
		fail('RUNNER_REGION must identify a concrete release-test region.');
	}
	return region;
}

function sha256(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

function canaryTimeoutMs() {
	const override = process.env.LIVE_CANARY_TIMEOUT_MS;
	if (process.env.LIVE_CANARY_TEST_OVERRIDE !== '1' || override === undefined) {
		return timeoutMs;
	}
	if (!/^\d+$/u.test(override) || Number(override) < 1 || Number(override) > timeoutMs) {
		fail('LIVE_CANARY_TIMEOUT_MS must be a bounded positive integer.');
	}
	return Number(override);
}

async function runBounded(command, arguments_, environment, runTimeoutMs = timeoutMs) {
	return await new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, arguments_, {
			cwd: repositoryRoot,
			env: environment,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stdout = [];
		const stderr = [];
		let outputBytes = 0;
		let exceeded = false;
		let timedOut = false;
		const collect = (collection) => (chunk) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > outputLimitBytes) {
				exceeded = true;
				child.kill('SIGKILL');
				return;
			}
			collection.push(chunk);
		};
		child.stdout.on('data', collect(stdout));
		child.stderr.on('data', collect(stderr));
		child.once('error', rejectRun);
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, runTimeoutMs);
		child.once('close', (code, signal) => {
			clearTimeout(timeout);
			resolveRun({
				code,
				exceeded,
				signal,
				stderr: Buffer.concat(stderr).toString('utf8'),
				stdout: Buffer.concat(stdout).toString('utf8'),
				timedOut,
			});
		});
	});
}

async function executablePaths(candidate, candidateRoot) {
	if (process.env.LIVE_CANARY_TEST_OVERRIDE === '1') {
		const ytDlp = process.env.LIVE_CANARY_YTDLP_PATH;
		const deno = process.env.LIVE_CANARY_DENO_PATH;
		const toolchainLock = process.env.LIVE_CANARY_TOOLCHAIN_LOCK_PATH;
		if (!ytDlp || !deno || !toolchainLock) {
			fail('Live canary test override paths are incomplete.');
		}
		return {
			deno: resolve(deno),
			temporaryRoot: undefined,
			toolchainLock: resolve(toolchainLock),
			ytDlp: resolve(ytDlp),
		};
	}

	const verification = await runBounded(
		process.execPath,
		['scripts/release-candidate.mjs', 'verify', candidateRoot],
		{ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: process.env.PATH ?? '/usr/bin:/bin' },
	);
	if (verification.code !== 0) fail('The live canary candidate failed immutable verification.');
	const platform = candidate.packages.find(({ name }) => name === 'n8n-nodes-yt-dlp-linux-x64');
	if (!platform) fail('The live canary candidate has no Platform Package.');
	const temporaryRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-live-canary-'));
	const extraction = await runBounded(
		'tar',
		['-xzf', join(candidateRoot, 'tarballs', platform.tarball), '-C', temporaryRoot],
		{ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: process.env.PATH ?? '/usr/bin:/bin' },
	);
	if (extraction.code !== 0) {
		await rm(temporaryRoot, { force: true, recursive: true });
		fail('The live canary could not extract the Platform Package.');
	}
	return {
		deno: join(temporaryRoot, 'package', 'bin', 'deno'),
		temporaryRoot,
		toolchainLock: join(temporaryRoot, 'package', 'TOOLCHAIN.lock.json'),
		ytDlp: join(temporaryRoot, 'package', 'bin', 'yt-dlp'),
	};
}

function packageIdentities(candidate) {
	return candidate.packages.map(({ name, sha256: packageSha256, version }) => ({
		name,
		sha256: packageSha256,
		version,
	}));
}

async function publicRegistryIdentity(candidate, candidateBytes, candidateRoot) {
	const evidence = JSON.parse(
		await readFile(join(candidateRoot, 'registry-readback.json'), 'utf8'),
	);
	if (
		evidence.schemaVersion !== 1 ||
		evidence.candidateSha256 !== sha256(candidateBytes) ||
		evidence.lane !== 'registry-readback' ||
		evidence.outcome !== 'pass' ||
		evidence.waived !== false ||
		evidence.registry !== 'https://registry.npmjs.org' ||
		JSON.stringify(evidence.identities?.packages) !== JSON.stringify(packageIdentities(candidate))
	) {
		fail('The live canary requires candidate-bound public registry evidence.');
	}
	return { distTag: 'next', url: evidence.registry };
}

async function toolVersions(toolchainLockPath, version) {
	const lock = JSON.parse(await readFile(toolchainLockPath, 'utf8'));
	if (
		lock.schemaVersion !== 1 ||
		lock.packageVersion !== version ||
		!Array.isArray(lock.components)
	) {
		fail('The live canary Toolchain Lock is invalid.');
	}
	const versions = {};
	for (const name of ['yt-dlp', 'ffmpeg', 'deno', 'yt-dlp-ejs']) {
		const tag = lock.components.find((component) => component.name === name)?.upstream?.tag;
		if (typeof tag !== 'string' || tag.length === 0) {
			fail(`The live canary Toolchain Lock has no exact ${name} version.`);
		}
		versions[name] = tag;
	}
	return versions;
}

function classifyOutcome(result) {
	const denoChallenge = result.stderr.includes(
		'[youtube] [jsc:deno] Solving JS challenges using deno',
	);
	const extractedId = result.stdout.trim() === testId;
	if (
		result.code === 0 &&
		result.signal === null &&
		!result.exceeded &&
		denoChallenge &&
		extractedId
	) {
		return { denoChallenge, extractedId, outcome: 'pass' };
	}
	if (
		result.timedOut ||
		/(?:HTTP Error (?:429|5\d{2})|Too Many Requests|timed out|Temporary failure|Name or service not known|Network is unreachable|Connection (?:reset|refused|aborted)|Unable to connect|(?:TLS|SSL)[^\r\n]{0,80}(?:handshake|certificate|failure|error|EOF)|Remote (?:end )?closed|(?:remote|unexpected) EOF)/iu.test(
			result.stderr,
		)
	) {
		return { denoChallenge, extractedId, outcome: 'inconclusive' };
	}
	return { denoChallenge, extractedId, outcome: 'fail' };
}

const [candidateArgument, outputArgument] = process.argv.slice(2);
if (!candidateArgument || !outputArgument || process.argv.length !== 4) {
	fail('Usage: live-canary.mjs <release-candidate.json> <evidence.json>');
}
const candidatePath = resolve(candidateArgument);
const candidateRoot = dirname(candidatePath);
const candidateBytes = await readFile(candidatePath);
const candidate = JSON.parse(candidateBytes);
const registry = await publicRegistryIdentity(candidate, candidateBytes, candidateRoot);
const paths = await executablePaths(candidate, candidateRoot);
try {
	const versions = await toolVersions(paths.toolchainLock, candidate.version);
	const environment = {
		DENO_NO_UPDATE_CHECK: '1',
		LANG: 'C.UTF-8',
		LC_ALL: 'C.UTF-8',
		NO_COLOR: '1',
		PATH: '/usr/bin:/bin',
		...(process.env.LIVE_CANARY_TEST_OVERRIDE === '1' && process.env.LIVE_CANARY_INVOCATION_PATH
			? { LIVE_CANARY_INVOCATION_PATH: process.env.LIVE_CANARY_INVOCATION_PATH }
			: {}),
	};
	const result = await runBounded(
		paths.ytDlp,
		[
			'--ignore-config',
			'--no-update',
			'--no-plugin-dirs',
			'--no-js-runtimes',
			'--js-runtimes',
			`deno:${paths.deno}`,
			'--no-remote-components',
			'--extractor-args',
			'youtube:player_client=mweb',
			'--socket-timeout',
			'20',
			'--retries',
			'1',
			'--extractor-retries',
			'1',
			'--skip-download',
			'--no-playlist',
			'--print',
			'id',
			'--verbose',
			testUrl,
		],
		environment,
		canaryTimeoutMs(),
	);
	const classified = classifyOutcome(result);
	const evidence = {
		schemaVersion: 1,
		candidateSha256: sha256(candidateBytes),
		completedAt: new Date().toISOString(),
		diagnostics: [
			`yt-dlp-exit=${result.code ?? result.signal ?? 'unknown'}`,
			`extracted-id=${classified.extractedId ? testId : 'unavailable'}`,
			`deno-challenge=${classified.denoChallenge ? 'observed' : 'not-observed'}`,
		],
		identities: {
			packages: packageIdentities(candidate),
			registry,
			source: candidate.source,
			test: {
				id: testId,
				source: 'yt_dlp/extractor/youtube/_video.py::_TESTS',
				upstreamCommit,
				url: testUrl,
			},
			toolchain: { ...candidate.toolchain, versions },
		},
		lane: 'live-canary',
		outcome: classified.outcome,
		region: requiredRegion(),
		waived: false,
	};
	await writeFile(resolve(outputArgument), `${JSON.stringify(evidence, null, 2)}\n`);
	if (classified.outcome !== 'pass') fail(`Live canary outcome: ${classified.outcome}.`);
	process.stdout.write(`${JSON.stringify({ outcome: 'pass', testId })}\n`);
} finally {
	if (paths.temporaryRoot !== undefined) {
		await rm(paths.temporaryRoot, { force: true, recursive: true });
	}
}
