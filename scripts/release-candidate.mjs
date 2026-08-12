import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, '..');
const packageDirectories = ['packages/linux-x64', 'packages/platform-selector', '.'];
const packageNames = [
	'n8n-nodes-yt-dlp-linux-x64',
	'n8n-nodes-yt-dlp-platform',
	'n8n-nodes-yt-dlp',
];
const requiredLanes = [
	'source-delivery',
	'hermetic',
	'three-anchor',
	'multiworker',
	'capacity',
	'official-ejs',
	'live-canary',
	'registry-readback',
	'acceptance-stack',
];
const digestPattern = /^[0-9a-f]{64}$/u;
const provenancePredicateType = 'https://slsa.dev/provenance/v1';
const releaseRepository = 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp';
const releaseWorkflowPath = '.github/workflows/publish.yml';
const githubActionsIssuer = 'https://token.actions.githubusercontent.com';
const npmPublishEnvelopeLimitBytes = 250 * 1024 * 1024;
const npmPublishMetadataBudgetBytes = 1024 * 1024;
const hermeticImage =
	'node@sha256:8d3442d5f074940723be6eece34e992eb147ba1f59c73888e8f257918dea2e78';
const imageIdentitiesByLane = {
	'acceptance-stack': [
		'docker.n8n.io/n8nio/n8n@sha256:d91033b4fac2f7b75c5c4007e10824c66147f7d7a3cccb488720e97452ee7dc7',
	],
	capacity: [
		'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
	],
	multiworker: [
		'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
	],
	'three-anchor': [
		'docker.n8n.io/n8nio/n8n@sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795',
		'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1',
		'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
	],
};
const testIdentitiesByLane = {
	'acceptance-stack': 'n8n-2.34.5-acceptance-stack',
	'live-canary': 'YE7VzlLtp-4',
};

export async function verifySigstoreBundle(bundle, expectedIdentity = {}) {
	if (
		typeof bundle?.mediaType !== 'string' ||
		bundle.verificationMaterial === undefined ||
		!Array.isArray(bundle.dsseEnvelope?.signatures) ||
		bundle.dsseEnvelope.signatures.length === 0
	) {
		throw new Error('The Sigstore bundle is incomplete.');
	}
	if (
		expectedIdentity.certificateIssuer !== githubActionsIssuer ||
		typeof expectedIdentity.certificateIdentityURI !== 'string'
	) {
		throw new Error('The Sigstore certificate identity expectation is incomplete.');
	}
	const { verify } = await import('sigstore');
	const certificateIdentityURI = expectedIdentity.certificateIdentityURI.replace(
		/[.*+?^${}()|[\]\\]/gu,
		'\\$&',
	);
	await verify(bundle, {
		certificateIdentityURI: `^${certificateIdentityURI}$`,
		certificateIssuer: expectedIdentity.certificateIssuer,
	});
}

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

async function run(command, arguments_, options = {}) {
	return await execFileAsync(command, arguments_, {
		cwd: repositoryRoot,
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
}

function digest(algorithm, contents, encoding = 'hex') {
	return createHash(algorithm).update(contents).digest(encoding);
}

function canonicalJson(value) {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalJson(entry)]),
		);
	}
	return value;
}

export async function recompressPlatformTarball(tarballPath, temporaryRoot) {
	const { path7za } = require('7zip-bin');
	const tarPath = join(temporaryRoot, 'n8n-nodes-yt-dlp-linux-x64.tar');
	const optimizedPath = `${tarballPath}.optimized`;
	await pipeline(createReadStream(tarballPath), createGunzip(), createWriteStream(tarPath));
	await utimes(tarPath, 0, 0);
	await chmod(path7za, 0o755);
	await run(path7za, [
		'a',
		'-tgzip',
		'-mx=9',
		'-mfb=128',
		'-mpass=1',
		optimizedPath,
		tarPath,
	]);
	await rename(optimizedPath, tarballPath);
}

export function npmPublishEnvelopeBytes(tarballSizeBytes) {
	return Math.ceil(tarballSizeBytes / 3) * 4 + npmPublishMetadataBudgetBytes;
}

function assertPublishEnvelope(packageName, tarballSizeBytes) {
	if (npmPublishEnvelopeBytes(tarballSizeBytes) > npmPublishEnvelopeLimitBytes) {
		fail(`${packageName} exceeds the bounded npm publish request envelope.`);
	}
}

