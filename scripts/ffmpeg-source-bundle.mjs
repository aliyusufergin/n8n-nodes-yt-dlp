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
const licenseReviewPath = join(toolchainRoot, 'LICENSE-REVIEW.json');
const rebuildEvidencePath = join(toolchainRoot, 'REBUILD-EVIDENCE.json');

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

function sha256Bytes(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

function sourceInventory(manifest) {
	const inventory = structuredClone(manifest);
	delete inventory.manualReview;
	inventory.sourceBundle = {
		name: manifest.sourceBundle.name,
		url: manifest.sourceBundle.url,
	};
	return inventory;
}

function sourceInventoryBytes(manifest) {
	return `${JSON.stringify(sourceInventory(manifest), null, '\t')}\n`;
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
	const [manifest, lock, packageMetadata, executionManifest, linkedLibraries, dockerfile] =
		await Promise.all([
			readJson(manifestPath),
			readJson(join(packageRoot, 'TOOLCHAIN.lock.json')),
			readJson(join(packageRoot, 'package.json')),
			readJson(join(packageRoot, 'execution-manifest.json')),
			readJson(join(toolchainRoot, 'LINKED-LIBRARIES.json')),
			readFile(join(toolchainRoot, 'Dockerfile.dependencies'), 'utf8'),
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
	if (
		!isDeepStrictEqual(manifest.manualReview, {
			path: 'toolchain/ffmpeg/LICENSE-REVIEW.json',
			requiredStatus: 'approved',
		})
	) {
		fail('The source manifest does not require the canonical license-review evidence.');
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
	const inputRootSources = manifest.sourceArchives.filter(({ input }) => input === 'input-root');
	const rav1eSource = inputRootSources.find(
		({ name }) => sourceComponent(name) === '50-rav1e',
	);
	const freetypeSources = inputRootSources.filter(({ name }) =>
		['25-freetype', '50-freetype'].includes(sourceComponent(name)),
	);
	if (
		inputRootSources.length !== 3 ||
		!rav1eSource ||
		rav1eSource.cargoPackages?.length === 0 ||
		rav1eSource.cargoVendor?.packageCount !== rav1eSource.cargoPackages.length ||
		!digestPattern.test(rav1eSource.cargoVendor?.configSha256 ?? '') ||
		!digestPattern.test(rav1eSource.cargoVendor?.lockSha256 ?? '')
	) {
		fail('The vendored rav1e Cargo source inventory is missing.');
	}
	for (const cargoPackage of rav1eSource.cargoPackages) {
		if (
			typeof cargoPackage.name !== 'string' ||
			typeof cargoPackage.version !== 'string' ||
			typeof cargoPackage.license !== 'string' ||
			cargoPackage.licenseFiles.length === 0
		) {
			fail('The vendored rav1e Cargo license mapping is incomplete.');
		}
	}
	if (
		freetypeSources.length !== 2 ||
		freetypeSources.some(
			(source) =>
				source.vendoredSubmodules?.length !== 1 ||
				source.vendoredSubmodules[0].path !== 'subprojects/dlg' ||
				source.vendoredSubmodules[0].commit !==
					'395ccad2c1e0daae535c4d20bb0a3f2424648e17' ||
				source.vendoredSubmodules[0].licenseFiles.length === 0,
			)
	) {
		fail('The vendored FreeType dlg source inventory is missing.');
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
	const externalLinkerInputsSha256 = sha256Bytes(
		`${Object.keys(linkedLibraries.external).sort().join('\n')}\n`,
	);
	if (linkedLibraries.evidence.externalLinkerInputsSha256 !== externalLinkerInputsSha256) {
		fail('The external linker inventory does not match the captured linker-input evidence.');
	}
	const runtime = linkedLibraries.toolchainRuntime;
	if (
		!isDeepStrictEqual(runtime.incorporated.libraries, ['atomic', 'gcc', 'gomp', 'stdc++']) ||
		runtime.incorporated.license !== 'GPL-3.0-or-later WITH GCC-exception-3.1' ||
		runtime.hostDynamic.distributedInPackage !== false
	) {
		fail('The GCC and host runtime inventory is incomplete.');
	}
	for (const licensePath of runtime.incorporated.licenseFiles) {
		await stat(join(packageRoot, licensePath));
	}

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
	for (const name of ['ffmpegSha256', 'ffprobeSha256']) {
		if (!digestPattern.test(manifest.cleanRebuildOutputs?.[name] ?? '')) {
			fail(`The expected clean-rebuild ${name} has not been frozen.`);
		}
	}

	for (const expected of [
		[
			'ffmpeg',
			'ffmpegBinary',
			'ffmpeg.gnu',
			'ea50d9fba39cc2f57785be7d082a65d5484728d83e9f90ecc6ba4372c05fc022',
		],
		[
			'ffprobe',
			'ffprobeBinary',
			'ffprobe.gnu',
			'7d37b347245e21cea470f7ba696f32eb918dcf485fd5ffba3b29f44c0556f7d8',
		],
	]) {
		const [name, binaryName, fileName, digest] = expected;
		await assertDigest(join(packageRoot, 'bin', fileName), digest, name);
		const binaryEvidence = executionManifest.files.find((file) => file.name === binaryName);
		const probeEvidence = executionManifest.files.find((file) => file.name === name);
		if (
			binaryEvidence?.sha256 !== digest ||
			!probeEvidence?.probe.stdout.includes(`N-125551-ga09be9b91e-20260712`)
		) {
			fail(`Execution evidence does not match ${name}.`);
		}
	}

	return { executionManifest, manifest };
}

async function licenseSurfaceSha256(manifest) {
	const paths = [
		'LICENSES/FFmpeg-Builds-MIT.txt',
		'LICENSES/FFmpeg-GPLv3.txt',
		'LICENSES/GCC-Runtime-Library-Exception-3.1.txt',
		...manifest.sourceArchives.flatMap(({ licenseFiles }) => licenseFiles),
	];
	const records = [];
	for (const path of [...new Set(paths)].sort()) {
		records.push(`${path}\0${await sha256(join(packageRoot, path))}\n`);
	}
	return sha256Bytes(records.join(''));
}

function versionEvidenceBytes(executionManifest, name) {
	const stdout = executionManifest.files.find((file) => file.name === name)?.probe.stdout;
	if (typeof stdout !== 'string') fail(`Execution manifest has no ${name} version evidence.`);
	const lines = stdout
		.split('\n')
		.filter((line) => /^(?:ffmpeg version|ffprobe version|configuration:|libav|libsw)/u.test(line));
	if (lines.length === 0) fail(`Execution manifest has no normalized ${name} version evidence.`);
	return `${lines.join('\n')}\n`;
}

async function expectedEvidence(manifest, executionManifest) {
	const [sourceManifestSha256, linkedLibrariesSha256, dockerfileSha256] = await Promise.all([
		sha256(manifestPath),
		sha256(join(toolchainRoot, 'LINKED-LIBRARIES.json')),
		sha256(join(toolchainRoot, 'Dockerfile.dependencies')),
	]);
	const [buildScriptSha256, rebuildScriptSha256, rav1ePatchSha256] = await Promise.all([
		sha256(join(toolchainRoot, 'build-ffmpeg.sh')),
		sha256(join(toolchainRoot, 'rebuild.sh')),
		sha256(join(toolchainRoot, 'patches', '50-rav1e-offline.patch')),
	]);
	return {
		reviewBindings: {
			binaryAssetSha256: manifest.binaryBuild.assetSha256,
			licenseSurfaceSha256: await licenseSurfaceSha256(manifest),
			linkedLibrariesSha256,
			sourceBundleSha256: manifest.sourceBundle.sha256,
			sourceManifestSha256,
		},
		rebuildBindings: {
			baseImage: manifest.buildContainer.baseImage,
			binaryAssetSha256: manifest.binaryBuild.assetSha256,
			buildScriptSha256,
			dependencyDockerfileSha256: dockerfileSha256,
			rav1ePatchSha256,
			rebuildScriptSha256,
			sourceInventorySha256: sha256Bytes(sourceInventoryBytes(manifest)),
		},
		expectedConfiguration: {
			ffmpegConfigEvidenceSha256: sha256Bytes(versionEvidenceBytes(executionManifest, 'ffmpeg')),
			ffprobeConfigEvidenceSha256: sha256Bytes(versionEvidenceBytes(executionManifest, 'ffprobe')),
		},
		expectedOutputs: manifest.cleanRebuildOutputs,
	};
}

async function verifyReleaseEvidence(manifest, executionManifest) {
	const [review, rebuild, expected] = await Promise.all([
		readJson(licenseReviewPath),
		readJson(rebuildEvidencePath),
		expectedEvidence(manifest, executionManifest),
	]);
	if (
		review.status !== 'approved' ||
		typeof review.reviewer !== 'string' ||
		review.reviewer.length === 0 ||
		Number.isNaN(Date.parse(review.reviewedAt)) ||
		review.decision?.separateProcessAggregate !== 'supported' ||
		!isDeepStrictEqual(review.bindings, expected.reviewBindings)
	) {
		fail(
			'Platform publication requires explicit maintainer license-review approval for the frozen inputs.',
		);
	}

	if (
		rebuild.status !== 'passed' ||
		Number.isNaN(Date.parse(rebuild.completedAt)) ||
		rebuild.networkMode !== 'none' ||
		!isDeepStrictEqual(rebuild.bindings, expected.rebuildBindings) ||
		!digestPattern.test(rebuild.outputs?.ffmpegSha256) ||
		!digestPattern.test(rebuild.outputs?.ffprobeSha256) ||
		rebuild.outputs?.ffmpegSha256 !== expected.expectedOutputs.ffmpegSha256 ||
		rebuild.outputs?.ffprobeSha256 !== expected.expectedOutputs.ffprobeSha256 ||
		rebuild.outputs?.ffmpegConfigEvidenceSha256 !==
			expected.expectedConfiguration.ffmpegConfigEvidenceSha256 ||
		rebuild.outputs?.ffprobeConfigEvidenceSha256 !==
			expected.expectedConfiguration.ffprobeConfigEvidenceSha256
	) {
		fail(
			'Platform publication requires persisted successful clean-rebuild evidence for the frozen inputs.',
		);
	}
}

async function verifyPublishedAsset(bundle, description) {
	const response = await fetch(
		'https://api.github.com/repos/aliyusufergin/n8n-nodes-yt-dlp/releases/tags/v0.2.0',
		{
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'n8n-nodes-yt-dlp-gate' },
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok)
		fail(`The versioned source release is not published (GitHub HTTP ${response.status}).`);
	const release = await response.json();
	const asset = release.assets?.find(({ name }) => name === bundle.name);
	const checksumName = `${bundle.name}.sha256`;
	const checksumAsset = release.assets?.find(({ name }) => name === checksumName);
	if (
		asset?.state !== 'uploaded' ||
		asset.digest !== `sha256:${bundle.sha256}` ||
		asset.browser_download_url !== bundle.url ||
		checksumAsset?.state !== 'uploaded' ||
		checksumAsset.browser_download_url !== `${bundle.url}.sha256`
	) {
		fail(`The published ${description} identity or GitHub digest does not match Toolchain Lock.`);
	}
	const checksumResponse = await fetch(checksumAsset.browser_download_url, {
		headers: { 'User-Agent': 'n8n-nodes-yt-dlp-gate' },
		signal: AbortSignal.timeout(30_000),
	});
	if (
		!checksumResponse.ok ||
		(await checksumResponse.text()) !== `${bundle.sha256}  ${bundle.name}\n`
	) {
		fail(`The published ${description} SHA-256 sidecar does not match Toolchain Lock.`);
	}
}

async function verifyPublishedSourceAsset(manifest) {
	await verifyPublishedAsset(manifest.sourceBundle, 'FFmpeg source asset');
}

async function verifyLinuxRuntimeReleaseGate() {
	const [lock, executionManifest] = await Promise.all([
		readJson(join(packageRoot, 'TOOLCHAIN.lock.json')),
		readJson(join(packageRoot, 'execution-manifest.json')),
	]);
	const runtime = lock.components.find(({ name }) => name === 'linux-runtime');
	if (runtime?.sourceGate?.status !== 'passed') {
		fail(
			'Platform publication is blocked until the Linux runtime Corresponding Source, clean-rebuild, and license-review gate passes.',
		);
	}
	const bundle = runtime.sourceGate.bundle;
	if (
		!digestPattern.test(bundle?.sha256 ?? '') ||
		!/^https:\/\/github\.com\/aliyusufergin\/n8n-nodes-yt-dlp\/releases\/download\/v0\.2\.0\//u.test(
			bundle?.url ?? '',
		)
	) {
		fail('The Linux runtime source gate has no direct immutable Corresponding Source Bundle.');
	}
	const rebuildPath = join(repositoryRoot, 'toolchain', 'linux-x64', 'REBUILD-EVIDENCE.json');
	const reviewPath = join(repositoryRoot, 'toolchain', 'linux-x64', 'LICENSE-REVIEW.json');
	const [rebuild, review] = await Promise.all([
		readJson(rebuildPath),
		readJson(reviewPath),
	]);
	if (
		runtime.sourceGate.rebuildEvidence?.path !==
			'toolchain/linux-x64/REBUILD-EVIDENCE.json' ||
		runtime.sourceGate.rebuildEvidence?.sha256 !== (await sha256(rebuildPath)) ||
		runtime.sourceGate.manualReview?.path !==
			'toolchain/linux-x64/LICENSE-REVIEW.json' ||
		runtime.sourceGate.manualReview?.sha256 !== (await sha256(reviewPath))
	) {
		fail('The Linux runtime source gate is not bound to its persisted evidence.');
	}
	const expectedBindings = {
		buildImage: runtime.build.image,
		buildScript: runtime.build.script,
		launcherSource: runtime.build.launcherSource,
		muslRuntimeImage: runtime.muslRuntime.image,
		runtimeImage: runtime.runtime.image,
		sourceBundleSha256: bundle.sha256,
		sourceInputs: runtime.sourceBundles,
	};
	if (
		rebuild.status !== 'passed' ||
		rebuild.networkMode !== 'none' ||
		Number.isNaN(Date.parse(rebuild.completedAt)) ||
		!isDeepStrictEqual(rebuild.bindings, expectedBindings)
	) {
		fail('The Linux runtime clean-rebuild evidence does not match the frozen inputs.');
	}
	const runtimePaths = executionManifest.files.filter(
		({ name }) =>
			name.endsWith('Loader') ||
			name === 'ytDlp' ||
			name === 'ffmpeg' ||
			name === 'ffprobe' ||
			name === 'deno' ||
			name === 'muslZlib' ||
			[
				'glibc',
				'glibcDl',
				'gccRuntime',
				'glibcMath',
				'glibcVectorMath',
				'glibcDns',
				'glibcFiles',
				'glibcThreads',
				'glibcResolver',
				'glibcRealtime',
				'zlib',
			].includes(name),
	);
	const expectedOutputs = Object.fromEntries(
		runtimePaths.map(({ path, sha256: outputSha256 }) => [path, outputSha256]),
	);
	if (!isDeepStrictEqual(rebuild.outputs, expectedOutputs)) {
		fail('The Linux runtime clean rebuild does not reproduce every packaged runtime byte.');
	}
	if (
		review.status !== 'approved' ||
		typeof review.reviewer !== 'string' ||
		review.reviewer.length === 0 ||
		Number.isNaN(Date.parse(review.reviewedAt)) ||
		!isDeepStrictEqual(review.bindings, {
			license: runtime.license,
			sourceBundleSha256: bundle.sha256,
			sourceInputs: runtime.sourceBundles,
		})
	) {
		fail('The Linux runtime manual license review does not match the frozen source inventory.');
	}
	await verifyPublishedAsset(bundle, 'Linux runtime source asset');
}

async function verifyRelease() {
	await verifyLinuxRuntimeReleaseGate();
	const { executionManifest, manifest } = await verifyPackage();
	await verifyReleaseEvidence(manifest, executionManifest);
	await verifyPublishedSourceAsset(manifest);
}

async function printEvidenceBindings() {
	const { executionManifest, manifest } = await verifyPackage();
	console.log(JSON.stringify(await expectedEvidence(manifest, executionManifest), null, '\t'));
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
		const cacheSources = manifest.sourceArchives.filter(({ input }) => input !== 'input-root');
		const cacheMembers = cacheSources.map(({ name }) => `.cache/downloads/${name}`);
		run('tar', ['-xzf', cachePath, '-C', extractedCache, ...cacheMembers]);
		for (const source of manifest.sourceArchives) {
			const extractedPath =
				source.input === 'input-root'
					? join(resolvedInputRoot, source.name)
					: join(extractedCache, '.cache', 'downloads', source.name);
			await assertDigest(extractedPath, source.sha256, source.name);
			await cp(extractedPath, join(dependencyRoot, source.name));
		}

		const toolchainFiles = [
			'Dockerfile.dependencies',
			'LINKED-LIBRARIES.json',
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
		await mkdir(join(bundleRoot, 'toolchain', 'patches'), { recursive: true });
		await cp(
			join(toolchainRoot, 'patches', '50-rav1e-offline.patch'),
			join(bundleRoot, 'toolchain', 'patches', '50-rav1e-offline.patch'),
		);
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
		await cp(
			join(packageRoot, 'LICENSES', 'GCC-Runtime-Library-Exception-3.1.txt'),
			join(bundleRoot, 'evidence', 'GCC-Runtime-Library-Exception-3.1.txt'),
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

		await writeFile(join(bundleRoot, 'SOURCE-INVENTORY.json'), sourceInventoryBytes(manifest));

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
		`${root}/toolchain/patches/50-rav1e-offline.patch`,
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
	case 'verify-release':
		if (args.length !== 0) fail('Usage: verify-release');
		await verifyRelease();
		console.log('FFmpeg release gate passed.');
		break;
	case 'print-evidence-bindings':
		if (args.length !== 0) fail('Usage: print-evidence-bindings');
		await printEvidenceBindings();
		break;
	default:
		fail(
			'Usage: ffmpeg-source-bundle.mjs <verify-package|verify-release|print-evidence-bindings|assemble|verify-bundle> ...',
		);
}
