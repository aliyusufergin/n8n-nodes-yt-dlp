import { execFile } from 'node:child_process';
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	rename,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { VerifiedToolchain } from 'n8n-nodes-yt-dlp-platform';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve('.');
const fixtureDirectories: string[] = [];

interface SelectorApi {
	getVerifiedToolchain(): Promise<VerifiedToolchain>;
}

interface SelectorFixture {
	api: SelectorApi;
	platformDirectory: string;
	selectorDirectory: string;
}

async function createSelectorFixture(): Promise<SelectorFixture> {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-selector-'));
	fixtureDirectories.push(fixtureDirectory);
	const selectorDirectory = join(fixtureDirectory, 'n8n-nodes-yt-dlp-platform');
	const platformDirectory = join(
		selectorDirectory,
		'node_modules',
		'n8n-nodes-yt-dlp-linux-x64',
	);
	await cp(join(repositoryRoot, 'packages', 'platform-selector'), selectorDirectory, {
		recursive: true,
	});
	await cp(join(repositoryRoot, 'packages', 'linux-x64'), platformDirectory, {
		recursive: true,
	});
	const requireFromSelector = createRequire(join(selectorDirectory, 'package.json'));
	return {
		api: requireFromSelector('./') as SelectorApi,
		platformDirectory,
		selectorDirectory,
	};
}

function reloadSelector(fixture: SelectorFixture): void {
	const requireFromSelector = createRequire(join(fixture.selectorDirectory, 'package.json'));
	const selectorPath = requireFromSelector.resolve('./');
	delete requireFromSelector.cache[selectorPath];
	fixture.api = requireFromSelector('./') as SelectorApi;
}

afterEach(async () => {
	await Promise.all(
		fixtureDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
	);
});