function jsonEqual(left, right) {
	return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function normalizeRegistry(registryArgument, operation) {
	const registry = registryArgument.replace(/\/+$/u, '');
	const registryUrl = new URL(registry);
	if (
		registryUrl.protocol !== 'https:' &&
		!(registryUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(registryUrl.hostname))
	) {
		fail(`${operation} requires HTTPS except for a local test registry.`);
	}
	return registry;
}

async function digestFile(path, algorithm = 'sha256', encoding = 'hex') {
	return digest(algorithm, await readFile(path), encoding);
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

function assertSafeArchivePath(path) {
	if (
		path.length === 0 ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.split('/').includes('..')
	) {
		fail(`Unsafe package archive path: ${path}`);
	}
}

async function packageContents(root, directory = root) {
	const contents = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const archivePath = relative(dirname(root), path).split(sep).join('/');
		assertSafeArchivePath(archivePath);
		const pathStat = await lstat(path);
		if (pathStat.isSymbolicLink()) fail(`Package contains a symbolic link: ${archivePath}`);
		if (pathStat.isDirectory()) {
			contents.push(...(await packageContents(root, path)));
			continue;
		}
		if (!pathStat.isFile()) fail(`Package contains a non-regular file: ${archivePath}`);
		contents.push({
			mode: pathStat.mode & 0o777,
			path: archivePath,
			sha256: await digestFile(path),
			sizeBytes: pathStat.size,
		});
	}
	return contents.sort((left, right) => left.path.localeCompare(right.path));
}

function assertLockstepMetadata(metadataByName, version) {
	const main = metadataByName.get('n8n-nodes-yt-dlp');
	const selector = metadataByName.get('n8n-nodes-yt-dlp-platform');
	const platform = metadataByName.get('n8n-nodes-yt-dlp-linux-x64');
	if (!main || !selector || !platform) fail('The three-package chain is incomplete.');
	for (const metadata of metadataByName.values()) {
		if (metadata.version !== version) fail(`${metadata.name} is not at exact version ${version}.`);
		if (JSON.stringify(metadata.os) !== '["linux"]' || JSON.stringify(metadata.cpu) !== '["x64"]') {
			fail(`${metadata.name} does not carry exact Linux x64 metadata.`);
		}
		if (metadata.libc !== undefined) fail(`${metadata.name} must not declare libc metadata.`);
		if (metadata.bin !== undefined) fail(`${metadata.name} must not create npm bin links.`);
		for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
			if (metadata.scripts?.[lifecycle] !== undefined) {
				fail(`${metadata.name} must not contain a ${lifecycle} lifecycle script.`);
			}
		}
	}
	if (main.dependencies?.['n8n-nodes-yt-dlp-platform'] !== version) {
		fail('The main package does not depend on the exact Platform Selector version.');
	}
	if (main.optionalDependencies !== undefined) {
		fail('The main package must use a normal Platform Selector dependency.');
	}
	if (selector.optionalDependencies?.['n8n-nodes-yt-dlp-linux-x64'] !== version) {
		fail('The Platform Selector does not select the exact Platform Package version.');
	}
	if (platform.license !== 'SEE LICENSE IN LICENSES.md') {
		fail('The Platform Package license surface is not explicit.');
	}
}

