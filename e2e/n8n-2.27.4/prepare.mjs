import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmod,
	copyFile,
	mkdir,
	readFile,
	rm,
	truncate,
	writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.argv[2] ?? '.');
const generatedRoot = resolve(
	process.argv[3] ?? 'e2e/n8n-2.27.4/.generated',
);
const registryRoot = join(generatedRoot, 'registry');
const tarballRoot = join(registryRoot, 'tarballs');
const certificateRoot = join(registryRoot, 'certs');
const fixtureRoot = join(generatedRoot, 'fixtures');
const evidenceRoot = join(generatedRoot, 'evidence');
const packageVersion = '0.2.0';

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

await run('npm', ['run', 'build']);

const packageDirectories = [
	'./packages/linux-x64',
	'./packages/platform-selector',
	'.',
];
const packageEvidence = [];
const registry = {};

for (const packageDirectory of packageDirectories) {
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
		'dist-tags': { latest: packageVersion, next: packageVersion },
		name: packageJson.name,
		versions: { [packageVersion]: metadata },
	};
	packageEvidence.push({
		name: packageJson.name,
		sha256: digest('sha256', body),
		sizeBytes: body.byteLength,
		tarball: tarballName,
		version: packageJson.version,
	});
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
await writeFile(
	join(evidenceRoot, 'prepared.json'),
	JSON.stringify(preparationEvidence, null, 2),
);
process.stdout.write(`${JSON.stringify(preparationEvidence)}\n`);
