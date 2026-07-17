import type { DownloadRequest } from './source-url';

export const INVALID_ARGUMENTS = 'INVALID_ARGUMENTS';
export const MAX_ARGUMENTS_BYTES = 16 * 1024;
export const MAX_ARGUMENT_TOKENS = 256;
export const MAX_ARGUMENT_TOKEN_BYTES = 8 * 1024;

export interface YtDlpExecutionPlan {
	argv: string[];
}

export class InvalidArgumentsError extends Error {
	readonly code = INVALID_ARGUMENTS;

	constructor() {
		super('Arguments do not match the supported yt-dlp option profile.');
		this.name = 'InvalidArgumentsError';
	}
}

function invalidArguments(): never {
	throw new InvalidArgumentsError();
}

export function tokenizeArguments(input: string): string[] {
	if (Buffer.byteLength(input, 'utf8') > MAX_ARGUMENTS_BYTES || /[\0\r\n]/u.test(input)) {
		invalidArguments();
	}

	const tokens: string[] = [];
	let token = '';
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;

	const finishToken = () => {
		if (!tokenStarted) return;
		if (Buffer.byteLength(token, 'utf8') > MAX_ARGUMENT_TOKEN_BYTES) invalidArguments();
		tokens.push(token);
		if (tokens.length > MAX_ARGUMENT_TOKENS) invalidArguments();
		token = '';
		tokenStarted = false;
	};

	for (let index = 0; index < input.length; index++) {
		const character = input[index];

		if (quote !== undefined) {
			if (character === quote) {
				quote = undefined;
				tokenStarted = true;
				continue;
			}
			if (character === '\\' && quote === '"') {
				const escaped = input[++index];
				if (escaped !== '"' && escaped !== '\\') invalidArguments();
				token += escaped;
				continue;
			}
			if (character === '$' || character === '`') invalidArguments();
			token += character;
			tokenStarted = true;
			continue;
		}

		if (character === ' ' || character === '\t') {
			finishToken();
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
			continue;
		}
		if (character === '\\') {
			const escaped = input[++index];
			if (![' ', '\t', "'", '"', '\\'].includes(escaped)) invalidArguments();
			token += escaped;
			tokenStarted = true;
			continue;
		}
		if (
			character === '$' ||
			character === '`' ||
			character === '#' ||
			character === '{' ||
			character === '}' ||
			(character === '~' && !tokenStarted) ||
			/[;&|<>]/u.test(character)
		) {
			invalidArguments();
		}

		token += character;
		tokenStarted = true;
	}

	if (quote !== undefined) invalidArguments();
	finishToken();
	return tokens;
}

interface OptionDefinition {
	canonicalName: string;
	valueValidator?: (value: string) => boolean;
	requires?: string[];
	requiresOneOf?: string[];
	conflicts?: string[];
}

const mergeContainers = new Set(['avi', 'flv', 'mkv', 'mov', 'mp4', 'webm']);
const subtitleFormats = new Set(['ass', 'best', 'lrc', 'srt', 'vtt']);
const convertedSubtitleFormats = new Set(['ass', 'lrc', 'srt', 'vtt']);
const thumbnailFormats = new Set(['jpg', 'png', 'webp']);
const audioFormats = new Set([
	'aac',
	'alac',
	'best',
	'flac',
	'm4a',
	'mp3',
	'opus',
	'vorbis',
	'wav',
]);
const mediaContainers = new Set([
	'aac',
	'aiff',
	'alac',
	'avi',
	'flac',
	'flv',
	'gif',
	'm4a',
	'mka',
	'mkv',
	'mov',
	'mp3',
	'mp4',
	'ogg',
	'opus',
	'vorbis',
	'wav',
	'webm',
]);

function isFormatSelector(value: string): boolean {
	return value !== '' && !value.startsWith('-') && !/[\0\r\n]/u.test(value);
}

function isFormatSort(value: string): boolean {
	return (
		value.length <= 1024 &&
		/^(?:[+-]?[a-z][a-z0-9_]*(?:(?::|~)[a-z0-9.+_-]+(?::[a-z0-9.+_-]+)?)?)(?:,(?:[+-]?[a-z][a-z0-9_]*(?:(?::|~)[a-z0-9.+_-]+(?::[a-z0-9.+_-]+)?)?))*$/iu.test(
			value,
		)
	);
}

