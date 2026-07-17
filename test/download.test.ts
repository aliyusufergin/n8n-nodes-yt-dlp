import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type { IBinaryData, IExecuteFunctions, INode } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	executeYtDlpNode,
	type DownloadRequestExecutor,
} from '../nodes/YtDlp/YtDlp.node';
import { executeSingleFileDownload } from '../nodes/YtDlp/download';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
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

function createExecutionContext(
	sourceUrl: string,
	prepareBinaryData: (data: Buffer | Readable, fileName?: string, mimeType?: string) => Promise<IBinaryData>,
	signal?: AbortSignal,
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
		getInputData: vi.fn(() => [{ json: {} }]),
		getNode: vi.fn(() => node),
		getNodeParameter: vi.fn((name: string) => (name === 'sourceUrl' ? sourceUrl : '')),
		getExecutionCancelSignal: vi.fn(() => signal),
		helpers: { prepareBinaryData },
	} as unknown as IExecuteFunctions;
}

describe('single-file download request', () => {
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
				`process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(closedPath)}, 'yes'); setTimeout(() => process.exit(0), 25); });\n` +
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
		const request = executeSingleFileDownload(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{ executablePath, workspaceParent },
		);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await readFile(startedPath);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return Promise.reject(error);
				await delay(10);
			}
		}

		controller.abort();

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
		const request = executeSingleFileDownload(
			context,
			{ argv: ['--', 'https://example.com/video'] },
			0,
			{ executablePath, workspaceParent },
		);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await readFile(startedPath);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return Promise.reject(error);
				await delay(10);
			}
		}
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

		expect(await readdir(workspaceParent)).toEqual(
			expect.arrayContaining([expect.stringMatching(/^n8n-nodes-yt-dlp-/)]),
		);
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
		const startRequest: DownloadRequestExecutor = async (plan, itemIndex) =>
			await executeSingleFileDownload(context, plan, itemIndex, {
				executablePath,
				workspaceParent,
			});

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