function assertDeclaredContents(metadata, packageEvidence) {
	const declared = metadata.files ?? [];
	for (const entry of packageEvidence.contents) {
		if ((entry.mode & 0o022) !== 0) {
			fail(`${metadata.name} contains a group/world-writable file: ${entry.path}`);
		}
		const path = entry.path.replace(/^package\//u, '');
		const automaticallyIncluded =
			path === 'package.json' || /^(?:readme|licen[cs]e)(?:$|\.)/iu.test(path);
		const declaredMatch = declared.some(
			(declaredPath) =>
				path === declaredPath || path.startsWith(`${declaredPath.replace(/\/+$/u, '')}/`),
		);
		if (!automaticallyIncluded && !declaredMatch) {
			fail(`${metadata.name} contains undeclared package content: ${path}`);
		}
	}
	for (const declaredPath of declared) {
		if (
			!packageEvidence.contents.some(({ path }) => {
				const relativePath = path.replace(/^package\//u, '');
				return (
					relativePath === declaredPath ||
					relativePath.startsWith(`${declaredPath.replace(/\/+$/u, '')}/`)
				);
			})
		) {
			fail(`${metadata.name} omits declared package content: ${declaredPath}`);
		}
	}
	const packageJson = packageEvidence.contents.find(({ path }) => path === 'package/package.json');
	if (packageJson?.mode !== 0o644) fail(`${metadata.name} package.json mode is not 0644.`);
}

function assertPlatformContents(packageEvidence, executionManifest) {
	const paths = new Set(packageEvidence.contents.map(({ path }) => path));
	for (const required of [
		'package/CORRESPONDING_SOURCE.md',
		'package/FFMPEG-SOURCE-MANIFEST.json',
		'package/LICENSES.md',
		'package/THIRD_PARTY_NOTICES.md',
		'package/TOOLCHAIN.lock.json',
		'package/execution-manifest.json',
	]) {
		if (!paths.has(required)) fail(`Platform Package omits ${required}.`);
	}
	for (const file of executionManifest.files) {
		const archivePath = `package/${file.path}`;
		const packagedFile = packageEvidence.contents.find(({ path }) => path === archivePath);
		if (!packagedFile) fail(`Platform Package omits manifest file ${file.path}.`);
		if (packagedFile.sha256 !== file.sha256) {
			fail(`Platform Package hash mismatch for ${file.path}.`);
		}
		const executable = (packagedFile.mode & 0o111) !== 0;
		if (executable !== file.mode.executable || (packagedFile.mode & 0o022) !== 0) {
			fail(`Platform Package mode mismatch for ${file.path}.`);
		}
	}
	if (!packageEvidence.contents.some(({ path }) => path.startsWith('package/LICENSES/'))) {
		fail('Platform Package has no verbatim license inventory.');
	}
}

async function buildCandidate(outputDirectory) {
	const outputRoot = resolve(outputDirectory);
	await mkdir(outputRoot, { recursive: true });
	if ((await readdir(outputRoot)).length !== 0) {
		fail(`Release candidate output directory is not empty: ${outputRoot}`);
	}
	const tarballRoot = join(outputRoot, 'tarballs');
	await mkdir(tarballRoot);

	await run('npm', ['run', 'build']);
	await run(process.execPath, ['scripts/ffmpeg-source-bundle.mjs', 'verify-package']);

	const rootMetadata = await readJson(join(repositoryRoot, 'package.json'));
	const version = rootMetadata.version;
	const commit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
	if (!/^[0-9a-f]{40}$/u.test(commit)) fail('The source commit is not an exact Git commit.');

	const packages = [];
	const metadataByName = new Map();
	const temporaryRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-package-inspection-'));
	try {
		for (const packageDirectory of packageDirectories) {
			const { stdout } = await run('npm', [
				'pack',
				packageDirectory === '.' ? '.' : `./${packageDirectory}`,
				'--json',
				'--ignore-scripts',
				'--pack-destination',
				tarballRoot,
			]);
			const result = JSON.parse(stdout);
			const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
			if (!packed?.filename) fail(`npm pack returned no tarball for ${packageDirectory}.`);
			const tarballPath = join(tarballRoot, packed.filename);
			if (packageDirectory === 'packages/linux-x64') {
				await recompressPlatformTarball(tarballPath, temporaryRoot);
			}
			const members = (await run('tar', ['-tzf', tarballPath])).stdout.split('\n').filter(Boolean);
			for (const member of members) assertSafeArchivePath(member.replace(/\/$/u, ''));
			const extractionRoot = join(temporaryRoot, String(packages.length));
			await mkdir(extractionRoot);
			await run('tar', ['-xzf', tarballPath, '-C', extractionRoot]);
			const packageRoot = join(extractionRoot, 'package');
			const metadata = await readJson(join(packageRoot, 'package.json'));
			metadataByName.set(metadata.name, metadata);
			const tarballBytes = await readFile(tarballPath);
			assertPublishEnvelope(metadata.name, tarballBytes.byteLength);
			const contents = await packageContents(packageRoot);
			if (contents.some(({ path }) => path.includes('/node_modules/'))) {
				fail(`${metadata.name} contains node_modules.`);
			}
			packages.push({
				contents,
				integrity: `sha512-${digest('sha512', tarballBytes, 'base64')}`,
				name: metadata.name,
				sha256: digest('sha256', tarballBytes),
				sizeBytes: tarballBytes.byteLength,
				tarball: packed.filename,
				version: metadata.version,
			});
		}
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
	}

	if (JSON.stringify(packages.map(({ name }) => name)) !== JSON.stringify(packageNames)) {
		fail('npm pack did not produce the dependency-ordered three-package chain.');
	}
	assertLockstepMetadata(metadataByName, version);
	for (const packageEvidence of packages) {
		assertDeclaredContents(metadataByName.get(packageEvidence.name), packageEvidence);
	}

	const platformRoot = join(repositoryRoot, 'packages', 'linux-x64');
	const [toolchainLock, executionManifest, sourceManifest] = await Promise.all([
		readJson(join(platformRoot, 'TOOLCHAIN.lock.json')),
		readJson(join(platformRoot, 'execution-manifest.json')),
		readJson(join(platformRoot, 'FFMPEG-SOURCE-MANIFEST.json')),
	]);
	if (
		toolchainLock.packageVersion !== version ||
		executionManifest.packageVersion !== version ||
		sourceManifest.sourceBundle.sha256 === undefined
	) {
		fail('The Platform Package manifests are not bound to the candidate version.');
	}
	assertPlatformContents(packages[0], executionManifest);

	const sourceBundles = toolchainLock.components.flatMap((component) =>
		[component.sourceBundle, component.sourceGate?.bundle]
			.filter((bundle) => bundle?.url !== undefined)
			.map(({ name, sha256, url }) => ({
				checksumUrl: `${url}.sha256`,
				name,
				sha256,
				url,
			})),
	);
	for (const bundle of sourceBundles) {
		if (
			!digestPattern.test(bundle.sha256) ||
			!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v[^/]+\//u.test(bundle.url)
		) {
			fail(`Corresponding Source is not direct and immutable: ${bundle.name}`);
		}
	}
	if (sourceBundles.length === 0) fail('No direct immutable Corresponding Source was recorded.');

	const expectedRegistry = Object.fromEntries(
		packages.map((packageEvidence) => {
			const metadata = metadataByName.get(packageEvidence.name);
			return [
				packageEvidence.name,
				{
					bin: metadata.bin ?? null,
					cpu: metadata.cpu ?? null,
					dependencies: metadata.dependencies ?? {},
					files: metadata.files ?? [],
					integrity: packageEvidence.integrity,
					libc: metadata.libc ?? null,
					license: metadata.license,
					optionalDependencies: metadata.optionalDependencies ?? {},
					os: metadata.os ?? null,
					sha256: packageEvidence.sha256,
					scripts: metadata.scripts ?? {},
					tarball: packageEvidence.tarball,
					version: packageEvidence.version,
				},
			];
		}),
	);
	const releaseRef = process.env.RELEASE_WORKFLOW_REF ?? 'refs/heads/main';
	if (!/^refs\/(?:heads|tags)\/[^\s]+$/u.test(releaseRef)) {
		fail('The release candidate has no exact GitHub workflow ref.');
	}

	const candidate = {
		schemaVersion: 1,
		version,
		commit,
		createdAt: new Date().toISOString(),
		expectedRegistry: {
			packages: expectedRegistry,
			provenance: {
				builderId: 'https://github.com/actions/runner/github-hosted',
				certificateIdentityURI: `${releaseRepository}/${releaseWorkflowPath}@${releaseRef}`,
				certificateIssuer: githubActionsIssuer,
				commit,
				predicateType: provenancePredicateType,
				workflow: {
					path: releaseWorkflowPath,
					repository: releaseRepository,
				},
			},
		},
		packages,
		rollback: {
			order: ['n8n-nodes-yt-dlp', 'n8n-nodes-yt-dlp-platform', 'n8n-nodes-yt-dlp-linux-x64'],
			strategy: 'dist-tags-deprecation-new-patch',
			unpublish: false,
		},
		source: {
			bundles: sourceBundles,
			cleanRebuildEvidenceSha256: await digestFile(
				join(repositoryRoot, 'toolchain', 'ffmpeg', 'REBUILD-EVIDENCE.json'),
			),
			manualReviewEvidenceSha256: await digestFile(
				join(repositoryRoot, 'toolchain', 'ffmpeg', 'LICENSE-REVIEW.json'),
			),
			sourceManifestSha256: await digestFile(join(platformRoot, 'FFMPEG-SOURCE-MANIFEST.json')),
		},
		toolchain: {
			buildTools: {
				node: process.version,
				npm: (await run('npm', ['--version'])).stdout.trim(),
				sevenZip: (await readJson(require.resolve('7zip-bin/package.json'))).version,
			},
			components: toolchainLock.components.map(({ name }) => name),
			executionManifestSha256: await digestFile(join(platformRoot, 'execution-manifest.json')),
			lockSha256: await digestFile(join(platformRoot, 'TOOLCHAIN.lock.json')),
		},
	};
	await writeFile(
		join(outputRoot, 'release-candidate.json'),
		`${JSON.stringify(candidate, null, 2)}\n`,
	);

	const provenance = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: packages.map(({ name, sha256, version: packageVersion }) => ({
			name: `pkg:npm/${name}@${packageVersion}`,
			digest: { sha256 },
		})),
		predicateType: 'https://slsa.dev/provenance/v1',
		predicate: {
			buildDefinition: {
				buildType:
					'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/.github/workflows/publish.yml@v1',
				externalParameters: { version },
				internalParameters: { commit },
				resolvedDependencies: [],
			},
			runDetails: {
				builder: { id: 'https://github.com/actions/runner' },
				metadata: { invocationId: process.env.GITHUB_RUN_ID ?? 'local' },
			},
		},
	};
	await writeFile(
		join(outputRoot, 'build-provenance.json'),
		`${JSON.stringify(provenance, null, 2)}\n`,
	);
	process.stdout.write(`${JSON.stringify({ commit, outputRoot, version })}\n`);
}

export async function verifyCandidate(candidateDirectory) {
	const candidateRoot = resolve(candidateDirectory);
	const candidate = await readJson(join(candidateRoot, 'release-candidate.json'));
	if (
		candidate.schemaVersion !== 1 ||
		typeof candidate.version !== 'string' ||
		!Array.isArray(candidate.packages) ||
		JSON.stringify(candidate.packages.map(({ name }) => name)) !== JSON.stringify(packageNames)
	) {
		fail('Release Candidate Chain manifest is invalid.');
	}
	if (
		candidate.rollback?.unpublish !== false ||
		candidate.rollback?.strategy !== 'dist-tags-deprecation-new-patch'
	) {
		fail('Release Candidate rollback policy must prohibit unpublish.');
	}
	if (
		candidate.expectedRegistry?.provenance?.builderId !==
			'https://github.com/actions/runner/github-hosted' ||
		candidate.expectedRegistry.provenance.certificateIssuer !== githubActionsIssuer ||
		!/^https:\/\/github\.com\/aliyusufergin\/n8n-nodes-yt-dlp\/\.github\/workflows\/publish\.yml@refs\/(?:heads|tags)\/[^\s]+$/u.test(
			candidate.expectedRegistry.provenance.certificateIdentityURI,
		) ||
		candidate.expectedRegistry.provenance.commit !== candidate.commit ||
		candidate.expectedRegistry.provenance.predicateType !== provenancePredicateType ||
		candidate.expectedRegistry.provenance.workflow?.repository !== releaseRepository ||
		candidate.expectedRegistry.provenance.workflow?.path !== releaseWorkflowPath
	) {
		fail('Release Candidate registry provenance expectation is invalid.');
	}
	const metadataByName = new Map();
	const temporaryRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-candidate-verification-'));
	try {
		for (const [index, packageEvidence] of candidate.packages.entries()) {
			if (
				basename(packageEvidence.tarball) !== packageEvidence.tarball ||
				packageEvidence.version !== candidate.version ||
				!digestPattern.test(packageEvidence.sha256)
			) {
				fail(`${packageEvidence.name} package evidence is invalid.`);
			}
			const tarballPath = join(candidateRoot, 'tarballs', packageEvidence.tarball);
			const tarballBytes = await readFile(tarballPath);
			if (digest('sha256', tarballBytes) !== packageEvidence.sha256) {
				fail(`${packageEvidence.name} tarball digest mismatch.`);
			}
			if (tarballBytes.byteLength !== packageEvidence.sizeBytes) {
				fail(`${packageEvidence.name} tarball size mismatch.`);
			}
			const expected = candidate.expectedRegistry?.packages?.[packageEvidence.name];
			if (
				expected?.version !== packageEvidence.version ||
				expected.tarball !== packageEvidence.tarball ||
				expected.sha256 !== packageEvidence.sha256 ||
				expected.integrity !== `sha512-${digest('sha512', tarballBytes, 'base64')}`
			) {
				fail(`${packageEvidence.name} registry read-back expectation mismatch.`);
			}
			const members = (await run('tar', ['-tzf', tarballPath])).stdout.split('\n').filter(Boolean);
			for (const member of members) assertSafeArchivePath(member.replace(/\/$/u, ''));
			const extractionRoot = join(temporaryRoot, String(index));
			await mkdir(extractionRoot);
			await run('tar', ['-xzf', tarballPath, '-C', extractionRoot]);
			const packageRoot = join(extractionRoot, 'package');
			const metadata = await readJson(join(packageRoot, 'package.json'));
			metadataByName.set(metadata.name, metadata);
			if (!jsonEqual(await packageContents(packageRoot), packageEvidence.contents)) {
				fail(`${packageEvidence.name} package contents do not match the candidate manifest.`);
			}
			if (
				!jsonEqual(metadata.dependencies ?? {}, expected.dependencies) ||
				!jsonEqual(metadata.optionalDependencies ?? {}, expected.optionalDependencies) ||
				!jsonEqual(metadata.files ?? [], expected.files) ||
				!jsonEqual(metadata.scripts ?? {}, expected.scripts) ||
				!jsonEqual(metadata.os ?? null, expected.os) ||
				!jsonEqual(metadata.cpu ?? null, expected.cpu) ||
				!jsonEqual(metadata.bin ?? null, expected.bin) ||
				!jsonEqual(metadata.libc ?? null, expected.libc) ||
				metadata.license !== expected.license
			) {
				fail(`${packageEvidence.name} package metadata does not match the candidate manifest.`);
			}
		}
		assertLockstepMetadata(metadataByName, candidate.version);
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
	}
	process.stdout.write(
		`${JSON.stringify({ commit: candidate.commit, version: candidate.version })}\n`,
	);
	return candidate;
}

function candidatePackageIdentities(candidate) {
	return candidate.packages.map(({ name, sha256, version }) => ({
		name,
		sha256,
		version,
	}));
}

async function verifiedProvenanceStatements(document, verifyBundle) {
	const attestations = Array.isArray(document?.attestations) ? document.attestations : [];
	const statements = [];
	for (const { bundle, predicateType } of attestations) {
		if (predicateType !== provenancePredicateType) continue;
		try {
			await verifyBundle(bundle);
		} catch {
			fail('Registry provenance Sigstore signature verification failed.');
		}
		const envelope = bundle?.dsseEnvelope;
		if (
			envelope?.payloadType !== 'application/vnd.in-toto+json' ||
			typeof envelope.payload !== 'string'
		) {
			fail('Registry provenance has no valid DSSE in-toto payload.');
		}
		statements.push(JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')));
	}
	return statements;
}

export async function verifyRegistryProvenance(
	url,
	packageEvidence,
	candidate,
	verifyBundle = verifySigstoreBundle,
) {
	const provenanceUrl = new URL(url);
	if (
		provenanceUrl.protocol !== 'https:' &&
		!(
			provenanceUrl.protocol === 'http:' &&
			['127.0.0.1', 'localhost'].includes(provenanceUrl.hostname)
		)
	) {
		fail(`${packageEvidence.name} registry provenance URL is not secure.`);
	}
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		fail(`${packageEvidence.name} registry provenance returned HTTP ${response.status}.`);
	}
	const expectedProvenance = candidate.expectedRegistry.provenance;
	const statements = await verifiedProvenanceStatements(
		await response.json(),
		async (bundle) =>
			await verifyBundle(bundle, {
				certificateIdentityURI: expectedProvenance.certificateIdentityURI,
				certificateIssuer: expectedProvenance.certificateIssuer,
			}),
	);
	const expectedSha512 = Buffer.from(
		candidate.expectedRegistry.packages[packageEvidence.name].integrity.slice('sha512-'.length),
		'base64',
	).toString('hex');
	const matchingStatement = statements.find((statement) => {
		if (
			statement.predicateType !== expectedProvenance.predicateType ||
			!Array.isArray(statement.subject)
		) {
			return false;
		}
		const matchingSubject = statement.subject.some(
			(subject) =>
				[packageEvidence.tarball, `pkg:npm/${packageEvidence.name}@${candidate.version}`].includes(
					subject.name,
				) &&
				(subject.digest?.sha256 === packageEvidence.sha256 ||
					subject.digest?.sha512 === expectedSha512),
		);
		const buildDefinition = statement.predicate?.buildDefinition;
		const workflow = buildDefinition?.externalParameters?.workflow;
		const commitBound = buildDefinition?.resolvedDependencies?.some(
			({ digest: resolvedDigest }) => resolvedDigest?.gitCommit === expectedProvenance.commit,
		);
		return (
			matchingSubject &&
			workflow?.repository === expectedProvenance.workflow.repository &&
			workflow?.path?.replace(/^\/+/u, '') === expectedProvenance.workflow.path &&
			commitBound &&
			statement.predicate?.runDetails?.builder?.id === expectedProvenance.builderId
		);
	});
	if (matchingStatement === undefined) {
		fail(`${packageEvidence.name} registry provenance is not candidate-bound.`);
	}
}

export async function verifyRegistry(
	candidateDirectory,
	registryArgument,
	outputPath,
	{ allowInitialLatest = false, materializeDirectory, verifyBundle = verifySigstoreBundle } = {},
) {
	const candidateRoot = resolve(candidateDirectory);
	const candidate = await verifyCandidate(candidateRoot);
	const candidateBytes = await readFile(join(candidateRoot, 'release-candidate.json'));
	const registry = normalizeRegistry(registryArgument, 'Registry read-back');
	const materializedRoot =
		materializeDirectory === undefined ? undefined : resolve(materializeDirectory);
	if (materializedRoot !== undefined) {
		await mkdir(materializedRoot);
		await mkdir(join(materializedRoot, 'tarballs'));
		await writeFile(join(materializedRoot, 'release-candidate.json'), candidateBytes);
	}
	const packages = [];
	for (const packageEvidence of candidate.packages) {
		const expected = candidate.expectedRegistry.packages[packageEvidence.name];
		const packageUrl = `${registry}/${encodeURIComponent(packageEvidence.name)}`;
		const packumentResponse = await fetch(packageUrl, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!packumentResponse.ok) {
			fail(
				`${packageEvidence.name} next tag read-back returned HTTP ${packumentResponse.status}.`,
			);
		}
		const packument = await packumentResponse.json();
		if (packument['dist-tags']?.next !== candidate.version) {
			fail(`${packageEvidence.name} next does not identify ${candidate.version}.`);
		}
		const publishedVersions = Object.keys(packument.versions ?? {});
		const exactInitialPublication =
			packument['dist-tags']?.latest === candidate.version &&
			publishedVersions.length === 1 &&
			publishedVersions[0] === candidate.version;
		if (allowInitialLatest && !exactInitialPublication) {
			fail(`${packageEvidence.name} bootstrap registry state is not an exact initial publication.`);
		}
		if (!allowInitialLatest && packument['dist-tags']?.latest === candidate.version) {
			fail(`${packageEvidence.name} latest unexpectedly identifies ${candidate.version}.`);
		}
		const metadataResponse = await fetch(
			`${packageUrl}/${packageEvidence.version}`,
			{ signal: AbortSignal.timeout(30_000) },
		);
		if (!metadataResponse.ok) {
			fail(`${packageEvidence.name} registry metadata returned HTTP ${metadataResponse.status}.`);
		}
		const metadata = await metadataResponse.json();
		if (
			metadata.name !== packageEvidence.name ||
			metadata.version !== packageEvidence.version ||
			!jsonEqual(metadata.dependencies ?? {}, expected.dependencies) ||
			!jsonEqual(metadata.optionalDependencies ?? {}, expected.optionalDependencies) ||
			!jsonEqual(metadata.scripts ?? {}, expected.scripts) ||
			!jsonEqual(metadata.os ?? null, expected.os) ||
			!jsonEqual(metadata.cpu ?? null, expected.cpu) ||
			!jsonEqual(metadata.bin ?? null, expected.bin) ||
			!jsonEqual(metadata.libc ?? null, expected.libc) ||
			metadata.license !== expected.license ||
			metadata.dist?.integrity !== expected.integrity ||
			metadata.dist?.attestations?.provenance?.predicateType !== provenancePredicateType ||
			typeof metadata.dist?.attestations?.url !== 'string'
		) {
			fail(`${packageEvidence.name} registry metadata or provenance mismatch.`);
		}
		await verifyRegistryProvenance(
			metadata.dist.attestations.url,
			packageEvidence,
			candidate,
			verifyBundle,
		);
		const tarballResponse = await fetch(metadata.dist.tarball, {
			signal: AbortSignal.timeout(600_000),
		});
		if (!tarballResponse.ok) {
			fail(`${packageEvidence.name} registry tarball returned HTTP ${tarballResponse.status}.`);
		}
		const tarball = Buffer.from(await tarballResponse.arrayBuffer());
		if (
			digest('sha256', tarball) !== packageEvidence.sha256 ||
			`sha512-${digest('sha512', tarball, 'base64')}` !== expected.integrity
		) {
			fail(`${packageEvidence.name} registry tarball digest mismatch.`);
		}
		if (materializedRoot !== undefined) {
			await writeFile(join(materializedRoot, 'tarballs', packageEvidence.tarball), tarball);
		}
		packages.push({
			name: packageEvidence.name,
			provenance: provenancePredicateType,
			sha256: packageEvidence.sha256,
		});
	}
	const readback = {
		schemaVersion: 1,
		candidateSha256: digest('sha256', candidateBytes),
		completedAt: new Date().toISOString(),
		diagnostics: [`registry-packages=${packages.length}`],
		identities: {
			packages: candidatePackageIdentities(candidate),
			registry,
			source: candidate.source,
			test: { id: 'registry-readback' },
			toolchain: candidate.toolchain,
		},
		lane: 'registry-readback',
		outcome: 'pass',
		packages,
		region: requiredRegion(),
		registry,
		version: candidate.version,
		waived: false,
	};
	const readbackBytes = `${JSON.stringify(readback, null, 2)}\n`;
	await writeFile(resolve(outputPath), readbackBytes);
	if (materializedRoot !== undefined) {
		await writeFile(join(materializedRoot, 'registry-readback.json'), readbackBytes);
		await verifyCandidate(materializedRoot);
	}
	process.stdout.write(`${JSON.stringify({ packages: packages.length, registry })}\n`);
}

async function auditRegistry(candidatePath, registryArgument, outputPath) {
	const candidateBytes = await readFile(resolve(candidatePath));
	const candidate = JSON.parse(candidateBytes);
	if (
		candidate.schemaVersion !== 1 ||
		typeof candidate.version !== 'string' ||
		!Array.isArray(candidate.packages) ||
		JSON.stringify(candidate.packages.map(({ name }) => name)) !== JSON.stringify(packageNames)
	) {
		fail('Release Candidate Chain manifest is invalid.');
	}
	const registry = normalizeRegistry(registryArgument, 'Registry audit');
	const published = [];
	const missing = [];
	const unexpected = [];
	for (const packageEvidence of candidate.packages) {
		try {
			const response = await fetch(
				`${registry}/${encodeURIComponent(packageEvidence.name)}/${candidate.version}`,
				{ signal: AbortSignal.timeout(30_000) },
			);
			if (response.ok) {
				published.push(packageEvidence.name);
			} else if (response.status === 404) {
				missing.push(packageEvidence.name);
			} else {
				unexpected.push({ name: packageEvidence.name, status: response.status });
			}
		} catch {
			unexpected.push({ name: packageEvidence.name, status: 'network-error' });
		}
	}
	const audit = {
		schemaVersion: 1,
		candidateSha256: digest('sha256', candidateBytes),
		completedAt: new Date().toISOString(),
		missing,
		published,
		registry,
		unexpected,
		version: candidate.version,
	};
	await writeFile(resolve(outputPath), `${JSON.stringify(audit, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify(audit)}\n`);
}

async function recordGate(candidatePath, lane, outputPath, identitiesPath) {
	if (!requiredLanes.includes(lane) || ['live-canary', 'registry-readback'].includes(lane)) {
		fail(`The ${lane} lane must use its dedicated evidence producer.`);
	}
	const candidateBytes = await readFile(resolve(candidatePath));
	const candidate = JSON.parse(candidateBytes);
	const definitionBytes =
		identitiesPath === undefined ? undefined : await readFile(resolve(identitiesPath));
	const definition = definitionBytes === undefined ? undefined : JSON.parse(definitionBytes);
	const images = definition?.anchors
		?.map(({ image }) => image)
		.filter((image) => typeof image === 'string');
	const identities = {
		...(images?.length > 0 ? { images } : {}),
		...(definition?.isolation === undefined ? {} : { isolation: definition.isolation }),
		packages: candidatePackageIdentities(candidate),
		source: candidate.source,
		test: {
			id: lane,
			...(definitionBytes === undefined
				? {}
				: {
						definition,
						definitionSha256: digest('sha256', definitionBytes),
					}),
		},
		toolchain: candidate.toolchain,
	};
	const evidence = {
		schemaVersion: 1,
		candidateSha256: digest('sha256', candidateBytes),
		completedAt: new Date().toISOString(),
		diagnostics: redactedDiagnostics([process.env.GATE_DIAGNOSTIC ?? `${lane}=passed`]),
		identities,
		lane,
		outcome: 'pass',
		region: requiredRegion(),
		waived: false,
	};
	await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ lane, outcome: 'pass' })}\n`);
}

function redactedDiagnostics(diagnostics) {
	if (!Array.isArray(diagnostics) || diagnostics.length > 16) {
		fail('Gate diagnostics must be an array with at most 16 entries.');
	}
	return diagnostics.map((diagnostic) => {
		if (typeof diagnostic !== 'string') fail('Gate diagnostics must contain only strings.');
		return diagnostic
			.slice(0, 2_048)
			.replace(/:\/\/[^/@\s]+:[^/@\s]+@/gu, '://[REDACTED]@')
			.replace(
				/\b(cookie|password|proxy|secret|token)(?:=|:\s*)("[^"]*"|[^\s,;]+)/giu,
				'$1=[REDACTED]',
			);
	});
}

function validateGateIdentities(identities, lane, candidate) {
	if (!jsonEqual(identities?.packages, candidatePackageIdentities(candidate))) {
		fail(`${lane} evidence package identities do not match the candidate.`);
	}
	if (!jsonEqual(identities.source, candidate.source)) {
		fail(`${lane} evidence source identity does not match the candidate.`);
	}
	const toolchainIdentity = { ...identities.toolchain };
	const versions = toolchainIdentity.versions;
	delete toolchainIdentity.versions;
	if (!jsonEqual(toolchainIdentity, candidate.toolchain)) {
		fail(`${lane} evidence tool identity does not match the candidate.`);
	}
	if (
		lane === 'live-canary' &&
		(!jsonEqual(Object.keys(versions ?? {}).sort(), ['deno', 'ffmpeg', 'yt-dlp', 'yt-dlp-ejs']) ||
			Object.values(versions).some((version) => typeof version !== 'string' || version.length === 0))
	) {
		fail('live-canary evidence has no exact tool versions.');
	}
	const expectedTestIdentity = testIdentitiesByLane[lane] ?? lane;
	if (identities.test?.id !== expectedTestIdentity) {
		fail(`${lane} evidence has the wrong test identity.`);
	}
	const expectedImages = imageIdentitiesByLane[lane];
	if (
		expectedImages !== undefined &&
		(!Array.isArray(identities.images) ||
			!jsonEqual([...identities.images].sort(), [...expectedImages].sort()))
	) {
		fail(`${lane} evidence has the wrong official n8n image identity.`);
	}
	if (
		lane === 'hermetic' &&
		(identities.isolation?.network !== 'none' ||
			identities.isolation?.image !== hermeticImage)
	) {
		fail('hermetic evidence has no exact egress-denied isolation identity.');
	}
}

function validateGateEvidence(evidence, lane, candidate, candidateSha256) {
	if (
		evidence.schemaVersion !== 1 ||
		evidence.lane !== lane ||
		evidence.outcome !== 'pass' ||
		evidence.waived !== false
	) {
		fail(`${lane} must pass without a waiver.`);
	}
	if (evidence.candidateSha256 !== candidateSha256) {
		fail(`${lane} evidence is not bound to this Release Candidate Chain.`);
	}
	if (
		Number.isNaN(Date.parse(evidence.completedAt)) ||
		typeof evidence.region !== 'string' ||
		evidence.region.length === 0 ||
		['n/a', 'unknown', 'unset'].includes(evidence.region.trim().toLowerCase())
	) {
		fail(`${lane} evidence has no valid time and region.`);
	}
	validateGateIdentities(evidence.identities, lane, candidate);
	return {
		...evidence,
		diagnostics: redactedDiagnostics(evidence.diagnostics),
	};
}

async function verifyGateEvidence(candidatePath, lane, evidencePath) {
	if (!requiredLanes.includes(lane)) fail(`Unknown release gate lane: ${lane}`);
	const candidateBytes = await readFile(resolve(candidatePath));
	const candidate = JSON.parse(candidateBytes);
	const evidence = await readJson(resolve(evidencePath));
	validateGateEvidence(evidence, lane, candidate, digest('sha256', candidateBytes));
	process.stdout.write(`${JSON.stringify({ lane, outcome: 'pass' })}\n`);
}

async function finalizeEvidence(candidatePath, evidenceDirectory, outputPath) {
	const candidateBytes = await readFile(resolve(candidatePath));
	const candidate = JSON.parse(candidateBytes);
	const candidateSha256 = digest('sha256', candidateBytes);
	const gates = [];
	for (const lane of requiredLanes) {
		const evidence = await readJson(join(resolve(evidenceDirectory), `${lane}.json`));
		gates.push(validateGateEvidence(evidence, lane, candidate, candidateSha256));
	}
	if (basename(outputPath) !== `release-evidence-${candidate.version}.json`) {
		fail('Release evidence output must be versioned.');
	}
	const releaseEvidence = {
		schemaVersion: 1,
		version: candidate.version,
		candidateSha256,
		completedAt: new Date().toISOString(),
		commit: candidate.commit,
		gates,
		packages: candidate.packages,
		source: candidate.source,
		toolchain: candidate.toolchain,
	};
	const resolvedOutput = resolve(outputPath);
	await mkdir(dirname(resolvedOutput), { recursive: true });
	const temporaryOutput = `${resolvedOutput}.tmp`;
	await writeFile(temporaryOutput, `${JSON.stringify(releaseEvidence, null, 2)}\n`);
	await rename(temporaryOutput, resolvedOutput);
	process.stdout.write(`${JSON.stringify({ candidateSha256, output: resolvedOutput })}\n`);
}

async function verifyBootstrapRetirement(candidatePath, evidencePath) {
	const candidateBytes = await readFile(resolve(candidatePath));
	const evidence = await readJson(resolve(evidencePath));
	const tokenCreatedAt = Date.parse(evidence.tokenCreatedAt);
	const tokenExpiresAt = Date.parse(evidence.tokenExpiresAt);
	const completedAt = Date.parse(evidence.completedAt);
	if (
		evidence.schemaVersion !== 1 ||
		evidence.candidateSha256 !== digest('sha256', candidateBytes) ||
		evidence.tokenRevoked !== true ||
		evidence.environmentSecretDeleted !== true ||
		evidence.tokenName !== 'n8n-nodes-yt-dlp-bootstrap-0.2.0' ||
		evidence.tokenType !== 'granular' ||
		evidence.packageAccess !== 'all-packages' ||
		evidence.packagePermissions !== 'read-write' ||
		evidence.organizationPermissions !== 'no-access' ||
		evidence.bypassTwoFactorAuthentication !== true ||
		evidence.environment !== 'npm-bootstrap' ||
		evidence.secretName !== 'NPM_BOOTSTRAP_TOKEN' ||
		evidence.verificationMethod !== 'operator-ui-read-back' ||
		evidence.waived !== false ||
		typeof evidence.actor !== 'string' ||
		evidence.actor.length === 0 ||
		Number.isNaN(tokenCreatedAt) ||
		Number.isNaN(tokenExpiresAt) ||
		Number.isNaN(completedAt) ||
		tokenExpiresAt <= tokenCreatedAt ||
		tokenExpiresAt - tokenCreatedAt > 24 * 60 * 60 * 1_000 ||
		completedAt < tokenCreatedAt ||
		completedAt > tokenExpiresAt
	) {
		fail('Bootstrap retirement must prove token revocation and environment-secret deletion.');
	}
	process.stdout.write(`${JSON.stringify({ actor: evidence.actor, outcome: 'pass' })}\n`);
}

async function verifyPromotion(candidateDirectory, registryArgument, outputPath) {
	const candidateRoot = resolve(candidateDirectory);
	const candidate = await verifyCandidate(candidateRoot);
	const candidateBytes = await readFile(join(candidateRoot, 'release-candidate.json'));
	const registry = normalizeRegistry(registryArgument, 'Promotion read-back');
	for (const packageEvidence of candidate.packages) {
		const response = await fetch(`${registry}/${encodeURIComponent(packageEvidence.name)}`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			fail(`${packageEvidence.name} promotion read-back returned HTTP ${response.status}.`);
		}
		const packument = await response.json();
		if (packument['dist-tags']?.latest !== candidate.version) {
			fail(`${packageEvidence.name} latest does not identify ${candidate.version}.`);
		}
	}
	const evidence = {
		schemaVersion: 1,
		candidateSha256: digest('sha256', candidateBytes),
		completedAt: new Date().toISOString(),
		diagnostics: [`latest-packages=${candidate.packages.length}`],
		outcome: 'pass',
		region: requiredRegion(),
		version: candidate.version,
		waived: false,
	};
	await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ outcome: 'pass', version: candidate.version })}\n`);
}

