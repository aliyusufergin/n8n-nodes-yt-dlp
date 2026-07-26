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
const vendoredFreetypeSources = new Map([
	[
		'25-freetype',
		{
			archive: '25-freetype_96c668248b384fe3a2875e4a9c9092cb746d1d243943f1367fdf9bee541681ff.tar.xz',
			archiveSha256: '282ec662fe205af227353f68dc8ff6ec89c7d0d73249aa961b8a7dc85409ce81',
		},
	],
	[
		'50-freetype',
		{
			archive: '50-freetype_96c668248b384fe3a2875e4a9c9092cb746d1d243943f1367fdf9bee541681ff.tar.xz',
			archiveSha256: '0a63de5f0a39d5537a59ff3a6f4acf905329235de124f9df26bc561d9f7f3d06',
		},
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

function cargoString(packageSection, key) {
	const match = packageSection.match(new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"])*")`, 'mu'));
	return match ? JSON.parse(match[1]) : undefined;
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
		const extractionRoot = join(temporaryRoot, component);
		await mkdir(extractionRoot, { recursive: true });
		const cargoManifestMembers =
			component === '50-rav1e'
				? members.filter((member) => /^\.\/vendor\/[^/]+\/Cargo\.toml$/u.test(member))
				: [];
		const cargoControlMembers = component === '50-rav1e' ? ['./Cargo.lock', './.cargo/config.toml'] : [];
		if (component === '50-rav1e' && cargoManifestMembers.length === 0) {
			throw new Error('The rav1e source archive does not contain vendored Cargo sources.');
		}
		for (const member of cargoControlMembers) {
			if (!members.includes(member)) throw new Error(`The rav1e source archive omits ${member}.`);
		}
		if (cargoManifestMembers.length > 0) {
			run('tar', ['-xJf', archivePath, '-C', extractionRoot, '--files-from=-'], {
				input: `${[...cargoManifestMembers, ...cargoControlMembers].join('\n')}\n`,
			});
		}
		const cargoPackages = [];
		const declaredCargoLicenses = [];
		for (const member of cargoManifestMembers) {
			const contents = await readFile(join(extractionRoot, member), 'utf8');
			const packageSection = contents.match(
				/^\[package\]\s*([\s\S]*?)(?=^\[|(?![\s\S]))/mu,
			)?.[1];
			if (!packageSection) throw new Error(`Missing [package] metadata in ${member}.`);
			const name = cargoString(packageSection, 'name');
			const version = cargoString(packageSection, 'version');
			const license = cargoString(packageSection, 'license');
			const licenseFile = cargoString(packageSection, 'license-file');
			if (!name || !version || (!license && !licenseFile)) {
				throw new Error(`Incomplete Cargo license metadata in ${member}.`);
			}
			const cargoRoot = dirname(member);
			if (licenseFile) declaredCargoLicenses.push(join(cargoRoot, licenseFile));
			cargoPackages.push({
				license: license ?? `SEE LICENSE IN ${licenseFile}`,
				name,
				sourcePath: cargoRoot,
				version,
			});
		}
		const licenseMembers = [
			...new Set([
				...members.filter(isLicenseMaterial),
				...(supplementalLicenseMembers.get(component) ?? []),
				...declaredCargoLicenses,
				...cargoManifestMembers,
			]),
		].sort();
		for (const member of licenseMembers) {
			if (!members.includes(member)) {
				throw new Error(`Missing supplemental license member ${member} in ${archiveName}.`);
			}
		}
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
		for (const cargoPackage of cargoPackages) {
			cargoPackage.licenseFiles = licenseFiles.filter((licensePath) =>
				licensePath.startsWith(
					`LICENSES/ffmpeg-static/${component}/${cargoPackage.sourcePath.slice(2)}/`,
				),
			);
			if (cargoPackage.licenseFiles.length === 0) {
				throw new Error(`No license material for Cargo package ${cargoPackage.name}.`);
			}
		}
		const sourceArchive = {
			licenseFiles,
			name: archiveName,
			sha256: digest(archiveBytes),
		};
		if (component === '50-rav1e') {
			sourceArchive.cargoVendor = {
				configSha256: digest(await readFile(join(extractionRoot, '.cargo', 'config.toml'))),
				lockSha256: digest(await readFile(join(extractionRoot, 'Cargo.lock'))),
				packageCount: cargoPackages.length,
			};
			sourceArchive.cargoPackages = cargoPackages;
			sourceArchive.input = 'input-root';
			sourceArchive.upstream = {
				archive: '50-rav1e_f5502fba0839b77e72f498941acc6b52cd25845005fff70a9f22bff369d96d24.tar.xz',
				archiveSha256: '20acab70634fd59187c6c9ed7dde0076909592e6ca1ead8e8872991ab83fa1f0',
				commit: '564ae3b0007ae2b06893fd7166bf88c5a84c5b63',
			};
		} else if (vendoredFreetypeSources.has(component)) {
			sourceArchive.input = 'input-root';
			sourceArchive.upstream = {
				...vendoredFreetypeSources.get(component),
				commit: '5336c0d4da22a13dab3389eb153b12672fdf841c',
			};
			sourceArchive.vendoredSubmodules = [
				{
					commit: '395ccad2c1e0daae535c4d20bb0a3f2424648e17',
					licenseFiles: [
						`LICENSES/ffmpeg-static/${component}/subprojects/dlg/LICENSE`,
					],
					path: 'subprojects/dlg',
					repository: 'https://github.com/nyorain/dlg.git',
				},
			];
		}
		sourceArchives.push(sourceArchive);
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
				'ghcr.io/yt-dlp/ffmpeg-builds/base-linux64@sha256:2d1b4af9d22653e1fa430b7cabd36f616bebbd6c1a1f93242008f3f6869e57cf',
			dependencyImage:
				'ghcr.io/yt-dlp/ffmpeg-builds/linux64-gpl@sha256:59abf3d43b3ae3acc15c2d3a04e9fc3c863292d38c233d878ef7070696a9c6c5',
		},
		cleanRebuildOutputs: {
			ffmpegSha256: 'b5532ca4ce06bef2fce593e89cd6bcb2be5fa89db6fa91e876b1c16c613502b1',
			ffprobeSha256: 'e6b5e3496cd160152898de6e86b4689fa6f2630ed7903725c50a5de3b7eeae3f',
		},
		manualReview: {
			path: 'toolchain/ffmpeg/LICENSE-REVIEW.json',
			requiredStatus: 'approved',
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
			sha256: '3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882',
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
