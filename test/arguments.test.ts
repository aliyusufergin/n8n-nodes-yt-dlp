import { describe, expect, it } from 'vitest';

import {
	INVALID_ARGUMENTS,
	MAX_ARGUMENTS_BYTES,
	MAX_ARGUMENT_TOKENS,
	MAX_ARGUMENT_TOKEN_BYTES,
	createYtDlpExecutionPlan,
	tokenizeArguments,
} from '../nodes/YtDlp/arguments';

const sourceUrl = 'https://example.com/video';

function plan(argumentsValue: string) {
	return createYtDlpExecutionPlan({ sourceUrl, arguments: argumentsValue });
}

function expectInvalid(argumentsValue: string) {
	expect(() => plan(argumentsValue)).toThrowError(
		expect.objectContaining({ code: INVALID_ARGUMENTS }),
	);
}

describe('V1 argument execution plan', () => {
	it('joins quoted fragments and canonicalizes a short alias', () => {
		const plan = createYtDlpExecutionPlan({
			sourceUrl: 'https://example.com/video',
			arguments: `-f 'bestvideo'"+bestaudio"`,
		});

		expect(plan).toEqual({
			argv: [
				'--playlist-items',
				'1:5',
				'--format',
				'bestvideo+bestaudio',
				'--',
				'https://example.com/video',
			],
		});
	});

	it.each([
		['--format=best', 'best'],
		['--format best', 'best'],
		[`--format 'best video'`, 'best video'],
		['--format "best\\"video"', 'best"video'],
		['--format best\\ video', 'best video'],
	])('parses %s without shell expansion', (argumentsValue, expectedValue) => {
		expect(plan(argumentsValue).argv).toEqual([
			'--playlist-items',
			'1:5',
			'--format',
			expectedValue,
			'--',
			sourceUrl,
		]);
	});

	it.each([
		'--format',
		'--format ""',
		'--format best ""',
		'--format "unterminated',
		'--format trailing\\',
		'--format best\0worst',
		'--format best\r--write-subs',
		'--format $HOME',
		'--format "$(id)"',
		'--format `id`',
		'--format ~/video',
		'--format best{video,audio}',
		'--format best # comment',
		'--format best;id',
		'--format best|id',
		'--format best&&id',
		'--format best>file',
		'--format best\n--write-subs',
		'best',
		'--',
		'-fbest',
		'-fx',
	])('rejects forbidden grammar %j', (argumentsValue) => {
		expectInvalid(argumentsValue);
	});

	it('preserves empty quoted tokens at the lexer boundary', () => {
		expect(tokenizeArguments(`one '' two""three ""`)).toEqual(['one', '', 'twothree', '']);
	});

	it('enforces line, token-count, and token-size limits by UTF-8 bytes', () => {
		const lineAtLimit = ' '.repeat(MAX_ARGUMENTS_BYTES);
		expect(tokenizeArguments(lineAtLimit)).toEqual([]);
		expect(() => tokenizeArguments(`${lineAtLimit} `)).toThrowError(
			expect.objectContaining({ code: INVALID_ARGUMENTS }),
		);

		const tokenAtLimit = 'a'.repeat(MAX_ARGUMENT_TOKEN_BYTES);
		expect(tokenizeArguments(tokenAtLimit)).toEqual([tokenAtLimit]);
		expect(() => tokenizeArguments(`${tokenAtLimit}a`)).toThrowError(
			expect.objectContaining({ code: INVALID_ARGUMENTS }),
		);

		const tokensAtLimit = Array.from({ length: MAX_ARGUMENT_TOKENS }, (_, index) => `t${index}`);
		expect(tokenizeArguments(tokensAtLimit.join(' '))).toEqual(tokensAtLimit);
		expect(() => tokenizeArguments([...tokensAtLimit, 'overflow'].join(' '))).toThrowError(
			expect.objectContaining({ code: INVALID_ARGUMENTS }),
		);
	});

	it.each([
		['-f best', ['--format', 'best']],
		['-S res:1080,filesize~1G,codec:avc:m4a', ['--format-sort', 'res:1080,filesize~1G,codec:avc:m4a']],
		[
			'--format-sort res:1080 --format-sort-force',
			['--format-sort', 'res:1080', '--format-sort-force'],
		],
		['--merge-output-format mp4/mkv', ['--merge-output-format', 'mp4/mkv']],
		['-I 1,3-5,7:11:2', ['--playlist-items', '1,3-5,7:11:2']],
		['--playlist-items :5', ['--playlist-items', ':5']],
		['--yes-playlist', ['--yes-playlist']],
		['--no-playlist', ['--no-playlist']],
		['--write-subs', ['--write-subs']],
		['--write-auto-subs', ['--write-auto-subs']],
		['--write-subs --sub-langs en.*,ja', ['--write-subs', '--sub-langs', 'en.*,ja']],
		['--write-subs --sub-format srt/best', ['--write-subs', '--sub-format', 'srt/best']],
		['--write-subs --convert-subs srt', ['--write-subs', '--convert-subs', 'srt']],
		['--write-subs --embed-subs', ['--write-subs', '--embed-subs']],
		['--write-thumbnail', ['--write-thumbnail']],
		[
			'--write-thumbnail --convert-thumbnails png',
			['--write-thumbnail', '--convert-thumbnails', 'png'],
		],
		['--write-thumbnail --embed-thumbnail', ['--write-thumbnail', '--embed-thumbnail']],
		['-x', ['--extract-audio']],
		['-x --audio-format mp3', ['--extract-audio', '--audio-format', 'mp3']],
		['-x --audio-quality 3', ['--extract-audio', '--audio-quality', '3']],
		['-x --audio-quality 10.0', ['--extract-audio', '--audio-quality', '10.0']],
		['-x --audio-quality 128K', ['--extract-audio', '--audio-quality', '128K']],
		["--remux-video 'aac>m4a/mov>mp4/mkv'", ['--remux-video', 'aac>m4a/mov>mp4/mkv']],
		["--recode-video 'mov>mp4/mkv'", ['--recode-video', 'mov>mp4/mkv']],
		['--embed-metadata', ['--embed-metadata']],
		['--embed-chapters', ['--embed-chapters']],
		['--no-embed-chapters', ['--no-embed-chapters']],
	])('accepts and canonicalizes %s', (argumentsValue, canonicalArguments) => {
		const defaultPlaylist = canonicalArguments[0] === '--playlist-items' ? [] : ['--playlist-items', '1:5'];
		expect(plan(argumentsValue).argv).toEqual([
			...defaultPlaylist,
			...canonicalArguments,
			'--',
			sourceUrl,
		]);
	});

	it.each([
		['--format best --format worst', 'duplicate'],
		['-f best --format worst', 'duplicate alias'],
		['--yes-playlist --no-playlist', 'playlist conflict'],
		['--embed-chapters --no-embed-chapters', 'chapter conflict'],
		['--remux-video mp4 --recode-video mp4', 'video conversion conflict'],
		['--format-sort-force', 'missing format-sort dependency'],
		['--sub-langs en', 'missing subtitle dependency'],
		['--sub-format srt', 'missing subtitle dependency'],
		['--convert-subs srt', 'missing subtitle dependency'],
		['--embed-subs', 'missing subtitle dependency'],
		['--convert-thumbnails png', 'missing thumbnail dependency'],
		['--embed-thumbnail', 'missing thumbnail dependency'],
		['--audio-format mp3', 'missing audio dependency'],
		['--audio-quality 3', 'missing audio dependency'],
	])('rejects %s (%s)', (argumentsValue) => {
		expectInvalid(argumentsValue);
	});

	it.each([
		'--merge-output-format exe',
		'--playlist-items 0',
		'--playlist-items 1-21',
		'--playlist-items 1:',
		'--sub-langs -all',
		'--sub-format ../../etc/passwd',
		'--convert-subs exe',
		'--convert-thumbnails svg',
		'-x --audio-format exe',
		'-x --audio-quality 11',
		'-x --audio-quality 128M',
		'--remux-video exe',
		'--recode-video exe',
		'--format -',
	])('rejects invalid option value %j', (argumentsValue) => {
		expectInvalid(argumentsValue);
	});

	it.each([
		'--output /tmp/file',
		'--paths /tmp',
		'--config-locations /tmp/config',
		'--plugin-dirs /tmp/plugins',
		'--js-runtimes node',
		'--update',
		'--exec id',
		'--username user',
		'--proxy http://proxy',
		'--concurrent-fragments 99',
		'--verbose',
		'--simulate',
		'--load-info-json /tmp/info.json',
		'--unknown-option value',
	])('rejects unsafe or unknown option family %j', (argumentsValue) => {
		expectInvalid(argumentsValue);
	});

	it('preserves generated values across equivalent quoting forms', () => {
		const characters = 'abcXYZ019 ._+/\\"';
		let state = 0x5eed1234;
		const nextInteger = () => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			return state;
		};

		for (let sample = 0; sample < 250; sample++) {
			const length = (nextInteger() % 40) + 1;
			let value = '';
			for (let index = 0; index < length; index++) {
				value += characters[nextInteger() % characters.length];
			}
			const singleQuoted = `'${value}'`;
			const doubleQuoted = `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;

			expect(plan(`--format ${singleQuoted}`)).toEqual(plan(`--format ${doubleQuoted}`));
		}
	});

	it('handles seeded generated argument lines without unexpected failures', () => {
		const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -='\"\\$`(){}[];|&<>#~";
		let state = 0xc0ffee;
		const nextInteger = () => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			return state;
		};

		for (let sample = 0; sample < 500; sample++) {
			const length = nextInteger() % 160;
			let argumentsValue = '';
			for (let index = 0; index < length; index++) {
				argumentsValue += characters[nextInteger() % characters.length];
			}

			try {
				const generatedPlan = plan(argumentsValue);
				expect(generatedPlan.argv.slice(-2)).toEqual(['--', sourceUrl]);
			} catch (error) {
				expect(error).toEqual(expect.objectContaining({ code: INVALID_ARGUMENTS }));
			}
		}
	});

	it('rejects an injection corpus of shell syntax', () => {
		const atoms = ['$HOME', '$(id)', '`id`', ';id', '|id', '&&id', '>file', '#comment', '\nnext'];

		for (const atom of atoms) {
			expectInvalid(`--format best${atom}`);
		}
	});
});
