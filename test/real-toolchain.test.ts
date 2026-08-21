import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import type {
	IBinaryData,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
} from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { executeYtDlpNode } from '../nodes/YtDlp/YtDlp.node';
import { MEBIBYTE } from '../nodes/YtDlp/resource-envelope';

const execFileAsync = promisify(execFile);
const toolchainDirectory = resolve('packages', 'linux-x64', 'bin');
const ffmpegPath = join(toolchainDirectory, 'ffmpeg');
const ffprobePath = join(toolchainDirectory, 'ffprobe');

let fixtureDirectory: string;
let origin: Server;
let originUrl: string;
/** Bytes the size-withholding route has fully flushed, so a test can tell a completed download
 * from an early abort without reaching into error internals. */
let chunkedBytesServed = 0;

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function contentType(pathname: string): string {
	if (pathname.endsWith('.jpg')) return 'image/jpeg';
	if (pathname.endsWith('.m4a')) return 'audio/mp4';
	if (pathname.endsWith('.m4s')) return 'video/iso.segment';
	if (pathname.endsWith('.mkv')) return 'video/x-matroska';
	if (pathname.endsWith('.mpd')) return 'application/dash+xml';
	if (pathname.endsWith('.mp4')) return 'video/mp4';
	if (pathname.endsWith('.vtt')) return 'text/vtt';
	if (pathname.endsWith('.webm')) return 'video/webm';
	return 'text/html; charset=utf-8';
}

