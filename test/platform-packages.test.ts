import { execFile } from 'node:child_process';
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

interface PackageMetadata {
	bin?: unknown;
	cpu?: string[];
	dependencies?: Record<string, string>;
	libc?: unknown;
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
});

afterAll(async () => {
	if (fixtureDirectory !== undefined) await rm(fixtureDirectory, { force: true, recursive: true });
});

describe('published Platform Gate packages', () => {
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
		expect(platform).toMatchObject({ version: '0.2.0', os: ['linux'], cpu: ['x64'] });
		for (const metadata of [main, selector, platform]) {
			expect(metadata).not.toHaveProperty('libc');
			expect(metadata).not.toHaveProperty('bin');
			for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
				expect(metadata?.scripts?.[lifecycle]).toBeUndefined();
			}
		}
		if (platformPackage === undefined) throw new Error('The platform package fixture is missing.');
		const manifest = JSON.parse(
			await readFile(
				join(platformPackage.extractedDirectory, 'package', 'execution-manifest.json'),
				'utf8',
			),
		) as { files: Array<{ mode?: unknown }> };
		for (const entry of manifest.files) {
			expect(entry.mode).toEqual({
				executable: true,
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
		await expect(execFileAsync(toolchain.ytDlp, ['--version'])).resolves.toMatchObject({
			stdout: 'synthetic yt-dlp 0.2.0\n',
		});
	});
});
