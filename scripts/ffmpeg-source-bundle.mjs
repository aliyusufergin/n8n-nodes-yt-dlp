import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const repositoryRoot = resolve(import.meta.dirname, '..');
const packageRoot = join(repositoryRoot, 'packages', 'linux-x64');
const manifestPath = join(packageRoot, 'FFMPEG-SOURCE-MANIFEST.json');
const toolchainRoot = join(repositoryRoot, 'toolchain', 'ffmpeg');
const digestPattern = /^[0-9a-f]{64}$/u;

function fail(message) {
	throw new Error(message);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
	if (result.status !== 0) fail(`${command} failed: ${result.stderr || result.stdout}`);
	return result.stdout;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

async function sha256(path) {
	return await new Promise((resolveDigest, rejectDigest) => {
		const hash = createHash('sha256');
		const input = createReadStream(path);
		input.on('data', (chunk) => hash.update(chunk));
		input.once('error', rejectDigest);
		input.once('end', () => resolveDigest(hash.digest('hex')));
	});
}

function assertSafeRelativePath(path, description) {
	if (
		path.length === 0 ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.split('/').includes('..')
	) {
		fail(`Unsafe ${description}: ${path}`);
	}
}

async function assertDigest(path, expected, description) {
	if (!digestPattern.test(expected)) fail(`Invalid ${description} digest: ${expected}`);
	const actual = await sha256(path);
	if (actual !== expected)
		fail(`${description} digest mismatch: expected ${expected}, got ${actual}`);
}

function sourceComponent(name) {
	const component = name.replace(/_[0-9a-f]{64}\.tar\.xz$/u, '');
	if (component === name) fail(`Unexpected dependency source name: ${name}`);
	return component;
}

async function verifyPackage({ allowPendingBundle = false } = {}) {
	const [manifest, lock, packageMetadata, executionManifest, linkedLibraries, dockerfile, review] =
		await Promise.all([
			readJson(manifestPath),
			readJson(join(packageRoot, 'TOOLCHAIN.lock.json')),
			readJson(join(packageRoot, 'package.json')),
			readJson(join(packageRoot, 'execution-manifest.json')),
			readJson(join(toolchainRoot, 'LINKED-LIBRARIES.json')),
			readFile(join(toolchainRoot, 'Dockerfile.dependencies'), 'utf8'),
			readFile(join(repositoryRoot, manifestReviewPath()), 'utf8'),
		]);

	if (packageMetadata.license !== 'SEE LICENSE IN LICENSES.md') {
		fail('The platform package must use SEE LICENSE IN LICENSES.md.');
	}
	if (!packageMetadata.files.includes('FFMPEG-SOURCE-MANIFEST.json')) {
		fail('The platform package does not publish FFMPEG-SOURCE-MANIFEST.json.');
	}
	if (manifest.sourceArchives.length !== 109)
		fail('The source inventory must contain 109 archives.');
	if (manifest.primarySources.length !== 2)
		fail('The source inventory must contain two primary sources.');
	if (manifest.manualReview.status !== 'approved' || !review.includes('Conclusion: approved')) {
		fail('The frozen build has no approved manual license review.');
	}

	const names = new Set();
	const components = new Set();
	for (const source of manifest.sourceArchives) {
		assertSafeRelativePath(source.name, 'source archive name');
		if (names.has(source.name)) fail(`Duplicate source archive: ${source.name}`);
		names.add(source.name);
		const component = sourceComponent(source.name);
		components.add(component);
		if (!digestPattern.test(source.sha256)) fail(`Invalid source digest: ${source.name}`);
		if (source.licenseFiles.length === 0) fail(`No license material for ${source.name}`);
		for (const licensePath of source.licenseFiles) {
			assertSafeRelativePath(licensePath, 'license path');
			if (!licensePath.startsWith(`LICENSES/ffmpeg-static/${component}/`)) {
				fail(`License material is mapped to the wrong component: ${licensePath}`);
			}
			const absoluteLicensePath = resolve(packageRoot, licensePath);
			const relativeLicensePath = relative(packageRoot, absoluteLicensePath);
			if (relativeLicensePath === '..' || relativeLicensePath.startsWith(`..${sep}`)) {
				fail(`License material escapes the platform package: ${licensePath}`);
			}
			if ((await stat(absoluteLicensePath)).size === 0)
				fail(`Empty license material: ${licensePath}`);
		}
		if (!dockerfile.includes(source.name)) fail(`Dockerfile omits source archive ${source.name}`);
	}
	if (names.size !== 109 || components.size !== 109)
		fail('Source archive identities are not unique.');

	for (const source of manifest.primarySources) {
		assertSafeRelativePath(source.name, 'primary source name');
		if (!digestPattern.test(source.sha256)) fail(`Invalid primary source digest: ${source.name}`);
	}
	for (const [library, component] of Object.entries(linkedLibraries.external)) {
		if (!components.has(component))
			fail(`Linked library ${library} has no source component ${component}.`);
	}
	if (Object.keys(linkedLibraries.external).length === 0)
		fail('The external linker inventory is empty.');

	const pinnedBase = manifest.buildContainer.baseImage;
	if (!dockerfile.startsWith(`FROM ${pinnedBase} AS base-layer\n`)) {
		fail('The dependency Dockerfile does not start from the pinned base-image digest.');
	}
	if (/(?:^|\s)(?:FROM\s+\S+:latest|https?:\/\/)/imu.test(dockerfile)) {
		fail('The dependency Dockerfile contains a mutable image or remote source.');
	}

	const ffmpegLock = lock.components.find(({ name }) => name === 'ffmpeg');
	if (ffmpegLock === undefined) fail('Toolchain Lock has no FFmpeg component.');
	const expectedLock = {
		assets: [
			{
				name: manifest.binaryBuild.asset,
				sha256: manifest.binaryBuild.assetSha256,
			},
		],
		license: 'GPL-3.0-or-later AND LicenseRef-FFmpeg-static-components',
		name: 'ffmpeg',
		sourceBundle: manifest.sourceBundle,
		upstream: {
			commit: manifest.binaryBuild.ffmpegBuildsCommit,
			ffmpegCommit: manifest.binaryBuild.ffmpegCommit,
			repository: 'yt-dlp/FFmpeg-Builds',
			tag: manifest.binaryBuild.releaseTag,
		},
	};
	if (!isDeepStrictEqual(ffmpegLock, expectedLock)) {
		fail('Toolchain Lock FFmpeg identity does not match the source manifest.');
	}
	if (!allowPendingBundle && !digestPattern.test(manifest.sourceBundle.sha256)) {
		fail('The source-bundle digest has not been frozen.');
	}
	if (
		!/^https:\/\/github\.com\/aliyusufergin\/n8n-nodes-yt-dlp\/releases\/download\/v0\.2\.0\//u.test(
			manifest.sourceBundle.url,
		)
	) {
		fail('The source bundle must use the immutable versioned release URL.');
	}

	for (const expected of [
		['ffmpeg', 'ea50d9fba39cc2f57785be7d082a65d5484728d83e9f90ecc6ba4372c05fc022'],
		['ffprobe', '7d37b347245e21cea470f7ba696f32eb918dcf485fd5ffba3b29f44c0556f7d8'],
	]) {
		const [name, digest] = expected;
		await assertDigest(join(packageRoot, 'bin', name), digest, name);
		const evidence = executionManifest.files.find((file) => file.name === name);
		if (
			evidence?.sha256 !== digest ||
			!evidence.probe.stdout.includes(`N-125551-ga09be9b91e-20260712`)
		) {
			fail(`Execution evidence does not match ${name}.`);
		}
	}

	return { executionManifest, manifest };
}

