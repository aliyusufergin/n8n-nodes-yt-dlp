import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill('SIGTERM');
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await rm(directory, { force: true, recursive: true });
		}),
	);
});

async function startService(
	script: string,
	environment: Record<string, string>,
): Promise<Record<string, number>> {
	// eslint-disable-next-line @n8n/community-nodes/no-dangerous-functions -- Starts fixed local E2E fixture scripts, never user-controlled commands.
	const child = spawn(process.execPath, [resolve(script)], {
		env: { ...process.env, ...environment },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);

	return await new Promise<Record<string, number>>((resolveStart, rejectStart) => {
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => rejectStart(new Error(`Service start timed out: ${stderr}`)), 5_000);
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.once('error', rejectStart);
		child.once('exit', (code) => {
			rejectStart(new Error(`Service exited with ${code}: ${stderr}`));
		});
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
			const newline = stdout.indexOf('\n');
			if (newline < 0) return;
			clearTimeout(timer);
			resolveStart(JSON.parse(stdout.slice(0, newline)) as Record<string, number>);
		});
	});
}

async function httpRequest(options: {
	body?: Buffer;
	headers?: Record<string, string>;
	method?: string;
	port: number;
	path: string;
}): Promise<{ body: Buffer; statusCode: number }> {
	return await new Promise((resolveRequest, rejectRequest) => {
		const clientRequest = request(
			{
				headers: options.headers,
				host: '127.0.0.1',
				method: options.method ?? 'GET',
				path: options.path,
				port: options.port,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.once('end', () => {
					resolveRequest({
						body: Buffer.concat(chunks),
						statusCode: response.statusCode ?? 0,
					});
				});
			},
		);
		clientRequest.once('error', rejectRequest);
		clientRequest.end(options.body);
	});
}

describe('n8n 2.27.4 E2E support services', () => {
	it('round-trips fixture bytes and enforces origin and proxy credentials', async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-e2e-fixture-'));
		temporaryDirectories.push(fixtureRoot);
		const fixture = Buffer.from('project-generated fixture');
		await writeFile(join(fixtureRoot, 'direct.mp4'), fixture);

		const { originPort, proxyPort } = await startService(
			'e2e/n8n-2.27.4/fixture-server.mjs',
			{
				FIXTURE_ROOT: fixtureRoot,
				ORIGIN_PORT: '0',
				PROXY_PORT: '0',
			},
		);

		const hashResponse = await httpRequest({
			body: fixture,
			method: 'POST',
			path: '/hash',
			port: originPort,
		});
		expect(hashResponse.statusCode).toBe(200);
		expect(JSON.parse(hashResponse.body.toString('utf8'))).toEqual({
			base64: fixture.toString('base64'),
			sha256: '5689885f71084ff9f1ea87974f4407db4b36a501f2793079ec3ba13cb44ef070',
			sizeBytes: fixture.byteLength,
		});

		const unauthorized = await httpRequest({ path: '/auth.mp4', port: originPort });
		expect(unauthorized.statusCode).toBe(401);

		const proxyAuthorization = `Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`;
		const siteAuthorization = `Basic ${Buffer.from('site-user:site-password').toString('base64')}`;
		const authorized = await httpRequest({
			headers: {
				authorization: siteAuthorization,
				cookie: 'session=cookie-secret',
				'proxy-authorization': proxyAuthorization,
			},
			path: `http://fixture:${originPort}/auth.mp4`,
			port: proxyPort,
		});
		expect(authorized).toEqual({ body: fixture, statusCode: 200 });
	});

	it('serves only prepared package metadata and exact tarball bytes', async () => {
		const registryRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-e2e-registry-'));
		temporaryDirectories.push(registryRoot);
		await mkdir(join(registryRoot, 'tarballs'));
		const tarball = Buffer.from('exact tarball');
		await writeFile(join(registryRoot, 'tarballs', 'package.tgz'), tarball);
		await writeFile(
			join(registryRoot, 'registry.json'),
			JSON.stringify({
				'n8n-nodes-yt-dlp': {
					'dist-tags': { next: '0.2.0' },
					name: 'n8n-nodes-yt-dlp',
					versions: {
						'0.2.0': {
							dist: {
								integrity: 'sha512-test',
								shasum: 'test',
								tarball:
									'https://registry.npmjs.org/n8n-nodes-yt-dlp/-/package.tgz',
							},
							name: 'n8n-nodes-yt-dlp',
							version: '0.2.0',
						},
					},
				},
			}),
		);

		const { registryPort } = await startService(
			'e2e/n8n-2.27.4/registry-server.mjs',
			{
				REGISTRY_PORT: '0',
				REGISTRY_ROOT: registryRoot,
			},
		);

		const metadata = await httpRequest({
			path: '/n8n-nodes-yt-dlp',
			port: registryPort,
		});
		expect(metadata.statusCode).toBe(200);
		expect(JSON.parse(metadata.body.toString('utf8'))).toMatchObject({
			name: 'n8n-nodes-yt-dlp',
			'dist-tags': { next: '0.2.0' },
		});

		const packageStatus = await httpRequest({
			method: 'POST',
			path: '/api/package',
			port: registryPort,
		});
		expect(packageStatus.statusCode).toBe(200);
		expect(JSON.parse(packageStatus.body.toString('utf8'))).toEqual({ status: 'OK' });

		const downloaded = await httpRequest({
			path: '/n8n-nodes-yt-dlp/-/package.tgz',
			port: registryPort,
		});
		expect(downloaded).toEqual({ body: tarball, statusCode: 200 });

		const missing = await httpRequest({ path: '/other-package', port: registryPort });
		expect(missing.statusCode).toBe(404);
	});
});