function createExecutionContext(
	sourceUrl: string,
	argumentsValue: string,
	envelopeParameters: Readonly<Record<string, number>> = {},
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
		getExecutionCancelSignal: vi.fn(() => undefined),
		getExecutionId: vi.fn(() => 'real-toolchain-execution'),
		getInputData: vi.fn(() => [{ json: {} }]),
		getNode: vi.fn(() => node),
		getNodeParameter: vi.fn((name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'sourceUrl') return sourceUrl;
			if (name === 'arguments') return argumentsValue;
			return envelopeParameters[name] ?? fallback;
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

function artifactBytes(item: INodeExecutionData): Buffer {
	const encoded = item.binary?.data.data;
	if (typeof encoded !== 'string') throw new Error('The Artifact fixture has no binary data.');
	return Buffer.from(encoded, 'base64');
}

async function probeArtifact<T>(
	item: INodeExecutionData,
	fileName: string,
	showEntries: string,
): Promise<T> {
	const artifactPath = join(fixtureDirectory, fileName);
	await writeFile(artifactPath, artifactBytes(item));
	const { stdout } = await execFileAsync(ffprobePath, [
		'-v',
		'error',
		'-show_entries',
		showEntries,
		'-of',
		'json',
		artifactPath,
	]);
	return JSON.parse(stdout) as T;
}

beforeAll(async () => {
	fixtureDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-real-toolchain-'));
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
	await execFileAsync(ffmpegPath, [
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
		join(fixtureDirectory, 'audio.m4a'),
	]);
	await execFileAsync(
		ffmpegPath,
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-i',
			join(fixtureDirectory, 'video.mp4'),
			'-i',
			join(fixtureDirectory, 'audio.m4a'),
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
			join(fixtureDirectory, 'manifest.mpd'),
		],
		{ cwd: fixtureDirectory },
	);
	await execFileAsync(ffmpegPath, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		join(fixtureDirectory, 'video.mp4'),
		'-i',
		join(fixtureDirectory, 'audio.m4a'),
		'-map',
		'0:v:0',
		'-map',
		'1:a:0',
		'-c',
		'copy',
		join(fixtureDirectory, 'combined.mp4'),
	]);
	await execFileAsync(ffmpegPath, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		join(fixtureDirectory, 'combined.mp4'),
		'-c',
		'copy',
		join(fixtureDirectory, 'combined.mkv'),
	]);
	// Playable media that overflows the smallest configurable single-Artifact budget of 1 MiB.
	await execFileAsync(ffmpegPath, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'lavfi',
		'-i',
		'testsrc=size=1280x720:rate=30',
		'-t',
		'20',
		'-an',
		'-c:v',
		'libx264',
		'-preset',
		'ultrafast',
		'-crf',
		'18',
		'-pix_fmt',
		'yuv420p',
		join(fixtureDirectory, 'oversized.mp4'),
	]);
	await execFileAsync(ffmpegPath, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		join(fixtureDirectory, 'combined.mp4'),
		'-c:v',
		'libvpx-vp9',
		'-b:v',
		'100k',
		'-c:a',
		'libopus',
		join(fixtureDirectory, 'combined.webm'),
	]);
	await execFileAsync(ffmpegPath, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-i',
		join(fixtureDirectory, 'video.mp4'),
		'-frames:v',
		'1',
		'-q:v',
		'2',
		join(fixtureDirectory, 'thumbnail.jpg'),
	]);
	await writeFile(
		join(fixtureDirectory, 'captions.vtt'),
		'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nSynthetic caption\n',
	);

	origin = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? '/', 'http://fixture.test').pathname;
		if (pathname === '/metadata') {
			const metadata = {
				'@context': 'https://schema.org',
				'@type': 'VideoObject',
				name: 'Synthetic media',
				description: 'Project-generated media fixture',
				uploadDate: '2026-01-02T00:00:00Z',
				duration: 'PT1S',
				contentUrl: `${originUrl}/combined.mp4`,
				thumbnailUrl: `${originUrl}/thumbnail.jpg`,
				hasPart: [
					{
						'@type': 'Clip',
						name: 'Opening',
						startOffset: 0,
						endOffset: 0.5,
					},
					{
						'@type': 'Clip',
						name: 'Ending',
						startOffset: 0.5,
						endOffset: 1,
					},
				],
			};
			response.writeHead(200, { 'content-type': contentType(pathname) });
			response.end(
				'<html><head><title>Synthetic media</title>' +
					`<script type="application/ld+json">${JSON.stringify(metadata)}</script>` +
					'</head><body></body></html>',
			);
			return;
		}
		if (pathname === '/media') {
			response.writeHead(200, { 'content-type': contentType(pathname) });
			response.end(
				'<html><head><title>Synthetic media</title></head><body>' +
					'<video src="/combined.mp4" poster="/thumbnail.jpg" controls>' +
					'<track kind="subtitles" src="/captions.vtt" srclang="en" label="English">' +
					'</video></body></html>',
			);
			return;
		}
		if (pathname === '/playlist') {
			response.writeHead(200, { 'content-type': contentType(pathname) });
			response.end(
				'<html><head><title>Synthetic playlist</title></head><body>' +
					'<video src="/alpha.mp4" controls></video>' +
					'<video src="/bravo.mp4" controls></video>' +
					'</body></html>',
			);
			return;
		}
		// A real origin may also stream a body whose size it never advertises. That is production
		// behaviour, not a forgiving Adapter: it is the case the option profile's `?` suffix exists
		// for, so it needs an origin that can reproduce it.
		const withheldSize = pathname.startsWith('/chunked/');
		const requestedName = withheldSize
			? pathname.slice('/chunked/'.length)
			: pathname.slice(1);
		const fixtureName = ['alpha.mp4', 'bravo.mp4'].includes(requestedName)
			? 'combined.mp4'
			: requestedName;
		try {
			const body = await readFile(join(fixtureDirectory, fixtureName));
			if (withheldSize) {
				response.writeHead(200, { 'content-type': contentType(requestedName) });
				response.on('finish', () => {
					chunkedBytesServed += body.byteLength;
				});
				response.end(body);
				return;
			}
			// A real origin advertises the size of a static file. Answering chunked instead hides
			// it, and a size yt-dlp cannot see before the download changes which Resource Envelope
			// path a request takes, so the fixture origin must not be more forgiving than reality.
			response.writeHead(200, {
				'content-length': String(body.byteLength),
				'content-type': contentType(pathname),
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
	if (origin) {
		await new Promise<void>((resolveClose) => origin.close(() => resolveClose()));
	}
	if (fixtureDirectory) {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});

describe('real packaged media toolchain', () => {
	// Regression for #52. The Artifact size checks in `validateArtifactSet` are only reachable when
	// the packaged yt-dlp actually writes the Artifact, so a fixture executable that writes an
	// oversized file directly cannot pin this: it never runs the option profile that decides
	// whether an envelope violation is even observable. Only the real toolchain can.
	it('classifies media over the single-Artifact budget as RESOURCE_LIMIT', async () => {
		const context = createExecutionContext(`${originUrl}/oversized.mp4`, '', {
			maximumArtifactSizeMiB: 1,
			maximumTotalArtifactSizeMiB: 2,
		});

		await expect(executeYtDlpNode(context)).rejects.toMatchObject({
			context: { errorCode: 'RESOURCE_LIMIT', itemIndex: 0 },
		});
	}, 60_000);

	// The unknown-size branch of the same pair. `resourceEnvelopeOptionProfile` writes
	// `filesize<=?N`, whose `?` suffix deliberately admits a format whose size yt-dlp cannot learn
	// before downloading, so that case has to reach the post-hoc Artifact checks and classify
	// there. Without an origin that withholds the size, every test takes the early-abort path and
	// this branch has no coverage at all.
	it('classifies media whose size the origin never advertises as RESOURCE_LIMIT', async () => {
		const probe = await fetch(`${originUrl}/chunked/oversized.mp4`);
		const probeBytes = (await probe.arrayBuffer()).byteLength;
		expect(probe.headers.get('content-length')).toBeNull();
		chunkedBytesServed = 0;
		const context = createExecutionContext(`${originUrl}/chunked/oversized.mp4`, '', {
			maximumArtifactSizeMiB: 1,
			maximumTotalArtifactSizeMiB: 2,
		});

		const error = await executeYtDlpNode(context).catch((cause: unknown) => cause);

		expect(error).toMatchObject({ context: { errorCode: 'RESOURCE_LIMIT', itemIndex: 0 } });
		// The classification has to come from the post-hoc Artifact checks, not from the option
		// profile's early abort — otherwise the `?` branch is still untested and this case only
		// repeats the test above. A completed download is the observable difference: an early
		// abort never pulls the whole body.
		expect(chunkedBytesServed).toBeGreaterThanOrEqual(probeBytes);
	}, 60_000);

	// The other half of the pair, and the interaction #52 actually broke: an envelope whose
	// single-Artifact budget the media fits, so the option profile lets the download run, and
	// whose total budget it does not, so the post-hoc Artifact checks are the site that catches
	// it. Running the option profile and the validation together is the point — each on its own
	// stays green while the two disagree about what the violation is called.
	it('classifies media the option profile admits but the total budget rejects as RESOURCE_LIMIT', async () => {
		// First half pins that the option profile really does admit this media at a 2 MiB
		// single-Artifact budget. Without it the rejection below could come from the break filter
		// and the test would stay green while the post-hoc total check was never reached.
		const [admitted] = await executeYtDlpNode(
			createExecutionContext(`${originUrl}/oversized.mp4`, '', {
				maximumArtifactSizeMiB: 2,
				maximumTotalArtifactSizeMiB: 512,
			}),
		);
		expect(admitted).toHaveLength(1);
		expect(admitted[0].json.sizeBytes).toBeGreaterThan(MEBIBYTE);

		const context = createExecutionContext(`${originUrl}/oversized.mp4`, '', {
			maximumArtifactSizeMiB: 2,
			maximumTotalArtifactSizeMiB: 1,
		});

		await expect(executeYtDlpNode(context)).rejects.toMatchObject({
			context: { errorCode: 'RESOURCE_LIMIT', itemIndex: 0 },
		});
	}, 120_000);

	it('merges separate synthetic formats into one Artifact with video and audio streams', async () => {
		const context = createExecutionContext(
			`${originUrl}/manifest.mpd`,
			'-f bestvideo+bestaudio --merge-output-format mp4',
		);

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			status: 'success',
			artifactIndex: 1,
			artifactCount: 1,
			mimeType: 'video/mp4',
		});
		const probe = await probeArtifact<{ streams: Array<{ codec_type: string }> }>(
			items[0],
			'merged-result.mp4',
			'stream=codec_type',
		);
		expect(probe.streams.map(({ codec_type }) => codec_type).sort()).toEqual([
			'audio',
			'video',
		]);
	}, 60_000);

	it('extracts audio into a typed MP3 Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/combined.mp4`,
			'--extract-audio --audio-format mp3 --audio-quality 5',
		);

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			status: 'success',
			fileName: expect.stringMatching(/\.mp3$/u),
			mimeType: 'audio/mpeg',
		});
		const probe = await probeArtifact<{ streams: Array<{ codec_type: string }> }>(
			items[0],
			'extracted-result.mp3',
			'stream=codec_type',
		);
		expect(probe.streams).toEqual([{ codec_type: 'audio' }]);
	}, 60_000);

	it('remuxes synthetic media into a typed MP4 Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/combined.mkv`,
			'--remux-video mp4',
		);

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			status: 'success',
			fileName: expect.stringMatching(/\.mp4$/u),
			mimeType: 'video/mp4',
		});
		const probe = await probeArtifact<{ format: { format_name: string } }>(
			items[0],
			'remuxed-result.mp4',
			'format=format_name',
		);
		expect(probe.format.format_name.split(',')).toContain('mp4');
	}, 60_000);

	it('recodes synthetic media into a typed MP4 Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/combined.webm`,
			'--recode-video mp4',
		);

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			status: 'success',
			fileName: expect.stringMatching(/\.mp4$/u),
			mimeType: 'video/mp4',
		});
		const probe = await probeArtifact<{
			format: { format_name: string };
			streams: Array<{ codec_name: string; codec_type: string }>;
		}>(items[0], 'recoded-result.mp4', 'format=format_name:stream=codec_name,codec_type');
		expect(probe.format.format_name.split(',')).toContain('mp4');
		expect(
			probe.streams.map(({ codec_name, codec_type }) => ({ codec_name, codec_type })),
		).toEqual([
			{ codec_name: 'h264', codec_type: 'video' },
			{ codec_name: 'aac', codec_type: 'audio' },
		]);
	}, 60_000);

	it('writes and converts synthetic subtitles into a typed SRT Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/media`,
			'--write-subs --sub-langs en --sub-format vtt --convert-subs srt',
		);

		const [items] = await executeYtDlpNode(context);

		expect(
			items.map(({ json }) => ({
				extension: String(json.fileName).split('.').slice(-1)[0],
				mimeType: json.mimeType,
			})),
		).toEqual([
			{ extension: 'srt', mimeType: 'application/x-subrip' },
			{ extension: 'mp4', mimeType: 'video/mp4' },
		]);
		expect(artifactBytes(items[0]).toString('utf8')).toContain('Synthetic caption');
	}, 60_000);

	it('embeds synthetic subtitles into the returned media Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/media`,
			'--write-subs --sub-langs en --embed-subs',
		);

		const [items] = await executeYtDlpNode(context);

		const mediaItem = items.find(({ json }) => json.mimeType === 'video/mp4');
		expect(mediaItem).toBeDefined();
		const probe = await probeArtifact<{ streams: Array<{ codec_type: string }> }>(
			mediaItem!,
			'subtitle-embedded-result.mp4',
			'stream=codec_type',
		);
		expect(probe.streams.map(({ codec_type }) => codec_type)).toContain('subtitle');
	}, 60_000);

	it('writes and converts the synthetic thumbnail into a typed PNG Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/media`,
			'--write-thumbnail --convert-thumbnails png',
		);

		const [items] = await executeYtDlpNode(context);

		expect(
			items.map(({ json }) => ({
				extension: String(json.fileName).split('.').slice(-1)[0],
				mimeType: json.mimeType,
			})),
		).toEqual([
			{ extension: 'mp4', mimeType: 'video/mp4' },
			{ extension: 'png', mimeType: 'image/png' },
		]);
		const thumbnailItem = items.find(({ json }) => json.mimeType === 'image/png');
		expect(thumbnailItem).toBeDefined();
		expect(artifactBytes(thumbnailItem!).subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
	}, 60_000);

	it('embeds the synthetic thumbnail into the returned media Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/media`,
			'--write-thumbnail --embed-thumbnail',
		);

		const [items] = await executeYtDlpNode(context);

		const mediaItem = items.find(({ json }) => json.mimeType === 'video/mp4');
		expect(mediaItem).toBeDefined();
		const probe = await probeArtifact<{
			streams: Array<{
				codec_type: string;
				disposition?: { attached_pic?: number };
			}>;
		}>(mediaItem!, 'thumbnail-embedded-result.mp4', 'stream=codec_type:stream_disposition=attached_pic');
		expect(
			probe.streams.some(
				({ codec_type, disposition }) =>
					codec_type === 'video' && disposition?.attached_pic === 1,
			),
		).toBe(true);
	}, 60_000);

	it('embeds synthetic metadata and chapters into the returned media Artifact', async () => {
		const context = createExecutionContext(
			`${originUrl}/metadata`,
			'--embed-metadata --embed-chapters',
		);

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(1);
		const probe = await probeArtifact<{
			chapters: Array<{ tags?: { title?: string } }>;
			format: { tags?: { description?: string; title?: string } };
		}>(
			items[0],
			'metadata-embedded-result.mp4',
			'format_tags=title,description:chapter=start_time,end_time:chapter_tags=title',
		);
		expect(probe.format.tags).toMatchObject({
			title: 'Synthetic media',
			description: 'Project-generated media fixture',
		});
		expect(probe.chapters.map(({ tags }) => tags?.title)).toEqual([
			'Opening',
			'Ending',
		]);
	}, 60_000);

	it('returns a deterministic playlist atomically in basename order', async () => {
		const runPlaylist = async () => {
			const context = createExecutionContext(
				`${originUrl}/playlist`,
				'--yes-playlist --playlist-items 1-2',
			);
			const [items] = await executeYtDlpNode(context);
			return items;
		};

		const firstRun = await runPlaylist();
		const secondRun = await runPlaylist();
		const firstNames = firstRun.map(({ json }) => String(json.fileName));

		expect(firstRun).toHaveLength(2);
		expect(firstNames).toEqual([...firstNames].sort());
		expect(secondRun.map(({ json }) => json.fileName)).toEqual(firstNames);
		expect(
			firstRun.map(({ json, pairedItem }) => ({
				artifactIndex: json.artifactIndex,
				artifactCount: json.artifactCount,
				mimeType: json.mimeType,
				pairedItem,
			})),
		).toEqual([
			{
				artifactIndex: 1,
				artifactCount: 2,
				mimeType: 'video/mp4',
				pairedItem: { item: 0 },
			},
			{
				artifactIndex: 2,
				artifactCount: 2,
				mimeType: 'video/mp4',
				pairedItem: { item: 0 },
			},
		]);
	}, 60_000);
});
