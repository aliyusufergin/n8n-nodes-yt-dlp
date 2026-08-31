import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
	createYtDlpExecutionPlan,
	readPlaylistSelection,
} from '../nodes/YtDlp/arguments';
import { createEntryPlans } from '../nodes/YtDlp/playlist-expansion';
import {
	INVALID_SOURCE_URL,
	MAX_SOURCE_URL_BYTES,
	createDownloadRequest,
} from '../nodes/YtDlp/source-url';

describe('Source URL policy', () => {
	it.each([
		'',
		'example.com/video',
		'http:///tmp/video.mp4',
		'https:////example.com/video',
		'ftp://example.com/video',
		'file:///tmp/video.mp4',
		'data:text/plain,video',
		'pipe:0',
		'ytsearch:example',
		'-',
		' https://example.com/video',
		'https://@example.com/video',
		'https://user:password@example.com/video',
		'https://example.com/video\u0000',
		'https://example.com/vi\tdeo',
		'https://example.com/one\nhttps://example.com/two',
		'https://example.com/video\u007f',
		'https://example.com/video\u0085',
	])('rejects %j with a stable error code', (sourceUrl) => {
		expect(() => createDownloadRequest(sourceUrl, '')).toThrowError(
			expect.objectContaining({ code: INVALID_SOURCE_URL }),
		);
	});

	it('rejects Source URLs over 16 KiB by UTF-8 byte length', () => {
		const sourceUrl = `https://example.com/${'ü'.repeat(MAX_SOURCE_URL_BYTES / 2)}`;

		expect(Buffer.byteLength(sourceUrl, 'utf8')).toBeGreaterThan(MAX_SOURCE_URL_BYTES);
		expect(() => createDownloadRequest(sourceUrl, '')).toThrowError(
			expect.objectContaining({ code: INVALID_SOURCE_URL }),
		);
	});

	it('accepts absolute HTTP(S) URLs at the 16 KiB boundary', () => {
		const prefix = 'https://example.com/';
		const sourceUrl = `${prefix}${'a'.repeat(MAX_SOURCE_URL_BYTES - Buffer.byteLength(prefix))}`;

		expect(Buffer.byteLength(sourceUrl, 'utf8')).toBe(MAX_SOURCE_URL_BYTES);
		expect(createDownloadRequest(sourceUrl, '--format best')).toEqual({
			sourceUrl,
			arguments: '--format best',
		});
	});

	it.each([
		'http://example.com/video',
		'https://example.com:8443/path?quality=best#chapter',
	])('accepts %s', (sourceUrl) => {
		expect(createDownloadRequest(sourceUrl, '')).toEqual({ sourceUrl, arguments: '' });
	});
});

describe('Playlist Genişletmesi entry addresses', () => {
	const selection = readPlaylistSelection(
		createYtDlpExecutionPlan({
			sourceUrl: 'https://example.com/playlist',
			arguments: '--format best --playlist-items 1-3',
		}),
	);

	it('applies the Source URL contract to every listed entry address', () => {
		const plans = createEntryPlans(selection, [
			'https://example.com/entry-one',
			'http://example.com:8443/entry-two?quality=best',
		]);

		expect(plans.map(({ argv }) => argv)).toEqual([
			['--format', 'best', '--no-playlist', '--', 'https://example.com/entry-one'],
			[
				'--format',
				'best',
				'--no-playlist',
				'--',
				'http://example.com:8443/entry-two?quality=best',
			],
		]);
	});

	// The listing is remote input, so an address the node would not accept from the author is not
	// accepted from an extractor either — and refusing it costs the entries around it nothing.
	it.each([
		'',
		'example.com/entry',
		'ftp://example.com/entry',
		'file:///tmp/entry.mp4',
		'ytsearch:entry',
		'-',
		' https://example.com/entry',
		'https://user:password@example.com/entry',
		'https://example.com/entry ',
		'https://example.com/en\ttry',
		'https://example.com/entry\u0000',
	])('produces no Download Request for the listed address %j', (address) => {
		expect(createEntryPlans(selection, [address])).toEqual([]);
	});

	it('produces no Download Request for a listed address over 16 KiB', () => {
		const address = `https://example.com/${'a'.repeat(MAX_SOURCE_URL_BYTES)}`;

		expect(createEntryPlans(selection, [address])).toEqual([]);
	});

	it('keeps the entries around a rejected one', () => {
		const plans = createEntryPlans(selection, [
			'https://example.com/entry-one',
			'file:///tmp/entry.mp4',
			'https://example.com/entry-three',
		]);

		expect(plans.map(({ argv }) => argv[argv.length - 1])).toEqual([
			'https://example.com/entry-one',
			'https://example.com/entry-three',
		]);
	});

	// The selection that chose the entries is spent once the list is read: re-applying it to a
	// single video would select an entry range inside something that has no entries.
	it('keeps the playlist selection off the requests it produced', () => {
		const [plan] = createEntryPlans(selection, ['https://example.com/entry-one']);

		expect(plan.argv).not.toContain('--playlist-items');
		expect(plan.argv).not.toContain('1-3');
	});
});
