'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, open, readFile, realpath } = require('node:fs/promises');
const { dirname, isAbsolute, join, relative } = require('node:path');

const PLATFORM_PACKAGE_NAME = 'n8n-nodes-yt-dlp-linux-x64';
const PLATFORM_PACKAGE_VERSION = '0.2.0';
const EXECUTION_MANIFEST_DIGEST =
	'328e2e648df1ea9c159ec6a5f2b1b36aeb092a9ce0e649ae7cfc1555b85b9d16';
const EXECUTION_MANIFEST_NAME = 'execution-manifest.json';
const EXPECTED_TOOL_NAMES = ['ytDlp', 'ffmpeg', 'ffprobe', 'deno'];
const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 2_000;

let cachedAttestation;
let inFlightAttestation;

class ToolchainAttestationError extends Error {
	constructor() {
		super('The packaged yt-dlp toolchain failed runtime attestation.');
		this.name = 'ToolchainAttestationError';
		this.code = 'TOOLCHAIN_ATTESTATION_FAILED';
	}
}

function failAttestation() {
	throw new ToolchainAttestationError();
}

function assertSupportedHost() {
	if (process.platform !== 'linux' || process.arch !== 'x64') failAttestation();
}

function digest(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

function fingerprint(stat) {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

function sameFingerprint(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function assertExecutableMatchesMode(stat, mode) {
	if (
		!stat.isFile() ||
		((stat.mode & 0o111n) !== 0n) !== mode.executable ||
		((stat.mode & 0o020n) !== 0n) !== mode.groupWritable ||
		((stat.mode & 0o002n) !== 0n) !== mode.worldWritable
	) {
		failAttestation();
	}
}

function isConfinedPath(root, path) {
	const relativePath = relative(root, path);
	return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function parseExecutionManifest(contents) {
	let manifest;
	try {
		manifest = JSON.parse(contents.toString('utf8'));
	} catch {
		failAttestation();
	}
	if (
		manifest === null ||
		typeof manifest !== 'object' ||
		manifest.schemaVersion !== 1 ||
		manifest.packageName !== PLATFORM_PACKAGE_NAME ||
		manifest.packageVersion !== PLATFORM_PACKAGE_VERSION ||
		!Array.isArray(manifest.files) ||
		manifest.files.length !== EXPECTED_TOOL_NAMES.length
	) {
		failAttestation();
	}
	for (const [index, entry] of manifest.files.entries()) {
		if (
			entry === null ||
			typeof entry !== 'object' ||
			entry.name !== EXPECTED_TOOL_NAMES[index] ||
			entry.mode === null ||
			typeof entry.mode !== 'object' ||
			entry.mode.executable !== true ||
			entry.mode.groupWritable !== false ||
			entry.mode.worldWritable !== false ||
			typeof entry.path !== 'string' ||
			entry.path.length === 0 ||
			isAbsolute(entry.path) ||
			entry.path.split(/[\\/]/u).includes('..') ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0 ||
			typeof entry.sha256 !== 'string' ||
			!/^[0-9a-f]{64}$/u.test(entry.sha256) ||
			entry.probe === null ||
			typeof entry.probe !== 'object' ||
			!Array.isArray(entry.probe.args) ||
			entry.probe.args.some((argument) => typeof argument !== 'string') ||
			typeof entry.probe.stdout !== 'string'
		) {
			failAttestation();
		}
	}
	return manifest;
}

async function readManifest(platformRoot) {
	const manifestPath = join(platformRoot, EXECUTION_MANIFEST_NAME);
	let handle;
	try {
		handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || (stat.mode & 0o022n) !== 0n) failAttestation();
		const contents = await handle.readFile();
		if (digest(contents) !== EXECUTION_MANIFEST_DIGEST) failAttestation();
		return {
			fingerprint: fingerprint(stat),
			manifest: parseExecutionManifest(contents),
			path: manifestPath,
		};
	} finally {
		await handle?.close();
	}
}

async function hashDescriptor(handle) {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let position = 0;
	while (true) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) break;
		hash.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest('hex');
}

async function verifyExecutable(platformRoot, entry) {
	const executablePath = join(platformRoot, entry.path);
	const resolvedPath = await realpath(executablePath);
	if (!isConfinedPath(platformRoot, resolvedPath)) failAttestation();

	let handle;
	try {
		handle = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat({ bigint: true });
		assertExecutableMatchesMode(before, entry.mode);
		if (before.size !== BigInt(entry.size)) failAttestation();
		if ((await hashDescriptor(handle)) !== entry.sha256) failAttestation();
		const after = await handle.stat({ bigint: true });
		assertExecutableMatchesMode(after, entry.mode);
		if (!sameFingerprint(fingerprint(before), fingerprint(after))) failAttestation();
		return {
			path: executablePath,
			fingerprint: fingerprint(after),
			mode: entry.mode,
			probe: entry.probe,
		};
	} finally {
		await handle?.close();
	}
}

function terminateProbe(child) {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
}

async function runProbe(executable) {
	await new Promise((resolveProbe, rejectProbe) => {
		const child = spawn(executable.path, executable.probe.args, {
			cwd: dirname(executable.path),
			detached: true,
			env: {
				DENO_NO_UPDATE_CHECK: '1',
				LANG: 'C',
				LC_ALL: 'C',
				NO_COLOR: '1',
			},
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stdout = [];
		let stdoutBytes = 0;
		let outputBytes = 0;
		let settled = false;
		const settle = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === undefined) resolveProbe();
			else rejectProbe(error);
		};
		const consume = (chunk, capture) => {
			outputBytes += chunk.length;
			if (capture) {
				stdoutBytes += chunk.length;
				stdout.push(chunk);
			}
			if (outputBytes > PROBE_OUTPUT_LIMIT_BYTES) terminateProbe(child);
		};
		child.stdout.on('data', (chunk) => consume(chunk, true));
		child.stderr.on('data', (chunk) => consume(chunk, false));
		child.once('error', (error) => settle(error));
		child.once('close', (code, signal) => {
			if (
				code !== 0 ||
				signal !== null ||
				outputBytes > PROBE_OUTPUT_LIMIT_BYTES ||
				Buffer.concat(stdout, stdoutBytes).toString('utf8') !== executable.probe.stdout
			) {
				settle(new Error('probe failed'));
				return;
			}
			settle();
		});
		const timer = setTimeout(() => terminateProbe(child), PROBE_TIMEOUT_MS);
	});
}

async function loadPlatformRoot() {
	const packageJsonPath = require.resolve(`${PLATFORM_PACKAGE_NAME}/package.json`);
	const packageMetadata = JSON.parse(await readFile(packageJsonPath, 'utf8'));
	if (
		packageMetadata.name !== PLATFORM_PACKAGE_NAME ||
		packageMetadata.version !== PLATFORM_PACKAGE_VERSION
	) {
		failAttestation();
	}
	return await realpath(dirname(packageJsonPath));
}

async function attestToolchain() {
	try {
		const platformRoot = await loadPlatformRoot();
		const verifiedManifest = await readManifest(platformRoot);
		const { manifest } = verifiedManifest;
		const executables = [];
		for (const entry of manifest.files) {
			executables.push(await verifyExecutable(platformRoot, entry));
		}
		for (const executable of executables) await runProbe(executable);
		const toolchain = Object.freeze(
			Object.fromEntries(executables.map((executable, index) => [manifest.files[index].name, executable.path])),
		);
		return { platformRoot, verifiedManifest, executables, toolchain };
	} catch (error) {
		if (error instanceof ToolchainAttestationError) throw error;
		throw new ToolchainAttestationError();
	}
}

async function fingerprintsAreUnchanged(attestation) {
	try {
		const currentPlatformRoot = await loadPlatformRoot();
		if (currentPlatformRoot !== attestation.platformRoot) return false;
		const manifestStat = await lstat(attestation.verifiedManifest.path, { bigint: true });
		if (
			!manifestStat.isFile() ||
			(manifestStat.mode & 0o022n) !== 0n ||
			!sameFingerprint(
				fingerprint(manifestStat),
				attestation.verifiedManifest.fingerprint,
			)
		) {
			return false;
		}
		for (const executable of attestation.executables) {
			const stat = await lstat(executable.path, { bigint: true });
			assertExecutableMatchesMode(stat, executable.mode);
			if (!sameFingerprint(fingerprint(stat), executable.fingerprint)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function getVerifiedToolchain() {
	try {
		assertSupportedHost();
	} catch (error) {
		return Promise.reject(error);
	}
	if (inFlightAttestation !== undefined) return inFlightAttestation;
	inFlightAttestation = (async () => {
		if (
			cachedAttestation !== undefined &&
			(await fingerprintsAreUnchanged(cachedAttestation))
		) {
			return cachedAttestation.toolchain;
		}
		cachedAttestation = await attestToolchain();
		return cachedAttestation.toolchain;
	})();
	void inFlightAttestation.then(
		() => {
			inFlightAttestation = undefined;
		},
		() => {
			inFlightAttestation = undefined;
		},
	);
	return inFlightAttestation;
}

module.exports = { getVerifiedToolchain, ToolchainAttestationError };