function manifestReviewPath() {
	return 'toolchain/ffmpeg/MANUAL-LICENSE-REVIEW.md';
}

async function assemble(inputRoot, outputPath) {
	const { executionManifest, manifest } = await verifyPackage({ allowPendingBundle: true });
	const resolvedInputRoot = resolve(inputRoot);
	const resolvedOutputPath = resolve(outputPath);
	const cachePath = join(resolvedInputRoot, manifest.sourceCache.name);
	await assertDigest(cachePath, manifest.sourceCache.sha256, 'source cache');
	for (const source of manifest.primarySources) {
		await assertDigest(join(resolvedInputRoot, source.name), source.sha256, source.name);
	}

	const temporaryRoot = await mkdtemp(join(tmpdir(), 'n8n-ffmpeg-source-bundle-'));
	try {
		const bundleDirectoryName = manifest.sourceBundle.name.replace(/\.tar\.xz$/u, '');
		const bundleRoot = join(temporaryRoot, bundleDirectoryName);
		const dependencyRoot = join(bundleRoot, 'source', 'dependencies');
		const extractedCache = join(temporaryRoot, 'cache');
		await mkdir(dependencyRoot, { recursive: true });
		await mkdir(extractedCache);

		for (const source of manifest.primarySources) {
			await cp(join(resolvedInputRoot, source.name), join(bundleRoot, 'source', source.name));
		}
		const cacheMembers = manifest.sourceArchives.map(({ name }) => `.cache/downloads/${name}`);
		run('tar', ['-xzf', cachePath, '-C', extractedCache, ...cacheMembers]);
		for (const source of manifest.sourceArchives) {
			const extractedPath = join(extractedCache, '.cache', 'downloads', source.name);
			await assertDigest(extractedPath, source.sha256, source.name);
			await cp(extractedPath, join(dependencyRoot, source.name));
		}

		const toolchainFiles = [
			'Dockerfile.dependencies',
			'LINKED-LIBRARIES.json',
			'MANUAL-LICENSE-REVIEW.md',
			'README.md',
			'build-ffmpeg.sh',
			'defaults-gpl.sh',
			'linux64-gpl.sh',
			'rebuild.sh',
		];
		await mkdir(join(bundleRoot, 'toolchain'), { recursive: true });
		for (const name of toolchainFiles) {
			await cp(join(toolchainRoot, name), join(bundleRoot, 'toolchain', name));
		}
		await chmod(join(bundleRoot, 'toolchain', 'build-ffmpeg.sh'), 0o755);
		await chmod(join(bundleRoot, 'toolchain', 'rebuild.sh'), 0o755);

		await mkdir(join(bundleRoot, 'evidence'), { recursive: true });
		await cp(
			join(packageRoot, 'execution-manifest.json'),
			join(bundleRoot, 'evidence', 'execution-manifest.json'),
		);
		await cp(
			join(packageRoot, 'LICENSES', 'FFmpeg-GPLv3.txt'),
			join(bundleRoot, 'evidence', 'FFmpeg-GPLv3.txt'),
		);
		await cp(
			join(packageRoot, 'LICENSES', 'FFmpeg-Builds-MIT.txt'),
			join(bundleRoot, 'evidence', 'FFmpeg-Builds-MIT.txt'),
		);
		const ffmpegEvidence = executionManifest.files.find(({ name }) => name === 'ffmpeg');
		const ffprobeEvidence = executionManifest.files.find(({ name }) => name === 'ffprobe');
		await writeFile(
			join(bundleRoot, 'evidence', 'expected-ffmpeg-version.txt'),
			ffmpegEvidence.probe.stdout,
		);
		await writeFile(
			join(bundleRoot, 'evidence', 'expected-ffprobe-version.txt'),
			ffprobeEvidence.probe.stdout,
		);

		const sourceInventory = structuredClone(manifest);
		sourceInventory.sourceBundle = {
			name: manifest.sourceBundle.name,
			url: manifest.sourceBundle.url,
		};
		await writeFile(
			join(bundleRoot, 'SOURCE-INVENTORY.json'),
			`${JSON.stringify(sourceInventory, null, '\t')}\n`,
		);

		await mkdir(dirname(resolvedOutputPath), { recursive: true });
		const temporaryOutput = `${resolvedOutputPath}.tmp`;
		await rm(temporaryOutput, { force: true });
		run('tar', [
			'--sort=name',
			'--mtime=@0',
			'--owner=0',
			'--group=0',
			'--numeric-owner',
			'-cJf',
			temporaryOutput,
			'-C',
			temporaryRoot,
			bundleDirectoryName,
		]);
		await rename(temporaryOutput, resolvedOutputPath);
		console.log(`${await sha256(resolvedOutputPath)}  ${resolvedOutputPath}`);
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
	}
}

