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

describe('V2 argument execution plan', () => {
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
		['-I 1-20', ['--playlist-items', '1-20']],
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

describe('network politeness options', () => {
	it.each([
		['--retries 0', ['--retries', '0']],
		['--retries 100', ['--retries', '100']],
		['--fragment-retries 0', ['--fragment-retries', '0']],
		['--fragment-retries 100', ['--fragment-retries', '100']],
	])('accepts bounded integer retry count %s', (argumentsValue, canonicalArguments) => {
		expect(plan(argumentsValue).argv).toEqual([
			'--playlist-items',
			'1:5',
			...canonicalArguments,
			'--',
			sourceUrl,
		]);
	});

	it.each(['0.1', '4.2', '300'])(
		'accepts bounded socket timeout %s seconds',
		(socketTimeout) => {
			expect(plan(`--socket-timeout ${socketTimeout}`).argv).toEqual([
				'--playlist-items',
				'1:5',
				'--socket-timeout',
				socketTimeout,
				'--',
				sourceUrl,
			]);
		},
	);

	it.each(['1024', '1K', '4.2M', '1G'])('accepts bounded download rate %s', (rate) => {
		expect(plan(`--limit-rate ${rate}`).argv).toEqual([
			'--playlist-items',
			'1:5',
			'--limit-rate',
			rate,
			'--',
			sourceUrl,
		]);
	});

	it.each([
		['--retries infinite', '--retries accepts an integer from 0 through 100.'],
		['--retries 101', '--retries accepts an integer from 0 through 100.'],
		[
			'--fragment-retries infinite',
			'--fragment-retries accepts an integer from 0 through 100.',
		],
		[
			'--fragment-retries 1.5',
			'--fragment-retries accepts an integer from 0 through 100.',
		],
		[
			'--socket-timeout 0',
			'--socket-timeout did not receive a valid value.',
		],
		[
			'--socket-timeout 300.1',
			'--socket-timeout did not receive a valid value.',
		],
		[
			'--socket-timeout 1e2',
			'--socket-timeout did not receive a valid value.',
		],
		['--limit-rate 1023', '--limit-rate did not receive a valid value.'],
		['--limit-rate 1.1G', '--limit-rate did not receive a valid value.'],
		['--limit-rate 1GiB', '--limit-rate did not receive a valid value.'],
	])('rejects invalid network politeness value %s', (argumentsValue, message) => {
		expect(() => plan(argumentsValue)).toThrowError(
			expect.objectContaining({ code: INVALID_ARGUMENTS, message }),
		);
	});
});

describe('option-specific rejection messages', () => {
	const UNSUPPORTED_OPTION_MESSAGE =
		'The Arguments value contains an option that is not part of the supported yt-dlp option profile.';

	function expectRejectionMessage(argumentsValue: string, message: string) {
		expect(() => plan(argumentsValue)).toThrowError(
			expect.objectContaining({ code: INVALID_ARGUMENTS, message }),
		);
	}

	it.each([
		'--unknown-option value',
		'--exec id',
		'--output /tmp/file',
		'best',
		'-fbest',
		'--',
	])('reports %j as an unsupported option', (argumentsValue) => {
		expectRejectionMessage(argumentsValue, UNSUPPORTED_OPTION_MESSAGE);
	});

	it.each([
		['--format best --format worst', '--format may be specified only once.'],
		['-f best --format worst', '--format may be specified only once.'],
		['-x --extract-audio', '--extract-audio may be specified only once.'],
	])('reports %j as a duplicate option', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it.each([
		['--write-subs=yes', '--write-subs does not accept a value.'],
		['--extract-audio=mp3', '--extract-audio does not accept a value.'],
	])('reports %j as a valueless option given a value', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it.each([
		['--format', '--format requires a value.'],
		['--write-thumbnail --convert-thumbnails', '--convert-thumbnails requires a value.'],
	])('reports %j as a missing value', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it.each([
		['--format -', '--format did not receive a valid value.'],
		['--format-sort ***', '--format-sort did not receive a valid value.'],
		['--playlist-items 0', '--playlist-items did not receive a valid value.'],
		['--write-subs --sub-langs -all', '--sub-langs did not receive a valid value.'],
		['-x --audio-quality 11', '--audio-quality did not receive a valid value.'],
	])('reports %j as an invalid free-form value', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it.each([
		[
			'--merge-output-format exe',
			'--merge-output-format accepts a "/"-separated preference list of: avi, flv, mkv, mov, mp4, webm.',
		],
		[
			'--write-subs --sub-format exe',
			'--sub-format accepts a "/"-separated preference list of: ass, best, lrc, srt, vtt.',
		],
		['--write-subs --convert-subs exe', '--convert-subs accepts one of: ass, lrc, srt, vtt.'],
		[
			'--write-thumbnail --convert-thumbnails svg',
			'--convert-thumbnails accepts "/"-separated conversion rules built from: jpg, png, webp.',
		],
		[
			'-x --audio-format ogg',
			'--audio-format accepts one of: aac, alac, best, flac, m4a, mp3, opus, vorbis, wav.',
		],
		[
			'--remux-video exe',
			'--remux-video accepts "/"-separated conversion rules built from: aac, aiff, alac, avi, flac, flv, gif, m4a, mka, mkv, mov, mp3, mp4, ogg, opus, vorbis, wav, webm.',
		],
		[
			'--recode-video exe',
			'--recode-video accepts "/"-separated conversion rules built from: aac, aiff, alac, avi, flac, flv, gif, m4a, mka, mkv, mov, mp3, mp4, ogg, opus, vorbis, wav, webm.',
		],
	])('enumerates the accepted value set for %j', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it.each([
		['--format-sort-force', '--format-sort-force requires --format-sort.'],
		['--convert-thumbnails png', '--convert-thumbnails requires --write-thumbnail.'],
		['--embed-thumbnail', '--embed-thumbnail requires --write-thumbnail.'],
		['--audio-format mp3', '--audio-format requires --extract-audio.'],
		['--audio-quality 3', '--audio-quality requires --extract-audio.'],
		['--sub-langs en', '--sub-langs requires one of: --write-subs, --write-auto-subs.'],
		['--sub-format srt', '--sub-format requires one of: --write-subs, --write-auto-subs.'],
		['--convert-subs srt', '--convert-subs requires one of: --write-subs, --write-auto-subs.'],
		['--embed-subs', '--embed-subs requires one of: --write-subs, --write-auto-subs.'],
	])('reports %j as a missing dependency', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it.each([
		['--yes-playlist --no-playlist', '--yes-playlist cannot be combined with --no-playlist.'],
		['--no-playlist --yes-playlist', '--no-playlist cannot be combined with --yes-playlist.'],
		[
			'--embed-chapters --no-embed-chapters',
			'--embed-chapters cannot be combined with --no-embed-chapters.',
		],
		[
			'--remux-video mp4 --recode-video mp4',
			'--remux-video cannot be combined with --recode-video.',
		],
	])('reports %j as a conflict', (argumentsValue, message) => {
		expectRejectionMessage(argumentsValue, message);
	});

	it('keeps the frozen error code on every rejection category', () => {
		for (const argumentsValue of [
			'--unknown-option value',
			'--format best --format worst',
			'-x --audio-format ogg',
			'--audio-format mp3',
			'--yes-playlist --no-playlist',
			'--format "unterminated',
		]) {
			expect(() => plan(argumentsValue)).toThrowError(
				expect.objectContaining({ code: INVALID_ARGUMENTS }),
			);
		}
	});

	it('never repeats the value the user wrote back in the message', () => {
		const marker = 'canary0value';
		const templates = [
			`--format-sort ${marker}!`,
			`--merge-output-format ${marker}`,
			`--playlist-items ${marker}`,
			`--write-subs --sub-format ${marker}`,
			`--write-subs --convert-subs ${marker}`,
			`--write-thumbnail --convert-thumbnails ${marker}`,
			`-x --audio-format ${marker}`,
			`-x --audio-quality ${marker}`,
			`--remux-video ${marker}`,
			`--recode-video ${marker}`,
			`--${marker} value`,
			`--format=${marker} --format=${marker}`,
			`--write-subs=${marker}`,
			`--retries ${marker}`,
			`--fragment-retries ${marker}`,
			`--socket-timeout ${marker}`,
			`--limit-rate ${marker}`,
		];

		for (const argumentsValue of templates) {
			try {
				plan(argumentsValue);
				expect.unreachable(`expected ${argumentsValue} to be rejected`);
			} catch (error) {
				const message = (error as Error).message;
				expect(message).not.toContain(marker);
				expect(message.split('\n')).toHaveLength(1);
			}
		}
	});
});
