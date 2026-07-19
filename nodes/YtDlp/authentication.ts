import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

export interface YtDlpAuthenticationData {
	cookies?: string;
	username?: string;
	password?: string;
	videoPassword?: string;
	proxyUrl?: string;
}

export interface AuthenticationTransport {
	secretConfig: string;
	redactValues: readonly string[];
	removeCookieFile: () => Promise<void>;
}

export class InvalidAuthenticationError extends Error {
	constructor() {
		super('The YT-DLP Authentication credential is invalid.');
		this.name = 'InvalidAuthenticationError';
	}
}

export function parseAuthenticationCredential(
	credential: ICredentialDataDecryptedObject,
): YtDlpAuthenticationData {
	const authentication: YtDlpAuthenticationData = {};
	for (const field of ['cookies', 'username', 'password', 'videoPassword', 'proxyUrl'] as const) {
		const value = credential[field];
		if (value === undefined || value === '') continue;
		if (typeof value !== 'string') throw new InvalidAuthenticationError();
		authentication[field] = value;
	}
	return authentication;
}

function quoteSecretConfigValue(value: string): string {
	if (/\r|\n|\0/.test(value)) throw new InvalidAuthenticationError();
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function addRedactionValue(values: Set<string>, value: string | undefined): void {
	if (value !== undefined && value !== '') values.add(value);
}

function parseUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

function decodeUrlComponent(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function authenticationRedactionValues(
	authentication: YtDlpAuthenticationData,
): readonly string[] {
	const values = new Set<string>();
	const addSecretConfigValue = (value: string | undefined): void => {
		addRedactionValue(values, value);
		if (value !== undefined && value !== '') {
			addRedactionValue(values, quoteSecretConfigValue(value));
		}
	};

	const cookies = authentication.cookies;
	addRedactionValue(values, cookies);
	for (const line of cookies?.split(/\r?\n/) ?? []) {
		addRedactionValue(values, line);
		const fields = line.split('\t');
		if (fields.length >= 7) {
			addRedactionValue(values, fields[5]);
			addRedactionValue(values, fields[6]);
		}
	}

	for (const value of [
		authentication.username,
		authentication.password,
		authentication.videoPassword,
		authentication.proxyUrl,
	]) {
		addSecretConfigValue(value);
	}

	if (authentication.proxyUrl !== undefined && authentication.proxyUrl !== '') {
		const proxy = parseUrl(authentication.proxyUrl);
		if (proxy !== undefined) {
			for (const value of [proxy.href, proxy.username, proxy.password]) {
				addRedactionValue(values, value);
				addRedactionValue(values, decodeUrlComponent(value));
			}
		}
	}

	return [...values];
}

export function serializeSecretConfig(
	authentication: YtDlpAuthenticationData,
	cookiePath?: string,
): string {
	const entries: Array<[string, string | undefined]> = [
		['--cookies', cookiePath],
		['--username', authentication.username],
		['--password', authentication.password],
		['--video-password', authentication.videoPassword],
		['--proxy', authentication.proxyUrl],
	];

	return entries
		.filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
		.map(([option, value]) => `${option}=${quoteSecretConfigValue(value)}\n`)
		.join('');
}

export async function createAuthenticationTransport(
	controlDirectory: string,
	authentication: YtDlpAuthenticationData,
): Promise<AuthenticationTransport> {
	const cookies = authentication.cookies;
	if (cookies?.includes('\0') === true) throw new InvalidAuthenticationError();

	const cookieContent = cookies ?? '';
	const cookiePath = cookieContent === '' ? undefined : join(controlDirectory, 'cookies.txt');
	const secretConfig = serializeSecretConfig(authentication, cookiePath);
	if (cookiePath !== undefined) {
		let cookieCreated = false;
		try {
			const cookieFile = await open(cookiePath, 'wx', 0o600);
			cookieCreated = true;
			try {
				await cookieFile.chmod(0o600);
				await cookieFile.writeFile(cookieContent, 'utf8');
			} finally {
				await cookieFile.close();
			}
		} catch (error) {
			if (cookieCreated) await rm(cookiePath, { force: true });
			throw error;
		}
	}

	return {
		secretConfig,
		redactValues: authenticationRedactionValues(authentication),
		removeCookieFile: async () => {
			if (cookiePath !== undefined) await rm(cookiePath, { force: true });
		},
	};
}
