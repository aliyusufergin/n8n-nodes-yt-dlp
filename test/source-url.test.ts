import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

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
