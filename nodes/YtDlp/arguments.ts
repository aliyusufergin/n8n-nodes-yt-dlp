import type { DownloadRequest } from './source-url';

export const INVALID_ARGUMENTS = 'INVALID_ARGUMENTS';
export const MAX_ARGUMENTS_BYTES = 16 * 1024;
export const MAX_ARGUMENT_TOKENS = 256;
export const MAX_ARGUMENT_TOKEN_BYTES = 8 * 1024;

export interface YtDlpExecutionPlan {
	argv: string[];
}

/**
 * The rejection reason the workflow author reads. Every message is node-authored: it is built
 * from canonical option names and the allowlist's own accepted value sets, never from the text
 * the author wrote, so nothing the author put in Arguments can travel back out through it.
 */
const UNPARSABLE_ARGUMENTS_MESSAGE =
	'Arguments do not match the supported yt-dlp option profile.';

const UNSUPPORTED_OPTION_MESSAGE =
	'The Arguments value contains an option that is not part of the supported yt-dlp option profile.';

export class InvalidArgumentsError extends Error {
	readonly code = INVALID_ARGUMENTS;

	constructor(message: string = UNPARSABLE_ARGUMENTS_MESSAGE) {
		super(message);
		this.name = 'InvalidArgumentsError';
	}
}

function invalidArguments(message?: string): never {
	throw new InvalidArgumentsError(message);
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
	/**
	 * Present only for options whose accepted values are a finite set. The message enumerates that
	 * set; options with an open value space fall back to the generic invalid-value phrasing.
	 */
	acceptedValueSummary?: string;
	requires?: string[];
	requiresOneOf?: string[];
	conflicts?: string[];
}

type ValueRule = Pick<OptionDefinition, 'acceptedValueSummary' | 'valueValidator'>;

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

function isRetryCount(value: string): boolean {
	if (!/^(?:0|[1-9]\d*)$/u.test(value)) return false;
	const count = Number(value);
	return Number.isSafeInteger(count) && count <= 100;
}

function isSocketTimeout(value: string): boolean {
	if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return false;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0.1 && seconds <= 300;
}

