import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { YtDlpAuthentication } from '../credentials/YtDlpAuthentication.credentials';
import {
	InvalidAuthenticationError,
	createAuthenticationTransport,
	serializeSecretConfig,
	type YtDlpAuthenticationData,
} from '../nodes/YtDlp/authentication';
import packageJson from '../package.json';
import tsconfig from '../tsconfig.json';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { recursive: true })),
	);
});

describe('YT-DLP Authentication credential', () => {
	it('is included in both the compiler input and n8n package manifest', () => {
		expect(tsconfig.include).toContain('credentials/**/*');
		expect(packageJson.n8n.credentials).toEqual([
			'dist/credentials/YtDlpAuthentication.credentials.js',
		]);
	});

	it('offers only the four accepted credential groups', () => {
		const credential = new YtDlpAuthentication();

		expect(credential).toMatchObject({
			name: 'ytDlpAuthentication',
			displayName: 'YT-DLP Authentication',
			restrictToSupportedNodes: true,
			supportedNodes: ['ytDlp'],
		});
		expect(credential.properties.map(({ name }) => name)).toEqual([
			'cookies',
			'username',
			'password',
			'videoPassword',
			'proxyUrl',
		]);
		expect(credential.properties).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'cookies',
					typeOptions: expect.objectContaining({ password: true }),
				}),
				expect.objectContaining({
					name: 'password',
					typeOptions: expect.objectContaining({ password: true }),
				}),
				expect.objectContaining({
					name: 'videoPassword',
					typeOptions: expect.objectContaining({ password: true }),
				}),
				expect.objectContaining({
					name: 'proxyUrl',
					typeOptions: expect.objectContaining({ password: true }),
				}),
			]),
		);
	});
});

describe('Secret Config serializer', () => {
	it('quotes whitespace, quotes, backslashes, delimiters, and option-looking values losslessly', () => {
		const authentication: YtDlpAuthenticationData = {
			username: " user\t'#;=\\$()[]{}--username ",
			password: '--ignore-config',
			videoPassword: 'double"quote',
			proxyUrl: 'http://proxy.example:8080/a?x=1&y=2',
		};

		expect(serializeSecretConfig(authentication, '/request/control/cookies.txt')).toBe(
			"--cookies='/request/control/cookies.txt'\n" +
				"--username=' user\t'\"'\"'#;=\\$()[]{}--username '\n" +
				"--password='--ignore-config'\n" +
				"--video-password='double\"quote'\n" +
				"--proxy='http://proxy.example:8080/a?x=1&y=2'\n",
		);
	});

	it.each(['carriage\rreturn', 'line\nfeed', 'nul\0byte'])(
		'rejects a Secret Config value containing a control delimiter',
		(value) => {
			expect(() => serializeSecretConfig({ username: value })).toThrow(InvalidAuthenticationError);
		},
	);

	it('omits absent values without trimming present whitespace', () => {
		expect(
			serializeSecretConfig({
				username: '',
				password: ' ',
				videoPassword: undefined,
				proxyUrl: '',
			}),
		).toBe("--password=' '\n");
	});
});

describe('Authentication transport', () => {
	it('creates a CRLF Netscape cookie file exclusively with mode 0600 and removes it explicitly', async () => {
		const controlDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-auth-'));
		temporaryDirectories.push(controlDirectory);
		const cookies =
			'# Netscape HTTP Cookie File\r\nexample.test\tFALSE\t/\tFALSE\t0\tsession\tcookie-secret\r\n';
		const authentication: YtDlpAuthenticationData = {
			cookies,
			username: "site'user",
			password: 'site-password',
			videoPassword: 'video-password',
			proxyUrl: 'http://proxy-user:proxy-password@proxy.test:8080',
		};

		const transport = await createAuthenticationTransport(controlDirectory, authentication);
		const cookiePath = join(controlDirectory, 'cookies.txt');

		expect(await readFile(cookiePath, 'utf8')).toBe(cookies);
		expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
		expect(transport.secretConfig).toContain(`--cookies='${cookiePath}'\n`);
		expect(transport.redactValues).toEqual(
			expect.arrayContaining([
				cookies,
				'example.test\tFALSE\t/\tFALSE\t0\tsession\tcookie-secret',
				'session',
				'cookie-secret',
				"site'user",
				`'site'"'"'user'`,
				'site-password',
				'video-password',
				'http://proxy-user:proxy-password@proxy.test:8080',
				'proxy-user',
				'proxy-password',
			]),
		);
		await expect(
			createAuthenticationTransport(controlDirectory, authentication),
		).rejects.toMatchObject({
			code: 'EEXIST',
		});

		await transport.removeCookieFile();
		expect(await readdir(controlDirectory)).toEqual([]);
	});

	it('rejects NUL cookie content before creating a file', async () => {
		const controlDirectory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-auth-'));
		temporaryDirectories.push(controlDirectory);

		await expect(
			createAuthenticationTransport(controlDirectory, { cookies: 'cookie\0secret' }),
		).rejects.toBeInstanceOf(InvalidAuthenticationError);
		expect(await readdir(controlDirectory)).toEqual([]);
	});
});
