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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { executeYtDlpNode } from '../nodes/YtDlp/YtDlp.node';
import { MEBIBYTE } from '../nodes/YtDlp/resource-envelope';

const execFileAsync = promisify(execFile);
const toolchainDirectory = resolve('packages', 'linux-x64', 'bin');
const ffmpegPath = join(toolchainDirectory, 'ffmpeg');
const ffprobePath = join(toolchainDirectory, 'ffprobe');

/** The entry basenames each synthetic playlist page lists, in the order it presents them. Every
 * entry that is not {@link UNAVAILABLE_ENTRY} is served from a static fixture body. */
const PLAYLISTS = {
	'/playlist': ['alpha.mp4', 'bravo.mp4'],
	'/playlist/partial': ['alpha.mp4', 'restricted.mp4', 'bravo.mp4'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The one entry the origin refuses, standing in for a playlist entry the host will not hand over
 * — geo-restricted, removed, members-only. A playlist fixture whose every entry succeeds cannot
 * show what a single failing entry does to the rest of the request. */
const UNAVAILABLE_ENTRY = 'restricted.mp4';

let fixtureDirectory: string;
let origin: Server;
let originUrl: string;
/** Bytes the size-withholding route has fully flushed, so a test can tell a completed download
 * from an early abort without reaching into error internals. */
let chunkedBytesServed = 0;
/** Requests the origin answered with the entry refusal, so a test can tell a failure caused by the
 * refused entry from any other reason yt-dlp might exit unsuccessfully. */
let refusedEntryRequests = 0;

async function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

/** Every entry basename any playlist page lists, so an entry request is recognised wherever it
 * comes from and adding an entry to a page needs no second edit here. */
const playlistEntryNames = new Set<string>(Object.values(PLAYLISTS).flat());
const playlistPages = new Map<string, readonly string[]>(Object.entries(PLAYLISTS));

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
	continueOnFail = false,
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
		continueOnFail: vi.fn(() => continueOnFail),
		getExecutionCancelSignal: vi.fn(() => undefined),
		getExecutionId: vi.fn(() => 'real-toolchain-execution'),
		getInputData: vi.fn(() => [{ json: {} }]),
		getNode: vi.fn(() => node),
		getNodeParameter: vi.fn((name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'sourceUrl') return sourceUrl;
			if (name === 'arguments') return argumentsValue;
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
		const playlistEntries = playlistPages.get(pathname);
		if (playlistEntries !== undefined) {
			response.writeHead(200, { 'content-type': contentType(pathname) });
			response.end(
				'<html><head><title>Synthetic playlist</title></head><body>' +
					playlistEntries
						.map((entry) => `<video src="/${entry}" controls></video>`)
						.join('') +
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
		// One playlist entry the host will not hand over. A real refusal is an answer, not a
		// missing route, so it carries a status a real host sends and no body to download.
		if (requestedName === UNAVAILABLE_ENTRY) {
			refusedEntryRequests++;
			response.writeHead(403);
			response.end();
			return;
		}
		const fixtureName = playlistEntryNames.has(requestedName)
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

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * The host n8n binary storage settings the derived file size term reads its bound from. The node
 * has no file size number of its own any more, so a test that needs one has to say what the host
 * is configured to enforce — and one that needs none simply leaves the host unset.
 */
function stubHostDatabaseFileSizeLimitMiB(maximumFileSizeMiB: number): void {
	vi.stubEnv('N8N_DEFAULT_BINARY_DATA_MODE', 'database');
	vi.stubEnv('N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE', String(maximumFileSizeMiB));
}

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
	it('classifies media over the derived host file size limit as RESOURCE_LIMIT', async () => {
		stubHostDatabaseFileSizeLimitMiB(1);
		const context = createExecutionContext(`${originUrl}/oversized.mp4`, '');

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
		stubHostDatabaseFileSizeLimitMiB(1);
		const context = createExecutionContext(`${originUrl}/chunked/oversized.mp4`, '');

		const error = await executeYtDlpNode(context).catch((cause: unknown) => cause);

		expect(error).toMatchObject({ context: { errorCode: 'RESOURCE_LIMIT', itemIndex: 0 } });
		// The classification has to come from the post-hoc Artifact checks, not from the option
		// profile's early abort — otherwise the `?` branch is still untested and this case only
		// repeats the test above. A completed download is the observable difference: an early
		// abort never pulls the whole body.
		expect(chunkedBytesServed).toBeGreaterThanOrEqual(probeBytes);
	}, 60_000);

	// The mode an operator running `filesystem` or `s3` binary storage actually gets: n8n enforces
	// no file size limit there, so neither does the node. The same media the two tests above
	// classify as a violation is delivered here, and the option profile carries no break filter to
	// abort it early — only the real toolchain can show that the missing filter still produces a
	// well-formed download rather than a silent skip.
	it('delivers media of any size when the host enforces no file size limit', async () => {
		vi.stubEnv('N8N_DEFAULT_BINARY_DATA_MODE', 'filesystem');
		const context = createExecutionContext(`${originUrl}/oversized.mp4`, '');

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({ status: 'success', mimeType: 'video/mp4' });
		expect(items[0].json.sizeBytes).toBeGreaterThan(MEBIBYTE);
	}, 60_000);

	// The delivered half of the same pair: an Artifact the option profile admits at a budget the
	// host really carries, run through the post-hoc Artifact checks that used to disagree with it.
	// Running the option profile and the validation together is the point — each on its own stays
	// green while the two disagree about what a violation is called.
	it('delivers media the option profile admits at the derived host file size limit', async () => {
		stubHostDatabaseFileSizeLimitMiB(2);

		const [items] = await executeYtDlpNode(
			createExecutionContext(`${originUrl}/oversized.mp4`, ''),
		);

		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({ status: 'success', mimeType: 'video/mp4' });
		expect(items[0].json.sizeBytes).toBeGreaterThan(MEBIBYTE);
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

	// Adapter rule 1, the #52 case carried over to playlist entries. A real playlist host
	// advertises the size of each entry's static body; an origin that answers chunked for entries
	// hides it, so yt-dlp cannot learn an entry's size before downloading it and the Resource
	// Envelope's pre-download path never runs for a playlist at all.
	it('advertises content-length for every playlist entry it serves', async () => {
		const servedEntries = Object.values(PLAYLISTS)
			.flat()
			.filter((entry) => entry !== UNAVAILABLE_ENTRY);
		expect(servedEntries.length).toBeGreaterThan(0);

		for (const entry of new Set(servedEntries)) {
			const response = await fetch(`${originUrl}/${entry}`);

			expect(response.status).toBe(200);
			expect(response.headers.get('content-length')).toBe(
				String((await response.arrayBuffer()).byteLength),
			);
		}
	});

	// A playlist whose entries all succeed cannot show what one refused entry does to the request
	// around it, so the origin has to be able to refuse exactly one. The refusal belongs to the
	// entry, not to the page: the siblings stay servable.
	it('refuses one playlist entry while serving the entries around it', async () => {
		const refused = await fetch(`${originUrl}/${UNAVAILABLE_ENTRY}`);
		expect(refused.status).toBe(403);

		for (const entry of PLAYLISTS['/playlist/partial'].filter(
			(name) => name !== UNAVAILABLE_ENTRY,
		)) {
			const response = await fetch(`${originUrl}/${entry}`);
			expect(response.status).toBe(200);
			// Draining the body releases the keep-alive socket. An undrained one keeps the
			// connection busy and `origin.close` waits on it, so teardown would hang rather than
			// fail once an entry body outgrows the socket buffer.
			await response.arrayBuffer();
		}
	});

	// The behaviour Playlist Genişletmesi exists for, against the real extractor: the refused
	// entry loses its own request and nothing else. Before expansion this same page failed the
	// whole input item and threw away the two Artifacts the origin had already served.
	it('delivers the entries around the refused one when real yt-dlp is refused', async () => {
		const context = createExecutionContext(
			`${originUrl}/playlist/partial`,
			'--yes-playlist',
			true,
		);
		refusedEntryRequests = 0;

		const [items] = await executeYtDlpNode(context);

		expect(items.map(({ json }) => json.status)).toEqual(['success', 'error', 'success']);
		expect(items[1].json).toEqual({
			status: 'error',
			errorCode: 'YTDLP_FAILED',
			errorMessage: 'yt-dlp could not complete the Download Request.',
		});
		// Both survivors carry real bytes: an entry's atomicity is its own, so the refusal beside
		// them cannot invalidate their Artifacts.
		expect(items[0].binary?.data.data.length).toBeGreaterThan(0);
		expect(items[2].binary?.data.data.length).toBeGreaterThan(0);
		// The failure has to be the refusal. `YTDLP_FAILED` alone would stay green if the page
		// stopped being read as a playlist and yt-dlp failed for an unrelated reason, so the test
		// pins that yt-dlp actually asked the origin for the entry it refuses.
		expect(refusedEntryRequests).toBeGreaterThan(0);
		// Every output item still names the input item the playlist came from.
		expect(items.map(({ pairedItem }) => pairedItem)).toEqual([
			{ item: 0 },
			{ item: 0 },
			{ item: 0 },
		]);
	}, 90_000);

	it('fails the execution on a refused entry when Continue On Fail is off', async () => {
		const context = createExecutionContext(`${originUrl}/playlist/partial`, '--yes-playlist');

		await expect(executeYtDlpNode(context)).rejects.toMatchObject({
			context: { errorCode: 'YTDLP_FAILED', itemIndex: 0 },
		});
	}, 90_000);

	// The refused entry sits in the middle, so selecting around it proves the page really does
	// present three entries to the real extractor and that the two survivors are the ones the
	// origin serves. The selection is spent while the entry list is read: the requests it produces
	// each download one entry address, so each names itself after that address rather than after
	// its position on the page.
	it('serves the entries on both sides of the refused playlist entry', async () => {
		const context = createExecutionContext(
			`${originUrl}/playlist/partial`,
			'--yes-playlist --playlist-items 1,3',
		);

		const [items] = await executeYtDlpNode(context);

		expect(items).toHaveLength(2);
		expect(items.map(({ json }) => json.fileName)).toEqual([
			'000001-alpha.mp4',
			'000001-bravo.mp4',
		]);
	}, 90_000);

	it('opens one playlist input item into one atomic Download Request per entry', async () => {
		const runPlaylist = async () => {
			const context = createExecutionContext(
				`${originUrl}/playlist`,
				'--yes-playlist --playlist-items 1-2',
			);
			const [items] = await executeYtDlpNode(context);
			return { context, items };
		};

		const firstRun = await runPlaylist();
		const secondRun = await runPlaylist();
		const firstNames = firstRun.items.map(({ json }) => String(json.fileName));

		expect(firstRun.items).toHaveLength(2);
		expect(secondRun.items.map(({ json }) => json.fileName)).toEqual(firstNames);
		// Each entry is its own request, so each carries its own Artifact set of one rather than a
		// position in a set the whole playlist shares.
		expect(
			firstRun.items.map(({ json, pairedItem }) => ({
				artifactIndex: json.artifactIndex,
				artifactCount: json.artifactCount,
				mimeType: json.mimeType,
				pairedItem,
			})),
		).toEqual([
			{
				artifactIndex: 1,
				artifactCount: 1,
				mimeType: 'video/mp4',
				pairedItem: { item: 0 },
			},
			{
				artifactIndex: 1,
				artifactCount: 1,
				mimeType: 'video/mp4',
				pairedItem: { item: 0 },
			},
		]);
		// How far the one input item opened is what the execution summary has to report, so an
		// operator can verify the size of the job after the fact.
		expect(firstRun.context.logger.info).toHaveBeenCalledWith(
			'yt-dlp execution summary',
			expect.objectContaining({ inputCount: 1, requestCount: 2 }),
		);
	}, 120_000);
});