function isLimitRate(value: string): boolean {
	const match = /^(?<amount>(?:0|[1-9]\d*)(?:\.\d+)?)(?<unit>[KMG]?)$/u.exec(value);
	if (match?.groups === undefined) return false;

	const multiplier =
		match.groups.unit === 'G'
			? 1024 ** 3
			: match.groups.unit === 'M'
				? 1024 ** 2
				: match.groups.unit === 'K'
					? 1024
					: 1;
	const bytesPerSecond = Number(match.groups.amount) * multiplier;
	return Number.isFinite(bytesPerSecond) && bytesPerSecond >= 1024 && bytesPerSecond <= 1024 ** 3;
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

function isPreferenceList(value: string, allowedValues: ReadonlySet<string>): boolean {
	const values = value.split('/');
	return values.length > 0 && values.every((item) => allowedValues.has(item));
}

function isConversionRuleList(value: string, allowedValues: ReadonlySet<string>): boolean {
	return value.split('/').every((rule) => {
		const values = rule.split('>');
		return (
			(values.length === 1 && allowedValues.has(values[0])) ||
			(values.length === 2 && values.every((item) => allowedValues.has(item)))
		);
	});
}

/**
 * A finite value set is declared once and drives both the validator and the message, so an
 * accepted value can never be missing from the set the rejection message enumerates.
 */
function oneOf(allowedValues: ReadonlySet<string>): ValueRule {
	return {
		acceptedValueSummary: `one of: ${[...allowedValues].join(', ')}`,
		valueValidator: (value) => allowedValues.has(value),
	};
}

function preferenceListOf(allowedValues: ReadonlySet<string>): ValueRule {
	return {
		acceptedValueSummary: `a "/"-separated preference list of: ${[...allowedValues].join(', ')}`,
		valueValidator: (value) => isPreferenceList(value, allowedValues),
	};
}

function conversionRulesOf(allowedValues: ReadonlySet<string>): ValueRule {
	return {
		acceptedValueSummary: `"/"-separated conversion rules built from: ${[...allowedValues].join(', ')}`,
		valueValidator: (value) => isConversionRuleList(value, allowedValues),
	};
}

function invalidValueMessage(definition: OptionDefinition): string {
	return definition.acceptedValueSummary === undefined
		? `${definition.canonicalName} did not receive a valid value.`
		: `${definition.canonicalName} accepts ${definition.acceptedValueSummary}.`;
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
	{ canonicalName: '--merge-output-format', ...preferenceListOf(mergeContainers) },
	{
		canonicalName: '--playlist-items',
		valueValidator: (value) => playlistItemCardinality(value) !== undefined,
	},
	{ canonicalName: '--yes-playlist', conflicts: ['--no-playlist'] },
	{ canonicalName: '--no-playlist', conflicts: ['--yes-playlist'] },
	{
		canonicalName: '--retries',
		acceptedValueSummary: 'an integer from 0 through 100',
		valueValidator: isRetryCount,
	},
	{
		canonicalName: '--fragment-retries',
		acceptedValueSummary: 'an integer from 0 through 100',
		valueValidator: isRetryCount,
	},
	{
		canonicalName: '--socket-timeout',
		valueValidator: isSocketTimeout,
	},
	{
		canonicalName: '--limit-rate',
		valueValidator: isLimitRate,
	},
	{ canonicalName: '--write-subs' },
	{ canonicalName: '--write-auto-subs' },
	{
		canonicalName: '--sub-langs',
		valueValidator: isSubtitleLanguageExpression,
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{
		canonicalName: '--sub-format',
		...preferenceListOf(subtitleFormats),
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{
		canonicalName: '--convert-subs',
		...oneOf(convertedSubtitleFormats),
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{
		canonicalName: '--embed-subs',
		requiresOneOf: ['--write-subs', '--write-auto-subs'],
	},
	{ canonicalName: '--write-thumbnail' },
	{
		canonicalName: '--convert-thumbnails',
		...conversionRulesOf(thumbnailFormats),
		requires: ['--write-thumbnail'],
	},
	{ canonicalName: '--embed-thumbnail', requires: ['--write-thumbnail'] },
	{ canonicalName: '--extract-audio' },
	{
		canonicalName: '--audio-format',
		...oneOf(audioFormats),
		requires: ['--extract-audio'],
	},
	{
		canonicalName: '--audio-quality',
		valueValidator: isAudioQuality,
		requires: ['--extract-audio'],
	},
	{
		canonicalName: '--remux-video',
		...conversionRulesOf(mediaContainers),
		conflicts: ['--recode-video'],
	},
	{
		canonicalName: '--recode-video',
		...conversionRulesOf(mediaContainers),
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

/**
 * Every option name the allowlist accepts, canonical names and short aliases alike. The release
 * gate reads this to prove the packaged yt-dlp still defines each one. A canonical name upstream
 * renamed would otherwise keep reaching argv and fail only at runtime. An alias never reaches argv
 * — the execution plan emits the canonical name — but it is a spelling this node advertises as
 * yt-dlp's own, so the gate reports its disappearance instead of leaving the two surfaces to drift.
 */
export const ALLOWLISTED_OPTION_NAMES: readonly string[] = [...definitionsByName.keys()];

export function createYtDlpExecutionPlan(request: DownloadRequest): YtDlpExecutionPlan {
	const tokens = tokenizeArguments(request.arguments);
	const argv: string[] = [];
	const selectedOptions = new Set<string>();

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const equalsIndex = token.startsWith('--') ? token.indexOf('=') : -1;
		const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
		const definition = definitionsByName.get(name);
		if (definition === undefined) invalidArguments(UNSUPPORTED_OPTION_MESSAGE);
		if (selectedOptions.has(definition.canonicalName)) {
			invalidArguments(`${definition.canonicalName} may be specified only once.`);
		}

		selectedOptions.add(definition.canonicalName);
		argv.push(definition.canonicalName);

		if (definition.valueValidator === undefined) {
			if (equalsIndex !== -1) {
				invalidArguments(`${definition.canonicalName} does not accept a value.`);
			}
			continue;
		}

		const value = equalsIndex === -1 ? tokens[++index] : token.slice(equalsIndex + 1);
		if (value === undefined) invalidArguments(`${definition.canonicalName} requires a value.`);
		if (!definition.valueValidator(value)) invalidArguments(invalidValueMessage(definition));
		argv.push(value);
	}

	for (const selectedOption of selectedOptions) {
		const definition = definitionsByName.get(selectedOption)!;
		const missing = definition.requires?.filter((required) => !selectedOptions.has(required));
		if (missing !== undefined && missing.length > 0) {
			invalidArguments(`${selectedOption} requires ${missing.join(' and ')}.`);
		}
		if (
			definition.requiresOneOf !== undefined &&
			!definition.requiresOneOf.some((required) => selectedOptions.has(required))
		) {
			invalidArguments(`${selectedOption} requires one of: ${definition.requiresOneOf.join(', ')}.`);
		}
		const conflicting = definition.conflicts?.filter((conflict) => selectedOptions.has(conflict));
		if (conflicting !== undefined && conflicting.length > 0) {
			invalidArguments(`${selectedOption} cannot be combined with ${conflicting.join(' or ')}.`);
		}
	}

	const playlistArguments = selectedOptions.has('--playlist-items')
		? []
		: ['--playlist-items', '1:5'];
	return { argv: [...playlistArguments, ...argv, '--', request.sourceUrl] };
}
