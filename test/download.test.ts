import { createServer, request as httpRequest, type Server } from 'node:http';
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type { IBinaryData, IExecuteFunctions, INode } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

const artifactRaceControl = vi.hoisted(() => ({
	beforeLstat: undefined as ((path: string) => Promise<void>) | undefined,
	afterLstat: undefined as ((path: string) => Promise<void>) | undefined,
	afterOpen: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		lstat: async (path: string) => {
			const isArtifactDescriptorPath = path.startsWith('/proc/self/fd/');
			if (isArtifactDescriptorPath) await artifactRaceControl.beforeLstat?.(path);
			const result = await actual.lstat(path);
			if (isArtifactDescriptorPath) await artifactRaceControl.afterLstat?.(path);
			return result;
		},
		open: async (path: string, flags: number) => {
			const result = await actual.open(path, flags);
			await artifactRaceControl.afterOpen?.(path);
			return result;
		},
	};
});

import {
	executeYtDlpNode,
	type DownloadRequestExecutor,
} from '../nodes/YtDlp/YtDlp.node';
import { executeDownloadRequest } from '../nodes/YtDlp/download';
import {
	createResourceEnvelope,
	type ResourceEnvelopeConfiguration,
} from '../nodes/YtDlp/resource-envelope';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	artifactRaceControl.beforeLstat = undefined;
	artifactRaceControl.afterLstat = undefined;
	artifactRaceControl.afterOpen = undefined;
	await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
	);
});

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await readFile(path);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return Promise.reject(error);
			await delay(10);
		}
	}
	throw new Error('The controlled executable did not create its marker file.');
}