function toSafePositiveInteger(value: string): number | undefined {
	if (!/^[1-9]\d*$/u.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}

function playlistItemCardinality(value: string): number | undefined {
	if (value.length > 512) return undefined;
	let cardinality = 0;

	for (const part of value.split(',')) {
		let count: number;
		if (toSafePositiveInteger(part) !== undefined) {
			count = 1;
		} else {
			const range = /^(?<start>[1-9]\d*)-(?<end>[1-9]\d*)$/u.exec(part)?.groups;
			if (range !== undefined) {
				const start = toSafePositiveInteger(range.start);
				const end = toSafePositiveInteger(range.end);
				if (start === undefined || end === undefined) return undefined;
				if (end < start) return undefined;
				count = end - start + 1;
			} else {
				const slice = /^(?<start>[1-9]\d*)?:(?<end>[1-9]\d*)(?::(?<step>[1-9]\d*))?$/u.exec(
					part,
				)?.groups;
				if (slice === undefined) return undefined;
				const start = toSafePositiveInteger(slice.start ?? '1');
				const end = toSafePositiveInteger(slice.end);
				const step = toSafePositiveInteger(slice.step ?? '1');
				if (start === undefined || end === undefined || step === undefined || end < start) {
					return undefined;
				}
				count = Math.floor((end - start) / step) + 1;
			}
		}

		cardinality += count;
		if (cardinality > 20) return undefined;
	}

	return cardinality;
}

function isSubtitleLanguageExpression(value: string): boolean {
	return (
		value.length <= 512 &&
		value !== '' &&
		!value.startsWith('-') &&
		!/[\s/\\;|&<>`$#]/u.test(value)
	);
}

function isPreferenceList(value: string, allowedValues: Set<string>): boolean {
	const values = value.split('/');
	return values.length > 0 && values.every((item) => allowedValues.has(item));
}

function isConversionRuleList(value: string, allowedValues: Set<string>): boolean {
	return value.split('/').every((rule) => {
		const values = rule.split('>');
		return (
			(values.length === 1 && allowedValues.has(values[0])) ||
			(values.length === 2 && values.every((item) => allowedValues.has(item)))
		);
	});
}

function isAudioQuality(value: string): boolean {
	const bitrate = /^(?<amount>(?:0|[1-9]\d*)(?:\.\d+)?)[kK]$/u.exec(value)?.groups?.amount;
	if (bitrate !== undefined) {
		const amount = Number(bitrate);
		return Number.isFinite(amount) && amount > 0;
	}

	if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return false;
	const quality = Number(value);
	return Number.isFinite(quality) && quality >= 0 && quality <= 10;
}

const optionDefinitions: OptionDefinition[] = [
	{ canonicalName: '--format', valueValidator: isFormatSelector },
	{ canonicalName: '--format-sort', valueValidator: isFormatSort },
	{ canonicalName: '--format-sort-force', requires: ['--format-sort'] },
	{
		canonicalName: '--merge-output-format',
		valueValidator: (value) => isPreferenceList(value, mergeContainers),
	},
	{
		canonicalName: '--playlist-items',
		valueValidator: (value) => playlistItemCardinality(value) !== undefined,
	},
	{ canonicalName: '--yes-playlist', conflicts: ['--no-playlist'] },
	{ canonicalName: '--no-playlist', conflicts: ['--yes-playlist'] },
	{ canonicalName: '--write-subs' },
	{ canonicalName: '--write-auto-subs' },
	{
		canonicalName: '--sub-langs',
		valueValidator: isSubtitleLanguageExpression,
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{
		canonicalName: '--sub-format',
		valueValidator: (value) => isPreferenceList(value, subtitleFormats),
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{
		canonicalName: '--convert-subs',
		valueValidator: (value) => convertedSubtitleFormats.has(value),
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{
		canonicalName: '--embed-subs',
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{ canonicalName: '--write-thumbnail' },
	{
		canonicalName: '--convert-thumbnails',
		valueValidator: (value) => isConversionRuleList(value, thumbnailFormats),
		requires: ['--write-thumbnail'],
	},
	{ canonicalName: '--embed-thumbnail', requires: ['--write-thumbnail'] },
	{ canonicalName: '--extract-audio' },
	{
		canonicalName: '--audio-format',
		valueValidator: (value) => audioFormats.has(value),
		requires: ['--extract-audio'],
	},
	{
		canonicalName: '--audio-quality',
		valueValidator: isAudioQuality,
		requires: ['--extract-audio'],
	},
	{
		canonicalName: '--remux-video',
		valueValidator: (value) => isConversionRuleList(value, mediaContainers),
		conflicts: ['--recode-video'],
	},
	{
		canonicalName: '--recode-video',
		valueValidator: (value) => isConversionRuleList(value, mediaContainers),
		conflicts: ['--remux-video'],
	},
	{ canonicalName: '--embed-metadata' },
	{ canonicalName: '--embed-chapters', conflicts: ['--no-embed-chapters'] },
	{ canonicalName: '--no-embed-chapters', conflicts: ['--embed-chapters'] },
];

const definitionsByName = new Map<string, OptionDefinition>();
for (const definition of optionDefinitions) {
	definitionsByName.set(definition.canonicalName, definition);
}
definitionsByName.set('-f', definitionsByName.get('--format')!);
definitionsByName.set('-S', definitionsByName.get('--format-sort')!);
definitionsByName.set('-I', definitionsByName.get('--playlist-items')!);
definitionsByName.set('-x', definitionsByName.get('--extract-audio')!);

export function createYtDlpExecutionPlan(request: DownloadRequest): YtDlpExecutionPlan {
	const tokens = tokenizeArguments(request.arguments);
	const argv: string[] = [];
	const selectedOptions = new Set<string>();

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const equalsIndex = token.startsWith('--') ? token.indexOf('=') : -1;
		const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
		const definition = definitionsByName.get(name);
		if (definition === undefined || selectedOptions.has(definition.canonicalName)) invalidArguments();

		selectedOptions.add(definition.canonicalName);
		argv.push(definition.canonicalName);

		if (definition.valueValidator === undefined) {
			if (equalsIndex !== -1) invalidArguments();
			continue;
		}

		const value = equalsIndex === -1 ? tokens[++index] : token.slice(equalsIndex + 1);
		if (value === undefined || !definition.valueValidator(value)) invalidArguments();
		argv.push(value);
	}

	for (const selectedOption of selectedOptions) {
		const definition = definitionsByName.get(selectedOption)!;
		if (definition.requires?.some((required) => !selectedOptions.has(required)) === true) {
			invalidArguments();
		}
		if (
			definition.requiresOneOf !== undefined &&
			!definition.requiresOneOf.some((required) => selectedOptions.has(required))
		) {
			invalidArguments();
		}
		if (definition.conflicts?.some((conflict) => selectedOptions.has(conflict)) === true) {
			invalidArguments();
		}
	}

	const playlistArguments = selectedOptions.has('--playlist-items')
		? []
		: ['--playlist-items', '1:5'];
	return { argv: [...playlistArguments, ...argv, '--', request.sourceUrl] };
}