async function verifyBundle(bundlePath) {
	const { manifest } = await verifyPackage();
	const resolvedBundlePath = resolve(bundlePath);
	await assertDigest(resolvedBundlePath, manifest.sourceBundle.sha256, manifest.sourceBundle.name);
	const members = run('tar', ['-tJf', resolvedBundlePath]).split('\n').filter(Boolean);
	for (const member of members) assertSafeRelativePath(member.replace(/\/$/u, ''), 'bundle member');
	const root = manifest.sourceBundle.name.replace(/\.tar\.xz$/u, '');
	const required = [
		`${root}/SOURCE-INVENTORY.json`,
		`${root}/toolchain/Dockerfile.dependencies`,
		`${root}/toolchain/build-ffmpeg.sh`,
		`${root}/toolchain/rebuild.sh`,
		`${root}/evidence/execution-manifest.json`,
		...manifest.primarySources.map(({ name }) => `${root}/source/${name}`),
		...manifest.sourceArchives.map(({ name }) => `${root}/source/dependencies/${name}`),
	];
	const memberSet = new Set(members);
	for (const path of required) {
		if (!memberSet.has(path)) fail(`Source bundle omits ${path}`);
	}
	console.log(
		`Verified ${manifest.sourceBundle.name} (${manifest.sourceArchives.length} dependency sources).`,
	);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
	case 'verify-package':
		if (args.length !== 0) fail('Usage: verify-package');
		await verifyPackage();
		console.log('FFmpeg package compliance gate passed.');
		break;
	case 'assemble':
		if (args.length !== 2) fail('Usage: assemble <input-directory> <output.tar.xz>');
		await assemble(args[0], args[1]);
		break;
	case 'verify-bundle':
		if (args.length !== 1) fail('Usage: verify-bundle <source-bundle.tar.xz>');
		await verifyBundle(args[0]);
		break;
	default:
		fail('Usage: ffmpeg-source-bundle.mjs <verify-package|assemble|verify-bundle> ...');
}
