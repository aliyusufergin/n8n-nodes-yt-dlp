import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.argv[2] ?? '.');
const generatedRoot = resolve(process.argv[3] ?? 'e2e/n8n-2.27.4/.generated');
const registryRoot = join(generatedRoot, 'registry');
const tarballRoot = join(registryRoot, 'tarballs');
const certificateRoot = join(registryRoot, 'certs');
const fixtureRoot = join(generatedRoot, 'fixtures');
const evidenceRoot = join(generatedRoot, 'evidence');
// The prepared registry publishes the version this repository releases, so a release bump does not
// need every lane script edited in lockstep.
const packageVersion = JSON.parse(
	await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
).version;
const candidateRoot = process.env.E2E_RELEASE_CANDIDATE_ROOT
	? resolve(process.env.E2E_RELEASE_CANDIDATE_ROOT)
	: undefined;
const requirePublishedNext = process.env.E2E_REQUIRE_PUBLISHED_NEXT === 'true';

async function run(command, arguments_, options = {}) {
	return await execFileAsync(command, arguments_, {
		cwd: repositoryRoot,
		maxBuffer: 20 * 1024 * 1024,
		...options,
	});
}

function digest(algorithm, body) {
	return createHash(algorithm).update(body).digest('hex');
}

await rm(generatedRoot, { force: true, recursive: true });
await Promise.all(
	[tarballRoot, certificateRoot, fixtureRoot, evidenceRoot].map(
		async (directory) => await mkdir(directory, { recursive: true }),
	),
);

const packageEvidence = [];
const registry = {};

async function addPackage(
	packageJson,
	tarballName,
	evidence,
	distTags = { latest: packageVersion, next: packageVersion },
) {
	const tarballPath = join(tarballRoot, tarballName);
	const body = await readFile(tarballPath);
	const tarballUrl = `https://registry.npmjs.org/${packageJson.name}/-/${tarballName}`;
	const metadata = {
		...packageJson,
		dist: {
			integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
			shasum: digest('sha1', body),
			tarball: tarballUrl,
		},
	};
	registry[packageJson.name] = {
		'dist-tags': distTags,
		name: packageJson.name,
		versions: { [packageVersion]: metadata },
	};
	packageEvidence.push({
		name: packageJson.name,
		sha256: evidence?.sha256 ?? digest('sha256', body),
		sizeBytes: body.byteLength,
		tarball: tarballName,
		version: packageJson.version,
	});
}

if (candidateRoot === undefined) {
	await run('npm', ['run', 'build']);
	for (const packageDirectory of ['./packages/linux-x64', './packages/platform-selector', '.']) {
		const { stdout } = await run('npm', [
			'pack',
			packageDirectory,
			'--ignore-scripts',
			'--loglevel=error',
			'--pack-destination',
			tarballRoot,
		]);
		const packageJson = JSON.parse(
			await readFile(join(repositoryRoot, packageDirectory, 'package.json'), 'utf8'),
		);
		if (packageJson.version !== packageVersion) {
			throw new Error(`Unexpected package version for ${packageDirectory}.`);
		}
		const tarballName = stdout.trim().split(/\r?\n/u).at(-1);
		if (!tarballName?.endsWith('.tgz')) {
			throw new Error(`Unexpected npm pack output for ${packageDirectory}.`);
		}
		await addPackage(packageJson, tarballName);
	}
} else {
	await run(process.execPath, ['scripts/release-candidate.mjs', 'verify', candidateRoot]);
	const candidate = JSON.parse(
		await readFile(join(candidateRoot, 'release-candidate.json'), 'utf8'),
	);
	if (candidate.version !== packageVersion) {
		throw new Error(`Unexpected Release Candidate version ${candidate.version}.`);
	}
	for (const evidence of candidate.packages) {
		const sourceTarball = join(candidateRoot, 'tarballs', evidence.tarball);
		const destinationTarball = join(tarballRoot, evidence.tarball);
		let distTags;
		if (requirePublishedNext) {
			const packumentResponse = await fetch(
				`https://registry.npmjs.org/${encodeURIComponent(evidence.name)}`,
				{ signal: AbortSignal.timeout(30_000) },
			);
			if (!packumentResponse.ok) {
				throw new Error(
					`${evidence.name} public packument returned HTTP ${packumentResponse.status}.`,
				);
			}
			const packument = await packumentResponse.json();
			distTags = packument['dist-tags'];
			const published = packument.versions?.[candidate.version];
			if (
				packument['dist-tags']?.next !== candidate.version ||
				published?.dist?.integrity !== candidate.expectedRegistry.packages[evidence.name]?.integrity
			) {
				throw new Error(`${evidence.name}@${candidate.version} is not the exact public next.`);
			}
			const tarballResponse = await fetch(published.dist.tarball, {
				signal: AbortSignal.timeout(120_000),
			});
			if (!tarballResponse.ok) {
				throw new Error(`${evidence.name} public tarball returned HTTP ${tarballResponse.status}.`);
			}
			const publicTarball = Buffer.from(await tarballResponse.arrayBuffer());
			if (digest('sha256', publicTarball) !== evidence.sha256) {
				throw new Error(`${evidence.name} public next tarball digest mismatch.`);
			}
			await writeFile(destinationTarball, publicTarball);
		} else {
			await copyFile(sourceTarball, destinationTarball);
		}
		const { stdout } = await run('tar', ['-xOzf', destinationTarball, 'package/package.json']);
		await addPackage(JSON.parse(stdout), evidence.tarball, evidence, distTags);
	}
}
await writeFile(join(registryRoot, 'registry.json'), JSON.stringify(registry, null, 2));

