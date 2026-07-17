export const INVALID_SOURCE_URL = 'INVALID_SOURCE_URL';
export const MAX_SOURCE_URL_BYTES = 16 * 1024;

function containsControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
	});
}

function hasHttpAuthorityWithUserInfo(value: string): boolean {
	return /^https?:\/\/[^/?#]*@/iu.test(value);
}

function hasExplicitHttpAuthority(value: string): boolean {
	return /^https?:\/\/[^/?#]+(?:[/?#]|$)/iu.test(value);
}

export interface DownloadRequest {
	sourceUrl: string;
	arguments: string;
}

export class InvalidSourceUrlError extends Error {
	readonly code = INVALID_SOURCE_URL;

	constructor() {
		super('Source URL must be an absolute HTTP(S) URL without credentials or control characters and no longer than 16 KiB.');
		this.name = 'InvalidSourceUrlError';
	}
}

export function createDownloadRequest(sourceUrl: unknown, argumentsValue: string): DownloadRequest {
	if (
		typeof sourceUrl !== 'string' ||
		Buffer.byteLength(sourceUrl, 'utf8') > MAX_SOURCE_URL_BYTES ||
		containsControlCharacter(sourceUrl) ||
		sourceUrl.trim() !== sourceUrl ||
		!hasExplicitHttpAuthority(sourceUrl) ||
		hasHttpAuthorityWithUserInfo(sourceUrl)
	) {
		throw new InvalidSourceUrlError();
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(sourceUrl);
	} catch {
		throw new InvalidSourceUrlError();
	}

	if (
		(parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
		parsedUrl.username !== '' ||
		parsedUrl.password !== ''
	) {
		throw new InvalidSourceUrlError();
	}

	return { sourceUrl, arguments: argumentsValue };
}
