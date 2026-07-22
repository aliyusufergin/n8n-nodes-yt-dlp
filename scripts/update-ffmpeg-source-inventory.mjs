import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const expectedArchiveCount = 109;
const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceDirectory = resolve(process.argv[2] ?? '');
const licenseRoot = join(repositoryRoot, 'packages', 'linux-x64', 'LICENSES', 'ffmpeg-static');
const manifestPath = join(repositoryRoot, 'packages', 'linux-x64', 'FFMPEG-SOURCE-MANIFEST.json');
const supplementalLicenseMembers = new Map([
	['40-libdrm', ['./xf86drm.c', './xf86drmMode.c', './include/drm/drm.h']],
	[
		'50-ffnvcodec',
		[
			'./ffnvcodec/include/ffnvcodec/dynlink_cuda.h',
			'./ffnvcodec/include/ffnvcodec/dynlink_cuviddec.h',
			'./ffnvcodec/include/ffnvcodec/dynlink_loader.h',
			'./ffnvcodec/include/ffnvcodec/dynlink_nvcuvid.h',
			'./ffnvcodec/include/ffnvcodec/nvEncodeAPI.h',
		],
	],
]);

if (process.argv.length !== 3) {
	throw new Error(
		'Usage: node scripts/update-ffmpeg-source-inventory.mjs <source-archive-directory>',
	);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`${command} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function isLicenseMaterial(path) {
	return /^(?:copying|copyright|licen[cs]e|notice|patents)(?:$|[._-])/iu.test(basename(path));
}

function assertSafeArchivePath(path) {
	if (
		path.length === 0 ||
		path.startsWith('/') ||
		path.split('/').includes('..') ||
		path.includes('\\')
	) {
		throw new Error(`Unsafe source archive path: ${path}`);
	}
}

function digest(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

const archiveNames = (await readdir(sourceDirectory))
	.filter((name) => name.endsWith('.tar.xz'))
	.sort();
if (archiveNames.length !== expectedArchiveCount) {
	throw new Error(
		`Expected ${expectedArchiveCount} source archives, found ${archiveNames.length}.`,
	);
}

await rm(licenseRoot, { force: true, recursive: true });
const temporaryRoot = await mkdtemp(join(tmpdir(), 'n8n-ffmpeg-licenses-'));

try {
	const sourceArchives = [];
	for (const archiveName of archiveNames) {
		const archivePath = join(sourceDirectory, archiveName);
		const archiveBytes = await readFile(archivePath);
		const component = archiveName.replace(/_[0-9a-f]{64}\.tar\.xz$/u, '');
		if (component === archiveName)
			throw new Error(`Unexpected source archive name: ${archiveName}`);
		const members = run('tar', ['-tf', archivePath])
			.split('\n')
			.filter((path) => path.length > 0 && !path.endsWith('/'));
		for (const member of members) assertSafeArchivePath(member);
		const licenseMembers = [
			...new Set([
				...members.filter(isLicenseMaterial),
				...(supplementalLicenseMembers.get(component) ?? []),
			]),
		].sort();
		for (const member of licenseMembers) {
			if (!members.includes(member)) {
				throw new Error(`Missing supplemental license member ${member} in ${archiveName}.`);
			}
		}
		const extractionRoot = join(temporaryRoot, component);
		await mkdir(extractionRoot, { recursive: true });
		run('tar', ['-xJf', archivePath, '-C', extractionRoot, '--files-from=-'], {
			input: `${licenseMembers.join('\n')}\n`,
		});
		const licenseFiles = [];
		for (const member of licenseMembers) {
			const sourcePath = join(extractionRoot, member);
			const destinationPath = join(licenseRoot, component, member);
			const resolvedSourcePath = await realpath(sourcePath);
			const relativeSourcePath = relative(extractionRoot, resolvedSourcePath);
			if (relativeSourcePath === '..' || relativeSourcePath.startsWith(`..${sep}`)) {
				throw new Error(`License material escapes its source archive: ${member}`);
			}
			await mkdir(dirname(destinationPath), { recursive: true });
			await cp(resolvedSourcePath, destinationPath, { force: true });
			licenseFiles.push(relative(join(repositoryRoot, 'packages', 'linux-x64'), destinationPath));
		}
		sourceArchives.push({
			licenseFiles,
			name: archiveName,
			sha256: digest(archiveBytes),
		});
	}

	const manifest = {
		schemaVersion: 1,
		binaryBuild: {
			asset: 'ffmpeg-N-125551-ga09be9b91e-linux64-gpl.tar.xz',
			assetSha256: '7a19456683e31d937ae48d51e23dfb869dbb9db1e4d6e1b6881d7fed168fa5cf',
			ffmpegBuildsCommit: '832dd2f333d919790f117b054f628756c515adce',
			ffmpegCommit: 'a09be9b91e8e1219f297586873b0d7322b47df96',
			releaseTag: 'autobuild-2026-07-12-15-07',
			workflowRun: 29196749904,
		},
		buildContainer: {
			baseImage:
				'ghcr.io/yt-dlp/ffmpeg-builds/base-linux64@sha256:0fe9fc0b0831bc8c5a54705af7d8db2aac69c69e399c44f61d28989109a961cf',
			dependencyImage:
				'ghcr.io/yt-dlp/ffmpeg-builds/linux64-gpl@sha256:59abf3d43b3ae3acc15c2d3a04e9fc3c863292d38c233d878ef7070696a9c6c5',
		},
		manualReview: {
			path: 'toolchain/ffmpeg/MANUAL-LICENSE-REVIEW.md',
			status: 'approved',
		},
		primarySources: [
			{
				name: 'FFmpeg-a09be9b91e8e1219f297586873b0d7322b47df96.tar.gz',
				sha256: '3fe15a719da7d3da25e56eabb5d27153bf1a096a44b58f327dda172f421c6309',
			},
			{
				name: 'FFmpeg-Builds-832dd2f333d919790f117b054f628756c515adce.tar.gz',
				sha256: 'd8c8cbe110050b995600ed3a897c71b7e3c00ade2830caf2f9bad9b28dbf9dae',
			},
		],
		sourceArchives,
		sourceBundle: {
			name: 'n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz',
			sha256: '6576eef8e990c7da69b18d37f17f318ebc832365c50fd62a8a473240a6e62d54',
			url: 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz',
		},
		sourceCache: {
			actionsArtifactId: 8261218390,
			name: 'cache.tar.gz',
			sha256: 'dfdb5701382b753efb0ad8cb724dfd7bdef3c1238f1d0dc3cbf20d06b854c1af',
		},
	};
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
} finally {
	await rm(temporaryRoot, { force: true, recursive: true });
}