await run('openssl', [
	'req',
	'-x509',
	'-newkey',
	'rsa:2048',
	'-nodes',
	'-keyout',
	join(certificateRoot, 'ca.key'),
	'-out',
	join(certificateRoot, 'ca.pem'),
	'-days',
	'2',
	'-subj',
	'/CN=n8n-yt-dlp disposable E2E CA',
]);
await run('openssl', [
	'req',
	'-newkey',
	'rsa:2048',
	'-nodes',
	'-keyout',
	join(certificateRoot, 'registry.key'),
	'-out',
	join(certificateRoot, 'registry.csr'),
	'-subj',
	'/CN=registry.npmjs.org',
]);
const extensionPath = join(certificateRoot, 'registry.ext');
await writeFile(
	extensionPath,
	'subjectAltName=DNS:registry.npmjs.org,DNS:api.n8n.io\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
);
await run('openssl', [
	'x509',
	'-req',
	'-in',
	join(certificateRoot, 'registry.csr'),
	'-CA',
	join(certificateRoot, 'ca.pem'),
	'-CAkey',
	join(certificateRoot, 'ca.key'),
	'-CAcreateserial',
	'-out',
	join(certificateRoot, 'registry.pem'),
	'-days',
	'2',
	'-sha256',
	'-extfile',
	extensionPath,
]);
await chmod(join(certificateRoot, 'registry.key'), 0o600);

const ffmpeg = join(repositoryRoot, 'packages/linux-x64/bin/ffmpeg');
// The fixtures are built with the packaged FFmpeg from the checkout, not from the candidate. An
// unhydrated LFS checkout leaves a pointer file here, and running it fails as a shell script with
// `line 1: version: command not found`, which names neither FFmpeg nor LFS. Say what is wrong.
if ((await readFile(ffmpeg)).subarray(0, 24).toString('utf8').startsWith('version https://git-lfs')) {
	throw new Error(
		'packages/linux-x64/bin/ffmpeg is a Git LFS pointer. Check the repository out with LFS before preparing fixtures.',
	);
}
const videoPath = join(fixtureRoot, 'video.mp4');
const audioPath = join(fixtureRoot, 'audio.m4a');
await run(ffmpeg, [
	'-hide_banner',
	'-loglevel',
	'error',
	'-f',
	'lavfi',
	'-i',
	'testsrc=size=64x64:rate=5',
	'-t',
	'1',
	'-an',
	'-c:v',
	'libx264',
	'-pix_fmt',
	'yuv420p',
	videoPath,
]);
await run(ffmpeg, [
	'-hide_banner',
	'-loglevel',
	'error',
	'-f',
	'lavfi',
	'-i',
	'sine=frequency=440:sample_rate=44100',
	'-t',
	'1',
	'-vn',
	'-c:a',
	'aac',
	audioPath,
]);
await run(
	ffmpeg,
	[
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		videoPath,
		'-i',
		audioPath,
		'-map',
		'0:v:0',
		'-map',
		'1:a:0',
		'-c',
		'copy',
		'-adaptation_sets',
		'id=0,streams=v id=1,streams=a',
		'-f',
		'dash',
		join(fixtureRoot, 'manifest.mpd'),
	],
	{ cwd: fixtureRoot },
);
await run(ffmpeg, [
	'-hide_banner',
	'-loglevel',
	'error',
	'-i',
	videoPath,
	'-i',
	audioPath,
	'-map',
	'0:v:0',
	'-map',
	'1:a:0',
	'-c',
	'copy',
	join(fixtureRoot, 'direct.mp4'),
]);
// The capacity lane proves the forced FFmpeg one-thread restriction by sampling the packaged
// FFmpeg itself, which needs an FFmpeg run that outlives the 100 ms process observer. A merge of
// the one-second fixtures above is over in a few milliseconds, so the lane re-encodes this longer
// fixture instead: six hundred frames through one x264 thread keep FFmpeg alive across many
// samples, and the frame count rather than a byte count decides that, so the evidence does not
// depend on how fast the host's disk is.
await run(ffmpeg, [
	'-hide_banner',
	'-loglevel',
	'error',
	'-f',
	'lavfi',
	'-i',
	'testsrc=size=480x360:rate=30',
	'-t',
	'20',
	'-an',
	'-c:v',
	'libx264',
	'-pix_fmt',
	'yuv420p',
	join(fixtureRoot, 'recode.mp4'),
]);
await Promise.all([
	copyFile(join(fixtureRoot, 'direct.mp4'), join(fixtureRoot, 'alpha.mp4')),
	copyFile(join(fixtureRoot, 'direct.mp4'), join(fixtureRoot, 'bravo.mp4')),
	copyFile(join(fixtureRoot, 'direct.mp4'), join(fixtureRoot, 'capacity.mp4')),
]);
await truncate(join(fixtureRoot, 'capacity.mp4'), 256 * 1024 * 1024);
await writeFile(join(fixtureRoot, 'oversized.mp4'), Buffer.alloc(1024 * 1024 + 4096, 0x51));

const fixtureEvidence = [];
for (const fileName of [
	'alpha.mp4',
	'bravo.mp4',
	'capacity.mp4',
	'direct.mp4',
	'manifest.mpd',
	'oversized.mp4',
	'recode.mp4',
]) {
	const body = await readFile(join(fixtureRoot, fileName));
	fixtureEvidence.push({
		fileName: basename(fileName),
		sha256: digest('sha256', body),
		sizeBytes: body.byteLength,
	});
}

const preparationEvidence = {
	fixtures: fixtureEvidence,
	packages: packageEvidence,
	schemaVersion: 1,
};
await writeFile(join(evidenceRoot, 'prepared.json'), JSON.stringify(preparationEvidence, null, 2));
process.stdout.write(`${JSON.stringify(preparationEvidence)}\n`);