describe('Platform Selector', () => {
	it('shares concurrent first use and returns the fingerprint-cached toolchain on the next request', async () => {
		const { api, platformDirectory } = await createSelectorFixture();

		const firstUse = api.getVerifiedToolchain();
		const concurrentFirstUse = api.getVerifiedToolchain();
		expect(concurrentFirstUse).toBe(firstUse);

		const toolchain = await firstUse;
		expect(toolchain).toEqual({
			ytDlp: join(platformDirectory, 'bin', 'yt-dlp'),
			ffmpeg: join(platformDirectory, 'bin', 'ffmpeg'),
			ffprobe: join(platformDirectory, 'bin', 'ffprobe'),
			deno: join(platformDirectory, 'bin', 'deno'),
		});
		expect(Object.isFrozen(toolchain)).toBe(true);
		expect(Object.values(toolchain).every(isAbsolute)).toBe(true);
		await expect(api.getVerifiedToolchain()).resolves.toBe(toolchain);
	});

	it('fully re-attests an identically replaced executable after the request restat detects its fingerprint', async () => {
		const { api } = await createSelectorFixture();
		const firstToolchain = await api.getVerifiedToolchain();
		const replacementPath = join(dirname(firstToolchain.ytDlp), 'replacement');
		await writeFile(replacementPath, await readFile(firstToolchain.ytDlp));
		await chmod(replacementPath, 0o755);
		await rename(replacementPath, firstToolchain.ytDlp);

		const reattestedToolchain = await api.getVerifiedToolchain();

		expect(reattestedToolchain).toEqual(firstToolchain);
		expect(reattestedToolchain).not.toBe(firstToolchain);
	});

	it('revalidates the canonical manifest digest before returning a cached toolchain', async () => {
		const { api, platformDirectory } = await createSelectorFixture();
		await api.getVerifiedToolchain();
		const manifestPath = join(platformDirectory, 'execution-manifest.json');
		await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')} `);

		await expect(api.getVerifiedToolchain()).rejects.toMatchObject({
			code: 'TOOLCHAIN_ATTESTATION_FAILED',
		});
	});

	it.each([
		[
			'non-canonical manifest',
			async ({ platformDirectory }: SelectorFixture) => {
				const manifestPath = join(platformDirectory, 'execution-manifest.json');
				await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')} `);
			},
		],
		[
			'wrong platform package version',
			async ({ platformDirectory }: SelectorFixture) => {
				const packagePath = join(platformDirectory, 'package.json');
				const metadata = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
				metadata.version = '0.2.1';
				await writeFile(packagePath, `${JSON.stringify(metadata)}\n`);
			},
		],
		[
			'missing executable',
			async ({ platformDirectory }: SelectorFixture) => {
				await unlink(join(platformDirectory, 'bin', 'yt-dlp'));
			},
		],
		[
			'corrupt replaced executable',
			async ({ platformDirectory }: SelectorFixture) => {
				const executablePath = join(platformDirectory, 'bin', 'yt-dlp');
				const replacementPath = join(platformDirectory, 'bin', 'replacement');
				await writeFile(replacementPath, '#!/bin/sh\nprintf corrupt\\n\n');
				await chmod(replacementPath, 0o755);
				await rename(replacementPath, executablePath);
			},
		],
		[
			'same-size SHA-256 mismatch',
			async ({ platformDirectory }: SelectorFixture) => {
				const executablePath = join(platformDirectory, 'bin', 'yt-dlp');
				const contents = await readFile(executablePath);
				contents[contents.length - 1] ^= 1;
				await writeFile(executablePath, contents);
			},
		],
		[
			'symlink executable',
			async ({ platformDirectory }: SelectorFixture) => {
				const executablePath = join(platformDirectory, 'bin', 'yt-dlp');
				const targetPath = join(platformDirectory, 'bin', 'yt-dlp-target');
				await rename(executablePath, targetPath);
				await symlink(targetPath, executablePath);
			},
		],
		[
			'non-regular executable',
			async ({ platformDirectory }: SelectorFixture) => {
				const executablePath = join(platformDirectory, 'bin', 'yt-dlp');
				await unlink(executablePath);
				await mkdir(executablePath);
			},
		],
		[
			'non-executable mode',
			async ({ platformDirectory }: SelectorFixture) => {
				await chmod(join(platformDirectory, 'bin', 'yt-dlp'), 0o644);
			},
		],
		[
			'group-writable mode',
			async ({ platformDirectory }: SelectorFixture) => {
				await chmod(join(platformDirectory, 'bin', 'yt-dlp'), 0o775);
			},
		],
		[
			'bad bounded probe result',
			async (fixture: SelectorFixture) => {
				const { platformDirectory, selectorDirectory } = fixture;
				const manifestPath = join(platformDirectory, 'execution-manifest.json');
				const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
					files: Array<{ probe: { stdout: string } }>;
				};
				manifest.files[0].probe.stdout = 'unexpected probe output\n';
				const manifestContents = `${JSON.stringify(manifest)}\n`;
				await writeFile(manifestPath, manifestContents);
				const selectorPath = join(selectorDirectory, 'index.js');
				const selectorContents = await readFile(selectorPath, 'utf8');
				const manifestDigest = createHash('sha256').update(manifestContents).digest('hex');
				await writeFile(
					selectorPath,
					selectorContents.replace(/[0-9a-f]{64}/u, manifestDigest),
				);
				reloadSelector(fixture);
			},
		],
	] as const)('fails closed for a %s', async (_name, mutateFixture) => {
		const fixture = await createSelectorFixture();
		await mutateFixture(fixture);

		await expect(fixture.api.getVerifiedToolchain()).rejects.toMatchObject({
			code: 'TOOLCHAIN_ATTESTATION_FAILED',
			message: 'The packaged yt-dlp toolchain failed runtime attestation.',
		});
	});

	it.each([
		['platform', 'darwin'],
		['arch', 'arm64'],
	] as const)('fails closed on a wrong runtime %s', async (property, value) => {
		const { selectorDirectory } = await createSelectorFixture();
		const script = `
			Object.defineProperty(process, ${JSON.stringify(property)}, { value: ${JSON.stringify(value)} });
			require(${JSON.stringify(selectorDirectory)}).getVerifiedToolchain().then(
				() => process.exitCode = 1,
				(error) => process.stdout.write(error.code),
			);
		`;

		await expect(execFileAsync(process.execPath, ['-e', script])).resolves.toMatchObject({
			stdout: 'TOOLCHAIN_ATTESTATION_FAILED',
		});
	});

	it('does not fall back to PATH when the platform package is absent', async () => {
		const { api, platformDirectory, selectorDirectory } = await createSelectorFixture();
		await rm(platformDirectory, { recursive: true });
		const fakeBinDirectory = join(dirname(selectorDirectory), 'fake-bin');
		await mkdir(fakeBinDirectory);
		await writeFile(join(fakeBinDirectory, 'yt-dlp'), '#!/bin/sh\nexit 0\n');
		await chmod(join(fakeBinDirectory, 'yt-dlp'), 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = fakeBinDirectory;
		try {
			await expect(api.getVerifiedToolchain()).rejects.toMatchObject({
				code: 'TOOLCHAIN_ATTESTATION_FAILED',
			});
		} finally {
			process.env.PATH = originalPath;
		}
	});
});
