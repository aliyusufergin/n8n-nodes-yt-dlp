import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { VerifiedToolchain } from 'n8n-nodes-yt-dlp-platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve('.');

async function runDenoStdin(executablePath: string, source: string): Promise<string> {
	return await new Promise((resolveRun, rejectRun) => {
		const child = spawn(
			executablePath,
			[
				'run',
				'--ext=js',
				'--no-code-cache',
				'--no-prompt',
				'--no-remote',
				'--no-lock',
				'--node-modules-dir=none',
				'--no-config',
				'--no-npm',
				'--cached-only',
				'-',
			],
			{
				env: {
					DENO_NO_UPDATE_CHECK: '1',
					LANG: 'C',
					LC_ALL: 'C',
					NO_COLOR: '1',
				},
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.once('error', rejectRun);
		child.once('close', (code, signal) => {
			if (code !== 0 || signal !== null) {
				rejectRun(
					new Error(
						`Deno challenge process failed: ${Buffer.concat(stderr).toString('utf8')}`,
					),
				);
				return;
			}
			resolveRun(Buffer.concat(stdout).toString('utf8'));
		});
		child.stdin.end(source);
	});
}

interface PackageMetadata {
	bin?: unknown;
	cpu?: string[];
	dependencies?: Record<string, string>;
	libc?: unknown;
	license?: string;
	name: string;
	optionalDependencies?: Record<string, string>;
	os?: string[];
	scripts?: Record<string, string>;
	version: string;
}

interface PackedPackage {
	extractedDirectory: string;
	metadata: PackageMetadata;
	tarballPath: string;
}

interface ToolchainLock {
	components: Array<{
		assets: Array<{ name: string; sha256: string }>;
		license: string;
		name: string;
		sourceGate?: { status: string };
		sourceBundle: { name: string; sha256: string; url?: string };
		upstream: {
			commit: string;
			ffmpegCommit?: string;
			releaseRepository?: string;
			repository: string;
			tag: string;
		};
	}>;
	packageName: string;
	packageVersion: string;
	policy: {
		lockstepPackageVersion: string;
		mutableAssets: false;
		runtimeDownloads: false;
		runtimeSelfUpdate: false;
	};
	schemaVersion: number;
}

let fixtureDirectory: string;
let packages: PackedPackage[];

async function packPackage(directory: string, destination: string): Promise<PackedPackage> {
	const { stdout } = await execFileAsync(
		'npm',
		['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
		{ cwd: directory },
	);
	const packResult = JSON.parse(stdout) as
		| [{ filename: string }]
		| Record<string, { filename: string }>;
	const [{ filename }] = Array.isArray(packResult) ? packResult : Object.values(packResult);
	const tarballPath = join(destination, filename);
	const extractedDirectory = await mkdtemp(join(destination, 'extracted-'));
	await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractedDirectory]);
	const metadata = JSON.parse(
		await readFile(join(extractedDirectory, 'package', 'package.json'), 'utf8'),
	) as PackageMetadata;
	return { extractedDirectory, metadata, tarballPath };
}

beforeAll(async () => {
	fixtureDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-platform-packages-'));
	const tarballDirectory = join(fixtureDirectory, 'tarballs');
	await mkdir(tarballDirectory);
	packages = await Promise.all(
		[
			repositoryRoot,
			join(repositoryRoot, 'packages', 'platform-selector'),
			join(repositoryRoot, 'packages', 'linux-x64'),
		].map(async (directory) => await packPackage(directory, tarballDirectory)),
	);
}, 180_000);

afterAll(async () => {
	if (fixtureDirectory !== undefined) await rm(fixtureDirectory, { force: true, recursive: true });
}, 60_000);

describe('published Platform Gate packages', () => {
	it('packages the exact dated Linux x64 GPL FFmpeg and FFprobe build', async () => {
		const platformPackage = packages.find(
			({ metadata }) => metadata.name === 'n8n-nodes-yt-dlp-linux-x64',
		);
		if (platformPackage === undefined) throw new Error('The platform package fixture is missing.');
		const packagedBin = join(platformPackage.extractedDirectory, 'package', 'bin');
		const packageRoot = join(platformPackage.extractedDirectory, 'package');
		const [ffmpegBytes, ffprobeBytes, ffmpegVersion, ffprobeVersion] = await Promise.all([
			readFile(join(packagedBin, 'ffmpeg.gnu')),
			readFile(join(packagedBin, 'ffprobe.gnu')),
			execFileAsync(join(packagedBin, 'ffmpeg'), ['-hide_banner', '-version']),
			execFileAsync(join(packagedBin, 'ffprobe'), ['-hide_banner', '-version']),
		]);

		expect((await readdir(packagedBin)).sort()).toEqual([
			'deno',
			'deno.gnu',
			'ffmpeg',
			'ffmpeg.gnu',
			'ffprobe',
			'ffprobe.gnu',
			'yt-dlp',
			'yt-dlp.musl',
		]);
		expect(createHash('sha256').update(ffmpegBytes).digest('hex')).toBe(
			'ea50d9fba39cc2f57785be7d082a65d5484728d83e9f90ecc6ba4372c05fc022',
		);
		expect(createHash('sha256').update(ffprobeBytes).digest('hex')).toBe(
			'7d37b347245e21cea470f7ba696f32eb918dcf485fd5ffba3b29f44c0556f7d8',
		);
		expect(ffmpegVersion.stdout).toContain('ffmpeg version N-125551-ga09be9b91e-20260712');
		expect(ffmpegVersion.stdout).toContain('--enable-gpl --enable-version3');
		expect(ffprobeVersion.stdout).toContain('ffprobe version N-125551-ga09be9b91e-20260712');
		expect(ffprobeVersion.stdout).toContain('--enable-gpl --enable-version3');
		const manifest = JSON.parse(
			await readFile(join(packageRoot, 'execution-manifest.json'), 'utf8'),
		) as { files: Array<{ name: string; path: string }> };
		expect(manifest.files.map(({ name, path }) => ({ name, path }))).toEqual([
			{ name: 'ytDlp', path: 'bin/yt-dlp' },
			{ name: 'ffmpeg', path: 'bin/ffmpeg' },
			{ name: 'ffprobe', path: 'bin/ffprobe' },
			{ name: 'deno', path: 'bin/deno' },
			{ name: 'ytDlpBinary', path: 'bin/yt-dlp.musl' },
			{ name: 'ffmpegBinary', path: 'bin/ffmpeg.gnu' },
			{ name: 'ffprobeBinary', path: 'bin/ffprobe.gnu' },
			{ name: 'denoBinary', path: 'bin/deno.gnu' },
			{ name: 'muslLoader', path: 'runtime/musl/ld-musl-x86_64.so.1' },
			{ name: 'muslZlib', path: 'runtime/musl/libz.so.1' },
			{ name: 'glibcLoader', path: 'runtime/glibc/ld-linux-x86-64.so.2' },
			{ name: 'glibc', path: 'runtime/glibc/libc.so.6' },
			{ name: 'glibcDl', path: 'runtime/glibc/libdl.so.2' },
			{ name: 'gccRuntime', path: 'runtime/glibc/libgcc_s.so.1' },
			{ name: 'glibcMath', path: 'runtime/glibc/libm.so.6' },
			{ name: 'glibcVectorMath', path: 'runtime/glibc/libmvec.so.1' },
			{ name: 'glibcDns', path: 'runtime/glibc/libnss_dns.so.2' },
			{ name: 'glibcFiles', path: 'runtime/glibc/libnss_files.so.2' },
			{ name: 'glibcThreads', path: 'runtime/glibc/libpthread.so.0' },
			{ name: 'glibcResolver', path: 'runtime/glibc/libresolv.so.2' },
			{ name: 'glibcRealtime', path: 'runtime/glibc/librt.so.1' },
			{ name: 'zlib', path: 'runtime/glibc/libz.so.1' },
			{ name: 'ejsCore', path: 'assets/ejs/yt.solver.core.js' },
			{ name: 'ejsLib', path: 'assets/ejs/yt.solver.lib.js' },
		]);
		expect(await readFile(join(packageRoot, 'LICENSES.md'), 'utf8')).toContain(
			'| `bin/ffmpeg.gnu`, `bin/ffprobe.gnu`',
		);
		await expect(
			readFile(join(packageRoot, 'LICENSES', 'FFmpeg-GPLv3.txt'), 'utf8'),
		).resolves.toContain('GNU GENERAL PUBLIC LICENSE');
		await expect(
			readFile(join(packageRoot, 'LICENSES', 'FFmpeg-Builds-MIT.txt'), 'utf8'),
		).resolves.toContain('Permission is hereby granted');
		expect(
			await readdir(join(packageRoot, 'LICENSES', 'ffmpeg-static')),
		).not.toHaveLength(0);
	});

	it('solves official frozen EJS N/SIG vectors and cached players with packaged Deno', async () => {
		const [vectorContents, syntheticPlayer, ejsLibrary, ejsCore] = await Promise.all([
			readFile(join(repositoryRoot, 'test', 'fixtures', 'ejs', 'vectors.json'), 'utf8'),
			readFile(join(repositoryRoot, 'test', 'fixtures', 'ejs', 'synthetic-player.js'), 'utf8'),
			readFile(join(repositoryRoot, 'packages', 'linux-x64', 'assets', 'ejs', 'yt.solver.lib.js'), 'utf8'),
			readFile(join(repositoryRoot, 'packages', 'linux-x64', 'assets', 'ejs', 'yt.solver.core.js'), 'utf8'),
		]);
		const vectors = JSON.parse(vectorContents) as {
			fixture: { license: 'MIT'; origin: 'project-generated' };
			source: string;
			players: Array<{
				id: string;
				requests: Array<{
					hexValues?: Array<
						| { inputHex: string; outputHex: string }
						| { inputRange: [number, number]; outputHex: string }
					>;
					type: 'n' | 'sig';
					values?: Record<string, string>;
				}>;
			}>;
		};
		expect(vectors.source).toContain('aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8');
		expect(vectors.fixture).toEqual({ license: 'MIT', origin: 'project-generated' });
		const denoPath = join(repositoryRoot, 'packages', 'linux-x64', 'bin', 'deno');
		const solve = async (input: Record<string, unknown>) => {
			const source = `${ejsLibrary}\nObject.assign(globalThis, lib);\n${ejsCore}\nconsole.log(JSON.stringify(jsc(${JSON.stringify(input)})));\n`;
			return JSON.parse(await runDenoStdin(denoPath, source)) as {
				preprocessed_player?: string;
				responses: unknown;
				type: string;
			};
		};

		for (const [index, vector] of vectors.players.entries()) {
			const expandedRequests = vector.requests.map(({ hexValues = [], type, values = {} }) => ({
				type,
				values: {
					...values,
					...Object.fromEntries(
						hexValues.map((pair) => {
							const input =
								'inputHex' in pair
									? Buffer.from(pair.inputHex, 'hex').toString('latin1')
									: String.fromCharCode(
											...Array.from(
												{ length: pair.inputRange[1] - pair.inputRange[0] + 1 },
												(_, offset) => pair.inputRange[0] + offset,
											),
										);
							return [input, Buffer.from(pair.outputHex, 'hex').toString('latin1')];
						}),
					),
				},
			}));
			const player = syntheticPlayer.replace('"__PROFILE__"', JSON.stringify(vector.id));
			expect(player).not.toContain('__PROFILE__');
			const requests = expandedRequests.map(({ type, values }) => ({
				type,
				challenges: Object.keys(values),
			}));
			const expectedResponses = expandedRequests.map(({ values }) => ({
				type: 'result',
				data: values,
			}));
			const result = await solve({
				type: 'player',
				player,
				output_preprocessed: index === 0,
				requests,
			});
			expect(result).toMatchObject({ type: 'result', responses: expectedResponses });

			if (index === 0) {
				expect(result.preprocessed_player).toEqual(expect.any(String));
				const cachedResult = await solve({
					type: 'preprocessed',
					preprocessed_player: result.preprocessed_player,
					requests,
				});
				expect(cachedResult.responses).toEqual(result.responses);
			}
		}
	}, 60_000);

	it('runs packaged Deno without filesystem, network, environment, or subprocess permission', async () => {
		const source = `
			const denied = async (operation) => {
				try { await operation(); return 'allowed'; } catch (error) { return error.name; }
			};
			console.log(JSON.stringify({
				filesystem: await denied(() => Deno.readTextFile('/etc/passwd')),
				network: await denied(() => fetch('http://127.0.0.1:4545/')),
				environment: await denied(() => Deno.env.get('PATH')),
				subprocess: await denied(() => new Deno.Command('/bin/true').output()),
			}));
		`;

		const stdout = await runDenoStdin(
			join(repositoryRoot, 'packages', 'linux-x64', 'bin', 'deno'),
			source,
		);

		expect(JSON.parse(stdout)).toEqual({
			filesystem: 'NotCapable',
			network: 'NotCapable',
			environment: 'NotCapable',
			subprocess: 'NotCapable',
		});
	});

	it('ships an immutable Toolchain Lock with exact upstream identities', async () => {
		const platformPackage = packages.find(
			({ metadata }) => metadata.name === 'n8n-nodes-yt-dlp-linux-x64',
		);
		if (platformPackage === undefined) throw new Error('The platform package fixture is missing.');
		const lock = JSON.parse(
			await readFile(
				join(platformPackage.extractedDirectory, 'package', 'TOOLCHAIN.lock.json'),
				'utf8',
			),
		) as ToolchainLock;

		expect(lock).toMatchObject({
			schemaVersion: 1,
			packageName: 'n8n-nodes-yt-dlp-linux-x64',
			packageVersion: '0.2.0',
			policy: {
				lockstepPackageVersion: '0.2.0',
				mutableAssets: false,
				runtimeDownloads: false,
				runtimeSelfUpdate: false,
			},
		});
		expect(lock.components).toEqual([
			expect.objectContaining({
				name: 'yt-dlp',
				upstream: {
					repository: 'yt-dlp/yt-dlp',
					releaseRepository: 'yt-dlp/yt-dlp-nightly-builds',
					tag: '2026.07.14.233956',
					commit: 'aefce1eea4d0b6bab1ec2bd3beff09bff91a39c8',
				},
				assets: [{
					name: 'yt-dlp_musllinux',
					sha256: '8f5d14830ffcfc2a45de3c13b0e5158bc228d8d00bc58df2196d0d14e01d7023',
				}],
				license: 'Unlicense AND LicenseRef-yt-dlp-third-party',
				sourceBundle: {
					name: 'yt-dlp.tar.gz',
					sha256: '07e2aec9b176ce346d5dd96aa4ade127add1ee88a297129e5bad854be2170dab',
				},
			}),
			expect.objectContaining({ name: 'ffmpeg' }),
			expect.objectContaining({
				name: 'deno',
				upstream: {
					repository: 'denoland/deno',
					tag: 'v2.9.3',
					commit: 'f39575ecd50602a5b42b1ba8e93849460de9fcf4',
				},
				assets: [{
					name: 'deno-x86_64-unknown-linux-gnu.zip',
					sha256: '8101865641cbede56f08ad19c0a67a87df84bce127fee0d3e3e1f7467717ffa6',
				}],
				license: 'MIT',
				sourceBundle: {
					name: 'deno_src.tar.gz',
					sha256: '58da10e48968a80a6c205b31584d1f1f4583226e59ebb08cb3783b12e7f22d4d',
				},
			}),
			expect.objectContaining({
				name: 'linux-runtime',
				build: expect.objectContaining({
					image:
						'gcc@sha256:3e239a5ea77200b9163c825a0a5ebc17ca99f3bbb4d08241ee0fb9c174325880',
				}),
				runtime: expect.objectContaining({
					image:
						'ubuntu@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982',
				}),
				muslRuntime: expect.objectContaining({
					image:
						'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1',
				}),
				sourceGate: {
					status: 'pending',
					blockingReason:
						'Platform publication requires a combined immutable runtime Corresponding Source Bundle, a clean isolated rebuild, and maintainer license-review evidence.',
				},
			}),
			expect.objectContaining({
				name: 'yt-dlp-ejs',
				upstream: {
					repository: 'yt-dlp/ejs',
					tag: '0.8.0',
					commit: '4fb477f4af56880cfd324c48bd4294a2d2294e50',
				},
				assets: [
					{
						name: 'yt.solver.core.js',
						sha256: 'ca259e4e3cdd37d92fc266d9af08d4fd66da8479e240f4d984f29da402c22ead',
					},
					{
						name: 'yt.solver.lib.js',
						sha256: '770831df5c46474fbff06732315b28f4fb090e427ca669a51da61e2457d41c82',
					},
				],
				license: 'Unlicense AND MIT AND ISC',
				sourceBundle: {
					name: 'yt_dlp_ejs-0.8.0.tar.gz',
					sha256: 'd5fa1639f63b5c4af8d932495f60689d5370f1a095782c944f7f62a303eb104e',
				},
			}),
		]);
	});

	it('blocks platform publication while the Linux runtime source gate is pending', async () => {
		try {
			await execFileAsync(process.execPath, [
				join(repositoryRoot, 'scripts', 'ffmpeg-source-bundle.mjs'),
				'verify-release',
			]);
			throw new Error('The release verification unexpectedly passed.');
		} catch (error) {
			expect((error as { stderr?: string }).stderr).toContain(
				'Platform publication is blocked until the Linux runtime Corresponding Source',
			);
		}
	});

	it('maps the source-gated FFmpeg build to its complete source inventory', async () => {
		const platformPackage = packages.find(
			({ metadata }) => metadata.name === 'n8n-nodes-yt-dlp-linux-x64',
		);
		if (platformPackage === undefined) throw new Error('The platform package fixture is missing.');
		const packageRoot = join(platformPackage.extractedDirectory, 'package');
		const lock = JSON.parse(
			await readFile(join(packageRoot, 'TOOLCHAIN.lock.json'), 'utf8'),
		) as ToolchainLock;
		const ffmpeg = lock.components.find(({ name }) => name === 'ffmpeg');

		expect(ffmpeg).toMatchObject({
			name: 'ffmpeg',
			upstream: {
				repository: 'yt-dlp/FFmpeg-Builds',
				tag: 'autobuild-2026-07-12-15-07',
				commit: '832dd2f333d919790f117b054f628756c515adce',
				ffmpegCommit: 'a09be9b91e8e1219f297586873b0d7322b47df96',
			},
			assets: [
				{
					name: 'ffmpeg-N-125551-ga09be9b91e-linux64-gpl.tar.xz',
					sha256: '7a19456683e31d937ae48d51e23dfb869dbb9db1e4d6e1b6881d7fed168fa5cf',
				},
			],
			license: 'GPL-3.0-or-later AND LicenseRef-FFmpeg-static-components',
			sourceBundle: {
				name: 'n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz',
				url: 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz',
			},
		});
		expect(ffmpeg?.sourceBundle.sha256).toMatch(/^[0-9a-f]{64}$/u);

		const sourceManifest = JSON.parse(
			await readFile(join(packageRoot, 'FFMPEG-SOURCE-MANIFEST.json'), 'utf8'),
		) as {
			cleanRebuildOutputs: { ffmpegSha256: string; ffprobeSha256: string };
			manualReview: { path: string; requiredStatus: string };
			sourceArchives: Array<{
				cargoPackages?: Array<{
					license: string;
					licenseFiles: string[];
					name: string;
					sourcePath: string;
					version: string;
				}>;
				cargoVendor?: { configSha256: string; lockSha256: string; packageCount: number };
				input?: string;
				licenseFiles: string[];
				name: string;
				sha256: string;
				vendoredSubmodules?: Array<{
					commit: string;
					licenseFiles: string[];
					path: string;
					repository: string;
				}>;
			}>;
		};
		expect(sourceManifest.sourceArchives).toHaveLength(109);
		expect(new Set(sourceManifest.sourceArchives.map(({ name }) => name)).size).toBe(109);
		for (const source of sourceManifest.sourceArchives) {
			expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u);
			expect(source.licenseFiles.length).toBeGreaterThan(0);
		}
		const rav1e = sourceManifest.sourceArchives.find(({ name }) => name.startsWith('50-rav1e_'));
		expect(rav1e).toMatchObject({
			input: 'input-root',
			cargoVendor: { packageCount: 272 },
		});
		expect(rav1e?.cargoVendor?.configSha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(rav1e?.cargoVendor?.lockSha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(rav1e?.cargoPackages).toHaveLength(272);
		for (const cargoPackage of rav1e?.cargoPackages ?? []) {
			expect(cargoPackage).toMatchObject({
				license: expect.any(String),
				name: expect.any(String),
				sourcePath: expect.stringMatching(/^\.\/vendor\/[^/]+$/u),
				version: expect.any(String),
			});
			expect(cargoPackage.licenseFiles.length).toBeGreaterThan(0);
			expect(
				cargoPackage.licenseFiles.every((path) =>
					path.startsWith(
						`LICENSES/ffmpeg-static/50-rav1e/${cargoPackage.sourcePath.slice(2)}/`,
					),
				),
			).toBe(true);
		}
		const freetypeSources = sourceManifest.sourceArchives.filter(({ name }) =>
			/^(?:25|50)-freetype_/u.test(name),
		);
		expect(freetypeSources).toHaveLength(2);
		for (const freetype of freetypeSources) {
			expect(freetype).toMatchObject({
				input: 'input-root',
				vendoredSubmodules: [
					{
						commit: '395ccad2c1e0daae535c4d20bb0a3f2424648e17',
						path: 'subprojects/dlg',
						repository: 'https://github.com/nyorain/dlg.git',
					},
				],
			});
			expect(freetype.vendoredSubmodules?.[0].licenseFiles).toHaveLength(1);
		}
		expect(sourceManifest.manualReview).toEqual({
			path: 'toolchain/ffmpeg/LICENSE-REVIEW.json',
			requiredStatus: 'approved',
		});
		expect(sourceManifest.cleanRebuildOutputs).toEqual({
			ffmpegSha256: 'b5532ca4ce06bef2fce593e89cd6bcb2be5fa89db6fa91e876b1c16c613502b1',
			ffprobeSha256: 'e6b5e3496cd160152898de6e86b4689fa6f2630ed7903725c50a5de3b7eeae3f',
		});
	});

	it('carry the exact three-package dependency chain and Linux x64 metadata', async () => {
		const byName = new Map(packages.map((packedPackage) => [packedPackage.metadata.name, packedPackage]));
		const main = byName.get('n8n-nodes-yt-dlp')?.metadata;
		const selector = byName.get('n8n-nodes-yt-dlp-platform')?.metadata;
		const platformPackage = byName.get('n8n-nodes-yt-dlp-linux-x64');
		const platform = platformPackage?.metadata;

		expect(main).toMatchObject({
			version: '0.2.0',
			os: ['linux'],
			cpu: ['x64'],
			dependencies: { 'n8n-nodes-yt-dlp-platform': '0.2.0' },
		});
		expect(main?.optionalDependencies).toBeUndefined();
		expect(selector).toMatchObject({
			version: '0.2.0',
			os: ['linux'],
			cpu: ['x64'],
			optionalDependencies: { 'n8n-nodes-yt-dlp-linux-x64': '0.2.0' },
		});
		expect(platform).toMatchObject({
			version: '0.2.0',
			os: ['linux'],
			cpu: ['x64'],
			license: 'SEE LICENSE IN LICENSES.md',
			scripts: {
				prepack: 'node ../../scripts/ffmpeg-source-bundle.mjs verify-release',
			},
		});
		for (const metadata of [main, selector, platform]) {
			expect(metadata).not.toHaveProperty('libc');
			expect(metadata).not.toHaveProperty('bin');
			for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
				expect(metadata?.scripts?.[lifecycle]).toBeUndefined();
			}
		}
		if (platformPackage === undefined) throw new Error('The platform package fixture is missing.');
		await Promise.all(
			['CORRESPONDING_SOURCE.md', 'LICENSES.md', 'THIRD_PARTY_NOTICES.md'].map(
				async (name) =>
					await readFile(join(platformPackage.extractedDirectory, 'package', name), 'utf8'),
			),
		);
		const manifest = JSON.parse(
			await readFile(
				join(platformPackage.extractedDirectory, 'package', 'execution-manifest.json'),
				'utf8',
			),
		) as { files: Array<{ mode?: unknown; name: string }> };
		for (const entry of manifest.files) {
			expect(entry.mode).toEqual({
				executable:
					['deno', 'ffmpeg', 'ffprobe', 'ytDlp'].includes(entry.name) ||
					entry.name.endsWith('Binary') ||
					entry.name.endsWith('Loader'),
				groupWritable: false,
				worldWritable: false,
			});
		}
	});

	it('installs shallowly without scripts or bin links and probes the matching package by absolute path', async () => {
		const byName = new Map(packages.map((packedPackage) => [packedPackage.metadata.name, packedPackage]));
		const main = byName.get('n8n-nodes-yt-dlp');
		const selector = byName.get('n8n-nodes-yt-dlp-platform');
		const platform = byName.get('n8n-nodes-yt-dlp-linux-x64');
		if (main === undefined || selector === undefined || platform === undefined) {
			throw new Error('The packed package fixture is incomplete.');
		}

		const registryPackages = new Map([
			[selector.metadata.name, selector],
			[platform.metadata.name, platform],
		]);
		const server = createServer((request, response) => {
			const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://registry').pathname);
			const packedPackage = registryPackages.get(requestPath.slice(1));
			if (packedPackage !== undefined) {
				const address = server.address() as AddressInfo;
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						name: packedPackage.metadata.name,
						'dist-tags': { latest: packedPackage.metadata.version },
						versions: {
							[packedPackage.metadata.version]: {
								...packedPackage.metadata,
								dist: {
									tarball: `http://127.0.0.1:${address.port}/tarballs/${packedPackage.metadata.name}.tgz`,
								},
							},
						},
					}),
				);
				return;
			}
			const tarballName = requestPath.match(/^\/tarballs\/(.+)\.tgz$/)?.[1];
			const tarball = tarballName === undefined ? undefined : registryPackages.get(tarballName);
			if (tarball === undefined) {
				response.statusCode = 404;
				response.end();
				return;
			}
			void readFile(tarball.tarballPath).then((contents) => response.end(contents));
		});
		await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

		const installDirectory = join(fixtureDirectory, 'shallow-install');
		await cp(join(main.extractedDirectory, 'package'), installDirectory, { recursive: true });
		const installMetadata = { ...main.metadata } as PackageMetadata & {
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};
		delete installMetadata.devDependencies;
		delete installMetadata.peerDependencies;
		delete installMetadata.optionalDependencies;
		await writeFile(join(installDirectory, 'package.json'), `${JSON.stringify(installMetadata)}\n`);

		try {
			const address = server.address() as AddressInfo;
			await execFileAsync(
				'npm',
				[
					'install',
					'--ignore-scripts',
					'--bin-links=false',
					'--install-strategy=shallow',
					'--package-lock=false',
					'--audit=false',
					'--fund=false',
					`--registry=http://127.0.0.1:${address.port}`,
				],
				{ cwd: installDirectory },
			);
		} finally {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
			});
		}

		const selectorDirectory = join(
			installDirectory,
			'node_modules',
			'n8n-nodes-yt-dlp-platform',
		);
		const platformDirectory = join(
			selectorDirectory,
			'node_modules',
			'n8n-nodes-yt-dlp-linux-x64',
		);
		expect(
			JSON.parse(await readFile(join(selectorDirectory, 'package.json'), 'utf8')),
		).toMatchObject({ name: 'n8n-nodes-yt-dlp-platform', version: '0.2.0' });
		expect(
			JSON.parse(await readFile(join(platformDirectory, 'package.json'), 'utf8')),
		).toMatchObject({ name: 'n8n-nodes-yt-dlp-linux-x64', version: '0.2.0' });
		expect(await readdir(join(selectorDirectory, 'node_modules'))).toEqual([
			'n8n-nodes-yt-dlp-linux-x64',
		]);
		await expect(lstat(join(installDirectory, 'node_modules', '.bin'))).rejects.toMatchObject({
			code: 'ENOENT',
		});

		const requireFromSelector = createRequire(join(selectorDirectory, 'package.json'));
		const { getVerifiedToolchain } = requireFromSelector('./') as {
			getVerifiedToolchain: () => Promise<VerifiedToolchain>;
		};
		const toolchain = await getVerifiedToolchain();
		expect(Object.values(toolchain).every(isAbsolute)).toBe(true);
		expect(Object.keys(toolchain).sort()).toEqual([
			'deno',
			'ejsCore',
			'ejsLib',
			'ffmpeg',
			'ffprobe',
			'ytDlp',
		]);
		await expect(execFileAsync(toolchain.ytDlp, ['--version'])).resolves.toMatchObject({
			stdout: '2026.07.14.233956\n',
		});
		await expect(execFileAsync(toolchain.deno, ['--version'])).resolves.toMatchObject({
			stdout:
				'deno 2.9.3 (stable, release, x86_64-unknown-linux-gnu)\n' +
				'v8 14.9.207.2-rusty\n' +
				'typescript 6.0.3\n',
		});
	}, 30_000);
});
