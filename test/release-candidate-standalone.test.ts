import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
	);
});

describe('standalone release candidate commands', () => {
	it('audits the registry without installed build dependencies', async () => {
		const root = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-standalone-audit-'));
		temporaryRoots.push(root);
		await mkdir(join(root, 'scripts'));
		await cp(resolve('scripts/release-candidate.mjs'), join(root, 'scripts', 'release-candidate.mjs'));
		const candidatePath = join(root, 'release-candidate.json');
		const outputPath = join(root, 'partial-publish-audit.json');
		await writeFile(
			candidatePath,
			`${JSON.stringify({
				schemaVersion: 1,
				version: '0.2.0',
				packages: [
					{ name: 'n8n-nodes-yt-dlp-linux-x64' },
					{ name: 'n8n-nodes-yt-dlp-platform' },
					{ name: 'n8n-nodes-yt-dlp' },
				],
			})}\n`,
		);
		const server = createServer((_request, response) => {
			response.statusCode = 404;
			response.end();
		});
		await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
		try {
			const address = server.address() as AddressInfo;
			await execFileAsync(
				process.execPath,
				[
					join(root, 'scripts', 'release-candidate.mjs'),
					'audit-registry',
					candidatePath,
					`http://127.0.0.1:${address.port}`,
					outputPath,
				],
				{ cwd: root },
			);
			const audit = JSON.parse(await readFile(outputPath, 'utf8')) as {
				missing: string[];
				published: string[];
				unexpected: unknown[];
			};
			expect(audit).toMatchObject({
				missing: [
					'n8n-nodes-yt-dlp-linux-x64',
					'n8n-nodes-yt-dlp-platform',
					'n8n-nodes-yt-dlp',
				],
				published: [],
				unexpected: [],
			});
		} finally {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
			});
		}
	});
});