async function main() {
	const [command, ...arguments_] = process.argv.slice(2);
	switch (command) {
		case 'build':
			if (arguments_.length !== 1) fail('Usage: build <empty-output-directory>');
			await buildCandidate(arguments_[0]);
			break;
		case 'verify':
			if (arguments_.length !== 1) fail('Usage: verify <candidate-directory>');
			await verifyCandidate(arguments_[0]);
			break;
		case 'verify-registry':
			if (arguments_.length !== 3) {
				fail('Usage: verify-registry <candidate-directory> <registry-url> <output.json>');
			}
			await verifyRegistry(arguments_[0], arguments_[1], arguments_[2]);
			break;
		case 'verify-bootstrap-registry':
			if (arguments_.length !== 3) {
				fail('Usage: verify-bootstrap-registry <candidate-directory> <registry-url> <output.json>');
			}
			await verifyRegistry(arguments_[0], arguments_[1], arguments_[2], {
				allowInitialLatest: true,
			});
			break;
		case 'materialize-registry':
			if (arguments_.length !== 4) {
				fail(
					'Usage: materialize-registry <candidate-directory> <registry-url> <output-directory> <output.json>',
				);
			}
			await verifyRegistry(arguments_[0], arguments_[1], arguments_[3], {
				allowInitialLatest: true,
				materializeDirectory: arguments_[2],
			});
			break;
		case 'audit-registry':
			if (arguments_.length !== 3) {
				fail('Usage: audit-registry <candidate.json> <registry-url> <output.json>');
			}
			await auditRegistry(arguments_[0], arguments_[1], arguments_[2]);
			break;
		case 'record-gate':
			if (arguments_.length < 3 || arguments_.length > 4) {
				fail('Usage: record-gate <candidate.json> <lane> <output.json> [identities.json]');
			}
			await recordGate(arguments_[0], arguments_[1], arguments_[2], arguments_[3]);
			break;
		case 'verify-gate':
			if (arguments_.length !== 3) {
				fail('Usage: verify-gate <candidate.json> <lane> <evidence.json>');
			}
			await verifyGateEvidence(arguments_[0], arguments_[1], arguments_[2]);
			break;
		case 'verify-bootstrap-retirement':
			if (arguments_.length !== 2) {
				fail('Usage: verify-bootstrap-retirement <candidate.json> <evidence.json>');
			}
			await verifyBootstrapRetirement(arguments_[0], arguments_[1]);
			break;
		case 'verify-promotion':
			if (arguments_.length !== 3) {
				fail('Usage: verify-promotion <candidate-directory> <registry-url> <output.json>');
			}
			await verifyPromotion(arguments_[0], arguments_[1], arguments_[2]);
			break;
		case 'finalize-evidence':
			if (arguments_.length !== 3) {
				fail('Usage: finalize-evidence <candidate.json> <evidence-directory> <output.json>');
			}
			await finalizeEvidence(arguments_[0], arguments_[1], arguments_[2]);
			break;
		default:
			fail(
				'Usage: release-candidate.mjs <build|verify|verify-registry|verify-bootstrap-registry|materialize-registry|audit-registry|record-gate|verify-gate|verify-bootstrap-retirement|verify-promotion|finalize-evidence> ...',
			);
	}
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	await main();
}
