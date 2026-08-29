import { execFile } from 'node:child_process';
import { mkdtemp, opendir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import type { IBinaryData, IExecuteFunctions, INode } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { executeYtDlpNode } from '../nodes/YtDlp/YtDlp.node';
import {
	MEBIBYTE,
	TOOLCHAIN_RUNTIME_BASELINE_BYTES,
	WORKSPACE_DISK_RESERVE_BYTES,
	createResourceEnvelope,
} from '../nodes/YtDlp/resource-envelope';

const execFileAsync = promisify(execFile);
const toolchainDirectory = resolve('packages', 'linux-x64', 'bin');
const ffmpegPath = join(toolchainDirectory, 'ffmpeg');
const ytDlpPath = join(toolchainDirectory, 'yt-dlp');

let fixtureDirectory: string;
let origin: Server;
let originUrl: string;

/** Mirrors the apparent-size accounting the workspace watcher applies in `process.ts`. */
async function apparentSize(path: string): Promise<number> {
	const entryStat = await stat(path);
	if (!entryStat.isDirectory()) return entryStat.size;
	let size = entryStat.size;
	const directory = await opendir(path);
	for await (const entry of directory) {
		try {
			size += await apparentSize(join(path, entry.name));
		} catch {
			// The PyInstaller unpack directory is removed while it is being walked.
		}
	}
	return size;
}

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function createExecutionContext(sourceUrl: string): IExecuteFunctions {
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
		getExecutionCancelSignal: vi.fn(() => undefined),
		getExecutionId: vi.fn(() => 'resource-envelope-workspace-execution'),
		getInputData: vi.fn(() => [{ json: {} }]),
		getNode: vi.fn(() => node),
		getNodeParameter: vi.fn((name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'sourceUrl') return sourceUrl;
			if (name === 'arguments') return '';
			return fallback;
		}),
		helpers: {
			prepareBinaryData: vi.fn(
				async (
					data: Buffer | Readable,
					fileName?: string,
					mimeType?: string,
				): Promise<IBinaryData> => ({
					data: (await collect(data as Readable)).toString('base64'),
					fileName,
					mimeType: mimeType ?? 'application/octet-stream',
				}),
			),
		},
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IExecuteFunctions;
}

beforeAll(async () => {
	fixtureDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-envelope-workspace-'));
	await execFileAsync(ffmpegPath, [
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
		join(fixtureDirectory, 'video.mp4'),
	]);

	origin = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? '/', 'http://fixture.test').pathname;
		try {
			const body = await readFile(join(fixtureDirectory, pathname.slice(1)));
			// A real origin advertises the size of a static file, and this measures a Resource
			// Envelope term against the real toolchain — an origin that hides the size sends yt-dlp
			// down a different envelope path. See `docs/agents/test-adapters.md`.
			response.writeHead(200, {
				'content-length': String(body.byteLength),
				'content-type': 'video/mp4',
			});
			response.end(body);
		} catch {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		origin.once('error', rejectListen);
		origin.listen(0, '127.0.0.1', resolveListen);
	});
	originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
	if (origin) await new Promise<void>((resolveClose) => origin.close(() => resolveClose()));
	if (fixtureDirectory) await rm(fixtureDirectory, { force: true, recursive: true });
});

describe('Resource Envelope workspace accounting', () => {
	it('returns the Artifact of a request the real toolchain runs inside its workspace', async () => {
		const context = createExecutionContext(`${originUrl}/video.mp4`);

		const [items] = await executeYtDlpNode(context);

		expect(items.map(({ json }) => json.status)).toEqual(['success']);
		expect(items[0].json).toMatchObject({
			status: 'success',
			artifactIndex: 1,
			artifactCount: 1,
			mimeType: 'video/mp4',
		});
		expect(items[0].json.sizeBytes).toBeLessThan(1024 * 1024);
	}, 120_000);

	it('keeps the pinned toolchain baseline inside the smallest derived workspace limit', async () => {
		const runtimeDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-toolchain-baseline-'));
		let peakBytes = 0;
		try {
			const run = execFileAsync(ytDlpPath, ['--version'], {
				env: { HOME: runtimeDirectory, TMPDIR: runtimeDirectory },
			});
			let sampling = true;
			const sampler = (async () => {
				while (sampling) {
					peakBytes = Math.max(peakBytes, await apparentSize(runtimeDirectory));
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
				}
			})();
			await run;
			sampling = false;
			await sampler;
		} finally {
			await rm(runtimeDirectory, { force: true, recursive: true });
		}

		// yt-dlp unpacks its PyInstaller payload into the workspace, so the baseline is real
		// disk pressure that the envelope must both cover and refuse to charge to the user.
		expect(peakBytes).toBeGreaterThan(0);
		expect(peakBytes).toBeLessThan(TOOLCHAIN_RUNTIME_BASELINE_BYTES);

		// The derivation refuses any free disk that does not clear the baseline, so this is the
		// smallest workspace bound a Download Request can be given at all.
		const smallestEnvelope = createResourceEnvelope(
			{},
			{
				binaryData: { mode: 'database', maximumFileSizeBytes: MEBIBYTE },
				availableWorkspaceBytes:
					TOOLCHAIN_RUNTIME_BASELINE_BYTES + WORKSPACE_DISK_RESERVE_BYTES + MEBIBYTE,
			},
		);
		expect(smallestEnvelope.maximumWorkspaceSizeBytes).toBeGreaterThan(peakBytes);
	}, 60_000);
});