async function startSyntheticOrigin(body: Buffer): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'video/mp4' });
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/fixture`;
}

async function createControlledExecutable(directory: string, extension: string): Promise<string> {
	const executablePath = join(directory, 'controlled-yt-dlp');
	await writeFile(
		executablePath,
		`#!${process.execPath}\n` +
			`const { stat, writeFile } = require('node:fs/promises');\n` +
			`const { join } = require('node:path');\n` +
			`void (async () => {\n` +
			`const argv = process.argv.slice(2);\n` +
			`const pathIndexes = argv.flatMap((value, index) => value === '--paths' ? [index] : []);\n` +
			`const artifacts = argv[pathIndexes[0] + 1];\n` +
			`const temp = argv[pathIndexes[1] + 1].slice('temp:'.length);\n` +
			`const control = join(process.cwd(), 'control');\n` +
			`for (const directory of [process.cwd(), artifacts, temp, control]) {\n` +
			`  const mode = (await stat(directory)).mode & 0o777;\n` +
			`  if (mode !== 0o700) throw new Error('workspace directory is not owner-only');\n` +
			`}\n` +
			`const response = await fetch(argv.at(-1));\n` +
			`if (!response.ok) throw new Error('synthetic origin failed');\n` +
			`await writeFile(join(artifacts, '000001-fixture.${extension}'), Buffer.from(await response.arrayBuffer()));\n` +
			`process.stdout.write('process-output-must-not-be-returned');\n` +
			`})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
		{ mode: 0o700 },
	);
	return executablePath;
}

async function createArtifactFixtureExecutable(
	directory: string,
	fixtureSource: string,
): Promise<string> {
	const executablePath = join(directory, 'controlled-artifact-fixture');
	await writeFile(
		executablePath,
		`#!${process.execPath}\n` +
			`const fs = require('node:fs/promises');\n` +
			`const { join } = require('node:path');\n` +
			`void (async () => {\n` +
			`const argv = process.argv.slice(2);\n` +
			`const pathIndexes = argv.flatMap((value, index) => value === '--paths' ? [index] : []);\n` +
			`const artifacts = argv[pathIndexes[0] + 1];\n` +
			`const temp = argv[pathIndexes[1] + 1].slice('temp:'.length);\n` +
			`const control = join(process.cwd(), 'control');\n` +
			fixtureSource +
			`})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
		{ mode: 0o700 },
	);
	return executablePath;
}

function createExecutionContext(
	sourceUrl: string,
	prepareBinaryData: (data: Buffer | Readable, fileName?: string, mimeType?: string) => Promise<IBinaryData>,
	signal?: AbortSignal,
	resourceConfiguration: ResourceEnvelopeConfiguration = {},
): IExecuteFunctions {
	const node: INode = {
		id: 'node-id',
		name: 'yt-dlp',
		type: 'n8n-nodes-yt-dlp.ytDlp',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};

	return {
		continueOnFail: vi.fn(() => false),
		getInputData: vi.fn(() => [{ json: {} }]),
		getNode: vi.fn(() => node),
		getNodeParameter: vi.fn((name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'sourceUrl') return sourceUrl;
			if (name === 'arguments') return '';
			return resourceConfiguration[name as keyof ResourceEnvelopeConfiguration] ?? fallback;
		}),
		getExecutionCancelSignal: vi.fn(() => signal),
		helpers: { prepareBinaryData },
	} as unknown as IExecuteFunctions;
}

function createDownloadRequestExecutor(
	context: IExecuteFunctions,
	executablePath: string,
	workspaceParent: string,
): DownloadRequestExecutor {
	return async (plan, itemIndex, resourceEnvelope, signal, authentication) =>
		await executeDownloadRequest(context, plan, itemIndex, {
			authentication,
			executablePath,
			resourceEnvelope,
			signal,
			workspaceParent,
		});
}

async function expectInvalidArtifactFixture(fixtureSource: string): Promise<void> {
	const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-invalid-set-test-'));
	temporaryDirectories.push(workspaceParent);
	const executablePath = await createArtifactFixtureExecutable(workspaceParent, fixtureSource);
	const prepareBinaryData = vi.fn();
	const context = createExecutionContext('https://example.com/playlist', prepareBinaryData);
	const startRequest = createDownloadRequestExecutor(
		context,
		executablePath,
		workspaceParent,
	);

	await expect(
		executeYtDlpNode(context, startRequest),
	).rejects.toMatchObject({
		context: { errorCode: 'INVALID_ARTIFACT_SET', itemIndex: 0 },
	});
	expect(prepareBinaryData).not.toHaveBeenCalled();
}

describe('download request', () => {
	it('uses cookie, site login, video password, and an authenticated synthetic proxy without exposing secrets', async () => {
		const fixture = Buffer.from('authenticated synthetic media');
		const siteUsername = 'site-user';
		const sitePassword = 'site-password';
		const videoPassword = 'video-password';
		const cookieValue = 'cookie-secret';
		const proxyUsername = 'proxy-user';
		const proxyPassword = 'proxy-password';
		const expectedSiteAuthorization = `Basic ${Buffer.from(`${siteUsername}:${sitePassword}`).toString('base64')}`;
		const expectedProxyAuthorization = `Basic ${Buffer.from(`${proxyUsername}:${proxyPassword}`).toString('base64')}`;
		const origin = createServer((request, response) => {
			if (
				request.headers.authorization !== expectedSiteAuthorization ||
				request.headers.cookie !== `session=${cookieValue}`
			) {
				response.writeHead(401);
				response.end('authentication required');
				return;
			}
			response.writeHead(200, { 'content-type': 'video/mp4' });
			response.end(fixture);
		});
		servers.push(origin);
		await new Promise<void>((resolve, reject) => {
			origin.once('error', reject);
			origin.listen(0, '127.0.0.1', resolve);
		});
		const originAddress = origin.address() as AddressInfo;
		const sourceUrl = `http://127.0.0.1:${originAddress.port}/fixture`;

		const proxy = createServer((request, response) => {
			if (
				request.headers['proxy-authorization'] !== expectedProxyAuthorization ||
				request.url === undefined
			) {
				response.writeHead(407);
				response.end('proxy authentication required');
				return;
			}
			const upstream = httpRequest(
				new URL(request.url),
				{
					headers: {
						authorization: request.headers.authorization,
						cookie: request.headers.cookie,
					},
				},
				(upstreamResponse) => {
					response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
					upstreamResponse.pipe(response);
				},
			);
			upstream.once('error', (error) => response.destroy(error));
			upstream.end();
		});
		servers.push(proxy);
		await new Promise<void>((resolve, reject) => {
			proxy.once('error', reject);
			proxy.listen(0, '127.0.0.1', resolve);
		});
		const proxyAddress = proxy.address() as AddressInfo;
		const proxyUrl = `http://${proxyUsername}:${proxyPassword}@127.0.0.1:${proxyAddress.port}`;

		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-authenticated-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = join(workspaceParent, 'controlled-authenticated-yt-dlp');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`const fs = require('node:fs/promises');\n` +
				`const http = require('node:http');\n` +
				`const { join } = require('node:path');\n` +
				`void (async () => {\n` +
				`const argv = process.argv.slice(2);\n` +
				`let stdin = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) stdin += chunk;\n` +
				`const config = Object.fromEntries(stdin.trimEnd().split('\\n').map(line => { const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 2, -1)]; }));\n` +
				`const sentinels = ${JSON.stringify([siteUsername, sitePassword, videoPassword, cookieValue, proxyUsername, proxyPassword])};\n` +
				`const publicProcessState = JSON.stringify({ argv, env: process.env });\n` +
				`if (sentinels.some(secret => publicProcessState.includes(secret))) throw new Error('secret escaped through argv or environment');\n` +
				`if (argv.slice(0, 3).join(' ') !== '--playlist-items 1:5 --ignore-config' || !argv.includes('--config-locations') || !argv.includes('-')) throw new Error('fixed config invocation missing');\n` +
				`if (config['--video-password'] !== ${JSON.stringify(videoPassword)}) throw new Error('video password missing');\n` +
				`const cookiePath = config['--cookies']; const cookieStat = await fs.stat(cookiePath); if ((cookieStat.mode & 0o777) !== 0o600) throw new Error('cookie mode');\n` +
				`const cookieFields = (await fs.readFile(cookiePath, 'utf8')).trim().split('\\t');\n` +
				`const proxy = new URL(config['--proxy']); const source = argv.at(-1);\n` +
				`const body = await new Promise((resolve, reject) => { const request = http.request({ hostname: proxy.hostname, port: proxy.port, path: source, headers: { 'proxy-authorization': 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64'), authorization: 'Basic ' + Buffer.from(config['--username'] + ':' + config['--password']).toString('base64'), cookie: cookieFields.at(-2) + '=' + cookieFields.at(-1) } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => response.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error('request failed: ' + response.statusCode))); }); request.once('error', reject); request.end(); });\n` +
				`const pathIndex = argv.indexOf('--paths'); const artifacts = argv[pathIndex + 1]; await fs.writeFile(join(artifacts, '000001-authenticated.mp4'), body);\n` +
				`})().catch(error => { console.error(error); process.exitCode = 1; });\n`,
			{ mode: 0o700 },
		);
		const prepareBinaryData = vi.fn(
			async (data: Buffer | Readable, fileName?: string, mimeType?: string) => ({
				data: (await collect(data as Readable)).toString('base64'),
				fileName,
				mimeType: mimeType ?? 'application/octet-stream',
			}),
		) as unknown as IExecuteFunctions['helpers']['prepareBinaryData'];
		const context = createExecutionContext(sourceUrl, prepareBinaryData);
		const cookies = `# Netscape HTTP Cookie File\r\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\t${cookieValue}\r\n`;

		const result = await executeDownloadRequest(
			context,
			{ argv: ['--playlist-items', '1:5', '--', sourceUrl] },
			0,
			{
				authentication: {
					cookies,
					username: siteUsername,
					password: sitePassword,
					videoPassword,
					proxyUrl,
				},
				executablePath,
				workspaceParent,
			},
		);

		expect(result[0].binary?.data.data).toBe(fixture.toString('base64'));
		for (const secret of [cookies, siteUsername, sitePassword, videoPassword, proxyUrl]) {
			expect(JSON.stringify(result)).not.toContain(secret);
		}
		expect(await readdir(workspaceParent)).toEqual(['controlled-authenticated-yt-dlp']);
	});

	it.each([
		{ outcome: 'Secret Config parse failure', expected: { name: 'InvalidAuthenticationError' } },
		{ outcome: 'process failure', expected: { code: 'YTDLP_FAILED' } },
		{ outcome: 'timeout', expected: { code: 'REQUEST_TIMEOUT' } },
		{ outcome: 'cancellation', expected: { name: 'YtDlpProcessCancellationError' } },
		{ outcome: 'binary transfer failure', expected: { code: 'BINARY_TRANSFER_FAILED' } },
	])('removes sentinel secrets after $outcome', async ({ outcome, expected }) => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-secret-cleanup-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = join(workspaceParent, 'controlled-secret-cleanup-yt-dlp');
		const startedPath = join(workspaceParent, 'started');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`const fs = require('node:fs/promises'); const { join } = require('node:path');\n` +
				`void (async () => { const argv = process.argv.slice(2); let stdin = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) stdin += chunk; const config = Object.fromEntries(stdin.trimEnd().split('\\n').map(line => { const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 2, -1)]; })); const cookies = await fs.readFile(config['--cookies'], 'utf8');\n` +
				(outcome === 'process failure'
					? `process.stderr.write(stdin + cookies); process.exitCode = 2; return;\n`
					: outcome === 'binary transfer failure'
						? `const pathIndex = argv.indexOf('--paths'); await fs.writeFile(join(argv[pathIndex + 1], '000001-secret.mp4'), 'artifact'); return;\n`
						: `await fs.writeFile(${JSON.stringify(startedPath)}, 'yes'); setInterval(() => {}, 1000);\n`) +
				`})().catch(error => { console.error(error); process.exitCode = 1; });\n`,
			{ mode: 0o700 },
		);
		const controller = new AbortController();
		const prepareBinaryData =
			outcome === 'binary transfer failure'
				? vi.fn().mockRejectedValue(new Error('storage failure'))
				: vi.fn();
		const context = createExecutionContext(
			'https://example.com/video',
			prepareBinaryData,
			controller.signal,
		);
		const cookieSecret = `cookie-secret-${outcome}`;
		const authentication = {
			cookies: `# Netscape HTTP Cookie File\nexample.test\tFALSE\t/\tFALSE\t0\tsession\t${cookieSecret}\n`,
			username:
				outcome === 'Secret Config parse failure'
					? `username-line\nfeed-${outcome}`
					: `username-'${outcome}`,
			password: `password-${outcome}`,
			videoPassword: `video-password-${outcome}`,
			proxyUrl: `http://proxy-user:proxy-password@proxy-${outcome.replace(/\s/g, '-')}.test`,
		};
		const resourceEnvelope = {
			...createResourceEnvelope({}),
			requestTimeoutMs: outcome === 'timeout' ? 25 : 60_000,
		};

		const request = executeDownloadRequest(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{
				authentication,
				executablePath,
				resourceEnvelope,
				signal: controller.signal,
				workspaceParent,
			},
		);
		if (outcome === 'cancellation') {
			await waitForFile(startedPath);
			controller.abort();
		}
		const error = await request.catch((cause: unknown) => cause);

		expect(error).toMatchObject(expected);
		for (const secret of Object.values(authentication)) {
			expect(JSON.stringify(error)).not.toContain(secret);
		}
		if (outcome === 'process failure') {
			expect(JSON.stringify(error)).not.toContain(`'"'"'`);
		}
		expect(
			(await readdir(workspaceParent)).filter((name) => name.startsWith('n8n-nodes-yt-dlp-')),
		).toEqual([]);
	});

	it('adds fixed config isolation and node-controlled resource limits', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-resource-argv-'));
		temporaryDirectories.push(workspaceParent);
		const observedArgumentsPath = join(workspaceParent, 'observed-arguments.json');
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(${JSON.stringify(observedArgumentsPath)}, JSON.stringify(argv));\n` +
				`await fs.writeFile(join(artifacts, '000001-video.mp4'), 'bytes');\n`,
		);
		const context = createExecutionContext('https://example.com/video', vi.fn());

		await executeDownloadRequest(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{
				executablePath,
				workspaceParent,
				resourceEnvelope: createResourceEnvelope({}),
			},
		);

		const observedArguments = JSON.parse(
			await readFile(observedArgumentsPath, 'utf8'),
		) as string[];
		expect(observedArguments).toEqual(
			expect.arrayContaining([
				'--ignore-config',
				'--config-locations',
				'-',
				'--max-filesize',
				String(128 * 1024 * 1024),
				'--concurrent-fragments',
				'1',
				'--postprocessor-args',
				'ffmpeg:-threads 1',
			]),
		);
	});

	it('classifies a real workspace overshoot as an indexed request failure', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-workspace-envelope-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(join(artifacts, '000001-video.mp4'), 'valid');\n` +
				`await fs.writeFile(join(temp, 'overshoot.part'), '');\n` +
				`await fs.truncate(join(temp, 'overshoot.part'), ${67 * 1024 * 1024});\n`,
		);
		const prepareBinaryData = vi.fn();
		const context = createExecutionContext(
			'https://example.com/video',
			prepareBinaryData,
			undefined,
			{ maximumTotalArtifactSizeMiB: 1 },
		);
		const startRequest = createDownloadRequestExecutor(
			context,
			executablePath,
			workspaceParent,
		);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'RESOURCE_LIMIT', itemIndex: 0 },
		});
		expect(prepareBinaryData).not.toHaveBeenCalled();
	});

	it.each([
		{ configuredLimit: 20, artifactCount: 20, accepted: true },
		{ configuredLimit: 20, artifactCount: 21, accepted: false },
		{ configuredLimit: 50, artifactCount: 50, accepted: true },
		{ configuredLimit: 50, artifactCount: 51, accepted: false },
	])(
		'enforces $configuredLimit configured Artifacts at $artifactCount files',
		async ({ configuredLimit, artifactCount, accepted }) => {
			const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-artifact-count-'));
			temporaryDirectories.push(workspaceParent);
			const executablePath = await createArtifactFixtureExecutable(
				workspaceParent,
				`for (let index = 1; index <= ${artifactCount}; index++) {\n` +
					`  await fs.writeFile(join(artifacts, String(index).padStart(6, '0') + '-file.mp4'), 'x');\n` +
					`}\n`,
			);
			const prepareBinaryData = vi.fn(async () => ({
				data: 'stored',
				mimeType: 'video/mp4',
			}));
			const context = createExecutionContext(
				'https://example.com/playlist',
				prepareBinaryData,
			);
			const request = executeDownloadRequest(
				context,
				{ argv: ['--', 'https://example.com/playlist'] },
				0,
				{
					executablePath,
					workspaceParent,
					resourceEnvelope: createResourceEnvelope({
						maximumArtifactCount: configuredLimit,
					}),
				},
			);

			if (accepted) {
				await expect(request).resolves.toHaveLength(artifactCount);
				expect(prepareBinaryData).toHaveBeenCalledTimes(artifactCount);
			} else {
				await expect(request).rejects.toMatchObject({
					name: 'YtDlpRequestResourceLimitError',
					code: 'RESOURCE_LIMIT',
				});
				expect(prepareBinaryData).not.toHaveBeenCalled();
			}
		},
	);

	it.each([
		{ configuredLimitMiB: 128, artifactSizeBytes: 128 * 1024 * 1024, accepted: true },
		{ configuredLimitMiB: 128, artifactSizeBytes: 128 * 1024 * 1024 + 1, accepted: false },
		{ configuredLimitMiB: 256, artifactSizeBytes: 256 * 1024 * 1024, accepted: true },
		{ configuredLimitMiB: 256, artifactSizeBytes: 256 * 1024 * 1024 + 1, accepted: false },
	])(
		'enforces a $configuredLimitMiB MiB single-Artifact limit at $artifactSizeBytes bytes',
		async ({ configuredLimitMiB, artifactSizeBytes, accepted }) => {
			const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-artifact-size-'));
			temporaryDirectories.push(workspaceParent);
			const executablePath = await createArtifactFixtureExecutable(
				workspaceParent,
				`await fs.writeFile(join(artifacts, '000001-file.mp4'), '');\n` +
					`await fs.truncate(join(artifacts, '000001-file.mp4'), ${artifactSizeBytes});\n`,
			);
			const prepareBinaryData = vi.fn(async () => ({
				data: 'stored',
				mimeType: 'video/mp4',
			}));
			const context = createExecutionContext(
				'https://example.com/video',
				prepareBinaryData,
			);
			const request = executeDownloadRequest(
				context,
				{ argv: ['--', 'https://example.com/video'] },
				0,
				{
					executablePath,
					workspaceParent,
					resourceEnvelope: createResourceEnvelope({
						maximumArtifactSizeMiB: configuredLimitMiB,
					}),
				},
			);

			if (accepted) {
				await expect(request).resolves.toHaveLength(1);
				expect(prepareBinaryData).toHaveBeenCalledOnce();
			} else {
				await expect(request).rejects.toMatchObject({
					name: 'YtDlpRequestResourceLimitError',
					code: 'RESOURCE_LIMIT',
				});
				expect(prepareBinaryData).not.toHaveBeenCalled();
			}
		},
	);

	it.each([
		{
			configuredLimitMiB: 256,
			artifactSizesBytes: [100 * 1024 * 1024, 100 * 1024 * 1024, 56 * 1024 * 1024],
			accepted: true,
		},
		{
			configuredLimitMiB: 256,
			artifactSizesBytes: [
				100 * 1024 * 1024,
				100 * 1024 * 1024,
				56 * 1024 * 1024 + 1,
			],
			accepted: false,
		},
		{
			configuredLimitMiB: 512,
			artifactSizesBytes: [200 * 1024 * 1024, 200 * 1024 * 1024, 112 * 1024 * 1024],
			accepted: true,
		},
		{
			configuredLimitMiB: 512,
			artifactSizesBytes: [
				200 * 1024 * 1024,
				200 * 1024 * 1024,
				112 * 1024 * 1024 + 1,
			],
			accepted: false,
		},
	])(
		'enforces a $configuredLimitMiB MiB final-total limit',
		async ({ configuredLimitMiB, artifactSizesBytes, accepted }) => {
			const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-total-size-'));
			temporaryDirectories.push(workspaceParent);
			const fixtureSource = artifactSizesBytes
				.map(
					(size, index) =>
						`await fs.writeFile(join(artifacts, '${String(index + 1).padStart(6, '0')}-file.mp4'), '');\n` +
						`await fs.truncate(join(artifacts, '${String(index + 1).padStart(6, '0')}-file.mp4'), ${size});\n`,
				)
				.join('');
			const executablePath = await createArtifactFixtureExecutable(
				workspaceParent,
				fixtureSource,
			);
			const prepareBinaryData = vi.fn(async () => ({
				data: 'stored',
				mimeType: 'video/mp4',
			}));
			const context = createExecutionContext(
				'https://example.com/playlist',
				prepareBinaryData,
			);
			const request = executeDownloadRequest(
				context,
				{ argv: ['--', 'https://example.com/playlist'] },
				0,
				{
					executablePath,
					workspaceParent,
					resourceEnvelope: createResourceEnvelope({
						maximumArtifactSizeMiB: 256,
						maximumTotalArtifactSizeMiB: configuredLimitMiB,
					}),
				},
			);

			if (accepted) {
				await expect(request).resolves.toHaveLength(artifactSizesBytes.length);
				expect(prepareBinaryData).toHaveBeenCalledTimes(artifactSizesBytes.length);
			} else {
				await expect(request).rejects.toMatchObject({
					name: 'YtDlpRequestResourceLimitError',
					code: 'RESOURCE_LIMIT',
				});
				expect(prepareBinaryData).not.toHaveBeenCalled();
			}
		},
	);

	it('returns every Artifact Item in deterministic basename order', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-multi-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(join(artifacts, '000002-video.webm'), 'video bytes');\n` +
				`await fs.writeFile(join(artifacts, '000001-audio.m4a'), 'audio bytes');\n`,
		);
		const prepareBinaryDataMock = vi.fn(
			async (data: Buffer | Readable, fileName?: string, mimeType?: string) => ({
				data: (await collect(data as Readable)).toString('utf8'),
				fileName,
				mimeType: mimeType ?? 'application/octet-stream',
			}),
		);
		const prepareBinaryData =
			prepareBinaryDataMock as unknown as IExecuteFunctions['helpers']['prepareBinaryData'];
		const context = createExecutionContext('https://example.com/playlist', prepareBinaryData);

		const result = await executeDownloadRequest(
			context,
			{ argv: ['--', 'https://example.com/playlist'] },
			3,
			{ executablePath, workspaceParent },
		);

		expect(result).toEqual([
			{
				json: {
					status: 'success',
					artifactIndex: 1,
					artifactCount: 2,
					fileName: '000001-audio.m4a',
					mimeType: 'audio/mp4',
					sizeBytes: 11,
				},
				binary: {
					data: {
						data: 'audio bytes',
						fileName: '000001-audio.m4a',
						mimeType: 'audio/mp4',
					},
				},
				pairedItem: { item: 3 },
			},
			{
				json: {
					status: 'success',
					artifactIndex: 2,
					artifactCount: 2,
					fileName: '000002-video.webm',
					mimeType: 'video/webm',
					sizeBytes: 11,
				},
				binary: {
					data: {
						data: 'video bytes',
						fileName: '000002-video.webm',
						mimeType: 'video/webm',
					},
				},
				pairedItem: { item: 3 },
			},
		]);
		expect(prepareBinaryDataMock.mock.calls.map(([, fileName]) => fileName)).toEqual([
			'000001-audio.m4a',
			'000002-video.webm',
		]);
	});

	it('classifies binary storage rejection as an indexed request failure', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-binary-failure-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(join(artifacts, '000001-video.mp4'), 'video');\n`,
		);
		const prepareBinaryData = vi.fn().mockRejectedValue(new Error('storage detail'));
		const context = createExecutionContext(
			'https://example.com/video',
			prepareBinaryData,
		);
		const startRequest = createDownloadRequestExecutor(
			context,
			executablePath,
			workspaceParent,
		);

		await expect(executeYtDlpNode(context, startRequest)).rejects.toMatchObject({
			context: { errorCode: 'BINARY_TRANSFER_FAILED', itemIndex: 0 },
		});
		expect(prepareBinaryData).toHaveBeenCalledOnce();
	});

	it.each([
		{
			kind: 'symlink',
			fixtureSource:
				`await fs.writeFile(join(artifacts, '000001-valid.mp4'), 'valid');\n` +
				`await fs.writeFile(join(process.cwd(), '..', 'outside.mp4'), 'outside');\n` +
				`await fs.symlink(join(process.cwd(), '..', 'outside.mp4'), join(artifacts, '000002-link.mp4'));\n`,
		},
		{
			kind: 'hardlink',
			fixtureSource:
				`await fs.writeFile(join(artifacts, '000001-valid.mp4'), 'valid');\n` +
				`await fs.writeFile(join(process.cwd(), '..', 'outside.mp4'), 'outside');\n` +
				`await fs.link(join(process.cwd(), '..', 'outside.mp4'), join(artifacts, '000002-hardlink.mp4'));\n`,
		},
	])('publishes no Artifact Item when the set contains a $kind', async ({ fixtureSource }) => {
		await expectInvalidArtifactFixture(fixtureSource);
	});

	it.each([
		{
			name: 'zero final files',
			fixtureSource: '',
		},
		{
			name: 'a nested directory',
			fixtureSource: `await fs.mkdir(join(artifacts, 'nested'));\n`,
		},
		{
			name: 'a FIFO',
			fixtureSource:
				`require('node:child_process').execFileSync('mkfifo', [join(artifacts, 'pipe')]);\n`,
		},
		{
			name: 'a traversal outside the Artifact Directory',
			fixtureSource:
				`await fs.writeFile(join(artifacts, '000001-valid.mp4'), 'valid');\n` +
				`await fs.writeFile(join(artifacts, '..', 'escaped.mp4'), 'escaped');\n`,
		},
		{
			name: 'temporary residue',
			fixtureSource:
				`await fs.writeFile(join(artifacts, '000001-valid.mp4'), 'valid');\n` +
				`await fs.writeFile(join(temp, 'partial.part'), 'partial');\n`,
		},
		{
			name: 'control residue',
			fixtureSource:
				`await fs.writeFile(join(artifacts, '000001-valid.mp4'), 'valid');\n` +
				`await fs.writeFile(join(control, 'unexpected'), 'unexpected');\n`,
		},
	])('publishes no Artifact Item when the request leaves $name', async ({ fixtureSource }) => {
		await expectInvalidArtifactFixture(fixtureSource);
	});

	it.each(['regular-file replacement', 'symlink replacement'])(
		'rejects a %s between lstat and descriptor validation',
		async (replacementKind) => {
			const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-race-test-'));
			temporaryDirectories.push(workspaceParent);
			const executablePath = await createArtifactFixtureExecutable(
				workspaceParent,
				`await fs.writeFile(join(artifacts, '000001-race.mp4'), 'original');\n`,
			);
			const replacementPath = join(workspaceParent, 'replacement.mp4');
			await writeFile(replacementPath, 'replacement');
			artifactRaceControl.afterLstat = async (artifactPath) => {
				if (!artifactPath.endsWith('000001-race.mp4')) return;
				artifactRaceControl.afterLstat = undefined;
				await unlink(artifactPath);
				if (replacementKind === 'symlink replacement') {
					await symlink(replacementPath, artifactPath);
				} else {
					await writeFile(artifactPath, 'replacement');
				}
			};
			const prepareBinaryData = vi.fn();
			const context = createExecutionContext(
				'https://example.com/video',
				prepareBinaryData,
			);

			await expect(
				executeDownloadRequest(
					context,
					{ argv: ['--', 'https://example.com/video'] },
					0,
					{ executablePath, workspaceParent },
				),
			).rejects.toThrow();
			expect(prepareBinaryData).not.toHaveBeenCalled();
		},
	);

	it('rejects an earlier Artifact inode swap during later-candidate validation', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-late-race-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(join(artifacts, '000001-first.mp4'), 'first');\n` +
				`await fs.writeFile(join(artifacts, '000002-second.mp4'), 'second');\n`,
		);
		artifactRaceControl.afterLstat = async (artifactPath) => {
			if (!artifactPath.endsWith('000002-second.mp4')) return;
			artifactRaceControl.afterLstat = undefined;
			const artifactsDirectory = await realpath(dirname(artifactPath));
			const earlierArtifact = join(artifactsDirectory, '000001-first.mp4');
			await unlink(earlierArtifact);
			await writeFile(earlierArtifact, 'replacement');
		};
		const prepareBinaryData = vi.fn();
		const context = createExecutionContext(
			'https://example.com/playlist',
			prepareBinaryData,
		);

		await expect(
			executeDownloadRequest(
				context,
				{ argv: ['--', 'https://example.com/playlist'] },
				0,
				{ executablePath, workspaceParent },
			),
		).rejects.toThrow();
		expect(prepareBinaryData).not.toHaveBeenCalled();
	});

	it.each(['temp', 'control'])(
		'rejects residue hidden by replacing the %s directory',
		async (directoryName) => {
			await expectInvalidArtifactFixture(
				`await fs.writeFile(join(artifacts, '000001-valid.mp4'), 'valid');\n` +
					`const residueDirectory = ${directoryName};\n` +
					`await fs.writeFile(join(residueDirectory, 'hidden'), 'hidden');\n` +
					`await fs.rename(residueDirectory, join(process.cwd(), '..', 'hidden-${directoryName}'));\n` +
					`await fs.mkdir(residueDirectory, { mode: 0o700 });\n`,
			);
		},
	);

	it('rejects an Artifact Directory parent symlink swap', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-parent-race-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(join(artifacts, '000001-race.mp4'), 'original');\n`,
		);
		const replacementDirectory = join(workspaceParent, 'replacement-artifacts');
		await mkdir(replacementDirectory);
		artifactRaceControl.afterLstat = async (artifactPath) => {
			if (!artifactPath.endsWith('000001-race.mp4')) return;
			artifactRaceControl.afterLstat = undefined;
			const artifactsDirectory = await realpath(dirname(artifactPath));
			await rename(artifactPath, join(replacementDirectory, '000001-race.mp4'));
			await rename(artifactsDirectory, join(workspaceParent, 'original-artifacts'));
			await symlink(replacementDirectory, artifactsDirectory, 'dir');
		};
		const prepareBinaryData = vi.fn();
		const context = createExecutionContext(
			'https://example.com/video',
			prepareBinaryData,
		);

		await expect(
			executeDownloadRequest(
				context,
				{ argv: ['--', 'https://example.com/video'] },
				0,
				{ executablePath, workspaceParent },
			),
		).rejects.toThrow();
		expect(prepareBinaryData).not.toHaveBeenCalled();
	});

	it('keeps reads anchored during a temporary Artifact Directory symlink swap', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-parent-anchor-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createArtifactFixtureExecutable(
			workspaceParent,
			`await fs.writeFile(join(artifacts, '000001-race.mp4'), 'original');\n`,
		);
		const replacementDirectory = join(workspaceParent, 'replacement-artifacts');
		const savedDirectory = join(workspaceParent, 'saved-artifacts');
		await mkdir(replacementDirectory);
		await writeFile(join(replacementDirectory, '000001-race.mp4'), 'external');
		let artifactsDirectory = '';
		artifactRaceControl.beforeLstat = async (artifactPath) => {
			if (!artifactPath.endsWith('000001-race.mp4')) return;
			artifactRaceControl.beforeLstat = undefined;
			artifactsDirectory = await realpath(dirname(artifactPath));
			await rename(artifactsDirectory, savedDirectory);
			await symlink(replacementDirectory, artifactsDirectory, 'dir');
		};
		artifactRaceControl.afterOpen = async (artifactPath) => {
			if (!artifactPath.endsWith('000001-race.mp4')) return;
			artifactRaceControl.afterOpen = undefined;
			await unlink(artifactsDirectory);
			await rename(savedDirectory, artifactsDirectory);
		};
		const prepareBinaryData = vi.fn(
			async (data: Buffer | Readable, fileName?: string, mimeType?: string) => ({
				data: (await collect(data as Readable)).toString('utf8'),
				fileName,
				mimeType: mimeType ?? 'application/octet-stream',
			}),
		);
		const context = createExecutionContext(
			'https://example.com/video',
			prepareBinaryData,
		);

		const result = await executeDownloadRequest(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{ executablePath, workspaceParent },
		);

		expect(result[0].binary?.data.data).toBe('original');
	});

	it('forwards n8n cancellation and cleans up only after process close', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-cancel-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = join(workspaceParent, 'controlled-yt-dlp');
		const startedPath = join(workspaceParent, 'started');
		const closedPath = join(workspaceParent, 'closed');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`const { writeFileSync } = require('node:fs');\n` +
				`writeFileSync(${JSON.stringify(startedPath)}, 'yes');\n` +
				`process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(closedPath)}, 'yes'); setTimeout(() => process.exit(0), 150); });\n` +
				`setInterval(() => {}, 1000);\n` +
				`setTimeout(() => process.exit(0), 500);\n`,
			{ mode: 0o700 },
		);
		const controller = new AbortController();
		const context = createExecutionContext(
			'https://example.com/video',
			vi.fn(),
			controller.signal,
		);
		const request = executeDownloadRequest(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{ executablePath, workspaceParent },
		);
		await waitForFile(startedPath);

		controller.abort();
		await waitForFile(closedPath);
		expect(await readdir(workspaceParent)).toEqual(
			expect.arrayContaining([expect.stringMatching(/^n8n-nodes-yt-dlp-/)]),
		);

		await expect(request).rejects.toMatchObject({ name: 'YtDlpProcessCancellationError' });
		expect(await readFile(closedPath, 'utf8')).toBe('yes');
		expect((await readdir(workspaceParent)).sort()).toEqual([
			'closed',
			'controlled-yt-dlp',
			'started',
		]);
	});

	it('does not clean the request workspace under a live process after termination failure', async () => {
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-invariant-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = join(workspaceParent, 'controlled-yt-dlp');
		const startedPath = join(workspaceParent, 'started');
		await writeFile(
			executablePath,
			`#!${process.execPath}\n` +
				`const { writeFileSync } = require('node:fs');\n` +
				`writeFileSync(${JSON.stringify(startedPath)}, 'yes');\n` +
				`setInterval(() => {}, 1000);\n` +
				`setTimeout(() => process.exit(0), 300);\n`,
			{ mode: 0o700 },
		);
		const controller = new AbortController();
		const context = createExecutionContext(
			'https://example.com/video',
			vi.fn(),
			controller.signal,
		);
		const request = executeDownloadRequest(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{
				authentication: {
					cookies: '# Netscape HTTP Cookie File\nexample.test\tFALSE\t/\tFALSE\t0\tsession\tlive-cookie-secret\n',
				},
				executablePath,
				workspaceParent,
			},
		);
		await waitForFile(startedPath);
		const signalError = Object.assign(new Error('signal denied'), { code: 'EPERM' });
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
			throw signalError;
		});

		try {
			controller.abort();
			await expect(request).rejects.toMatchObject({
				name: 'YtDlpProcessTerminationError',
				processClosed: false,
			});
		} finally {
			kill.mockRestore();
		}

		const requestWorkspace = (await readdir(workspaceParent)).find((name) =>
			name.startsWith('n8n-nodes-yt-dlp-'),
		);
		expect(requestWorkspace).toBeDefined();
		expect(
			await readFile(join(workspaceParent, requestWorkspace!, 'control', 'cookies.txt'), 'utf8'),
		).toContain('live-cookie-secret');
	});

	it.each([
		{ extension: 'mp4', expectedMimeType: 'video/mp4' },
		{ extension: 'webm', expectedMimeType: 'video/webm' },
		{ extension: 'aiff', expectedMimeType: 'audio/aiff' },
		{ extension: 'alac', expectedMimeType: 'audio/alac' },
		{ extension: 'gif', expectedMimeType: 'image/gif' },
		{ extension: 'mka', expectedMimeType: 'audio/x-matroska' },
		{ extension: 'vorbis', expectedMimeType: 'audio/vorbis' },
		{ extension: 'unknown', expectedMimeType: 'application/octet-stream' },
	])('returns a .$extension local synthetic download as one Artifact Item', async ({
		extension,
		expectedMimeType,
	}) => {
		const fixture = Buffer.from('synthetic media bytes');
		const sourceUrl = await startSyntheticOrigin(fixture);
		const workspaceParent = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-test-'));
		temporaryDirectories.push(workspaceParent);
		const executablePath = await createControlledExecutable(workspaceParent, extension);
		const prepareBinaryData = vi.fn(async (data: Buffer | Readable, fileName?: string, mimeType?: string) => ({
			data: (await collect(data as Readable)).toString('base64'),
			fileName,
			mimeType: mimeType ?? 'application/octet-stream',
		})) as unknown as IExecuteFunctions['helpers']['prepareBinaryData'];
		const context = createExecutionContext(sourceUrl, prepareBinaryData);
		const startRequest = createDownloadRequestExecutor(
			context,
			executablePath,
			workspaceParent,
		);

		const result = await executeYtDlpNode(context, startRequest);

		expect(result).toEqual([
			[
				{
					json: {
						status: 'success',
						artifactIndex: 1,
						artifactCount: 1,
						fileName: `000001-fixture.${extension}`,
						mimeType: expectedMimeType,
						sizeBytes: fixture.byteLength,
					},
					binary: {
						data: {
							data: fixture.toString('base64'),
							fileName: `000001-fixture.${extension}`,
							mimeType: expectedMimeType,
						},
					},
					pairedItem: { item: 0 },
				},
			],
		]);
		expect(prepareBinaryData).toHaveBeenCalledWith(
			expect.anything(),
			`000001-fixture.${extension}`,
			expectedMimeType,
		);
		expect(await readdir(workspaceParent)).toEqual(['controlled-yt-dlp']);
		expect(JSON.stringify(result)).not.toContain('process-output-must-not-be-returned');
		expect(JSON.stringify(result)).not.toContain(workspaceParent);
	});
});
