import { readFileSync } from 'node:fs';

export const RESOURCE_LIMIT = 'RESOURCE_LIMIT';
export const REQUEST_TIMEOUT = 'REQUEST_TIMEOUT';
export const MEBIBYTE = 1024 * 1024;
export const MAXIMUM_EXECUTION_INPUTS = 20;
export const MAXIMUM_EXECUTION_DURATION_MS = 2 * 60 * 60 * 1000;

export const DEFAULT_REQUEST_TIMEOUT_MINUTES = 30;
export const MAXIMUM_REQUEST_TIMEOUT_MINUTES = 60;
export const DEFAULT_MAXIMUM_ARTIFACT_COUNT = 20;
export const MAXIMUM_ARTIFACT_COUNT = 50;
export const DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB = 256;
export const MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB = 512;
/**
 * Slack for request-scoped bookkeeping that is not Artifact bytes: the fixed
 * `artifacts`/`temp`/`control` directories, the cookie file, and partial fragment
 * accounting while yt-dlp rewrites its temporary output.
 */
export const WORKSPACE_HEADROOM_BYTES = 64 * MEBIBYTE;

/**
 * Baseline occupancy of a Download Request workspace before a single Artifact byte is
 * written. The workspace is the child process `TMPDIR` and `HOME`, and the packaged
 * yt-dlp is a PyInstaller one-file build that unpacks its whole Python runtime into
 * `TMPDIR` (`_MEI*`) for the lifetime of the process; the packaged Deno also caches
 * under `HOME`. That is a constant toolchain cost, not request data, so it does not
 * scale with the configured Artifact budget and must be a separate term. Folding it
 * into `WORKSPACE_HEADROOM_BYTES` instead made small `maximumTotalArtifactSizeMiB`
 * values reject downloads that fit their budget many times over.
 *
 * `test/resource-envelope-workspace.test.ts` measures the pinned toolchain against this
 * constant, so a toolchain that outgrows it fails the build instead of the operator.
 */
export const TOOLCHAIN_RUNTIME_BASELINE_BYTES = 128 * MEBIBYTE;

/**
 * yt-dlp exits with this code when a break condition stops the download process. The only break
 * condition an execution plan carries is the single-Artifact size filter this module projects in
 * `resourceEnvelopeOptionProfile` — `--max-downloads` and `--break-on-existing` are outside the
 * supported option profile and cannot be requested — so the exit code and the filter that causes
 * it are declared together with the term they enforce. Splitting them is what let #52 happen.
 */
export const YTDLP_BREAK_EXIT_CODE = 101;

/**
 * The binary data storage modes n8n itself knows. `database` enforces a configured file size
 * limit; `filesystem` and `s3` stream to a backend that enforces none, and `default` keeps the
 * bytes in the execution payload without a configured limit either.
 */
export const HOST_BINARY_DATA_MODES = ['database', 'default', 'filesystem', 's3'] as const;

export type HostBinaryDataMode = (typeof HOST_BINARY_DATA_MODES)[number];

/**
 * n8n's own default for `N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE`, and its own schema maximum for
 * it — the Postgres BYTEA hard limit. These are the values the node falls back to when the host
 * configuration cannot be read, so an unreadable setting produces the bound n8n itself would use
 * rather than a number the node picked.
 */
export const DEFAULT_DATABASE_MAX_FILE_SIZE_MIB = 512;
export const MAXIMUM_DATABASE_MAX_FILE_SIZE_MIB = 1024;

/**
 * The host n8n binary storage configuration a derived Resource Envelope term reads its bound
 * from. `maximumFileSizeBytes` is absent exactly when the host enforces no file size limit.
 */
export interface HostBinaryDataConfiguration {
	readonly mode: HostBinaryDataMode;
	readonly maximumFileSizeBytes?: number;
}

/**
 * Reads one n8n setting the way n8n reads it: the environment variable, or the file a `_FILE`
 * variable points at for Docker secret deployments. An unreadable file is not a value, so the
 * caller falls back to n8n's own default instead of guessing.
 */
function readHostEnvironmentValue(
	environment: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const value = environment[name];
	if (value !== undefined) return value;
	const path = environment[`${name}_FILE`];
	if (path === undefined || path === '') return undefined;
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * n8n's own mode rule, kept intact: an explicit `N8N_DEFAULT_BINARY_DATA_MODE` wins, and with no
 * readable mode the default is `database` in queue mode and `filesystem` in regular mode.
 */
function hostBinaryDataMode(environment: NodeJS.ProcessEnv): HostBinaryDataMode {
	const configured = readHostEnvironmentValue(environment, 'N8N_DEFAULT_BINARY_DATA_MODE');
	const modes: readonly string[] = HOST_BINARY_DATA_MODES;
	if (configured !== undefined && modes.includes(configured)) {
		return configured as HostBinaryDataMode;
	}
	return readHostEnvironmentValue(environment, 'EXECUTIONS_MODE') === 'queue'
		? 'database'
		: 'filesystem';
}

/**
 * The `database` mode file size limit, in bytes. n8n compares whole MiB of the written file
 * against this setting, so the byte bound is the configured MiB and a size above it is what n8n
 * itself would refuse. A value n8n would reject — unparseable, or above the schema maximum it
 * refuses to start with — is not a live configuration, so it falls back to n8n's own default.
 *
 * A value n8n accepts is mirrored even when it is degenerate. `N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE=`
 * coerces to 0 for n8n too, so on that host every binary write is refused; the node reads the same
 * bound and refuses the request before the bytes are spent instead of after the transfer fails.
 * Substituting a friendlier number here would be the node picking a limit its host does not have.
 */
function databaseMaximumFileSizeBytes(environment: NodeJS.ProcessEnv): number {
	const configured = readHostEnvironmentValue(
		environment,
		'N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE',
	);
	const configuredMiB = configured === undefined ? Number.NaN : Number(configured);
	const maximumFileSizeMiB =
		Number.isFinite(configuredMiB) && configuredMiB <= MAXIMUM_DATABASE_MAX_FILE_SIZE_MIB
			? configuredMiB
			: DEFAULT_DATABASE_MAX_FILE_SIZE_MIB;
	return Math.floor(maximumFileSizeMiB * MEBIBYTE);
}

export function readHostBinaryDataConfiguration(
	environment: NodeJS.ProcessEnv = process.env,
): HostBinaryDataConfiguration {
	const mode = hostBinaryDataMode(environment);
	return mode === 'database'
		? { mode, maximumFileSizeBytes: databaseMaximumFileSizeBytes(environment) }
		: { mode };
}

export interface ResourceEnvelopeConfiguration {
	requestTimeoutMinutes?: number;
	maximumArtifactCount?: number;
	maximumTotalArtifactSizeMiB?: number;
}

export interface ResourceEnvelope {
	requestTimeoutMs: number;
	maximumArtifactCount: number;
	/** Absent when the host enforces no file size limit, so no enforcement site applies one. */
	maximumArtifactSizeBytes: number | undefined;
	maximumTotalArtifactSizeBytes: number;
	maximumWorkspaceSizeBytes: number;
}

export class YtDlpRequestResourceLimitError extends Error {
	readonly code = RESOURCE_LIMIT;

	constructor(message = 'The download request exceeds the configured Resource Envelope.') {
		super(message);
		this.name = 'YtDlpRequestResourceLimitError';
	}
}

export class YtDlpExecutionResourceLimitError extends Error {
	readonly code = RESOURCE_LIMIT;

	constructor(message: string) {
		super(message);
		this.name = 'YtDlpExecutionResourceLimitError';
	}
}

export type ResourceEnvelopeErrorCode = typeof RESOURCE_LIMIT | typeof REQUEST_TIMEOUT;

/**
 * A term the node pins to a fixed value, so no request can exceed it and nothing has to be
 * classified after the fact.
 */
interface ImposedResourceEnvelopeTerm {
	readonly enforcement: 'imposed';
	readonly enforcedBy: string;
	/** The value the node pins the term to. The option profile projects it from here. */
	readonly value: number;
}

/**
 * A term another contract rejects before a Download Request exists, under that contract's own
 * frozen code rather than a Resource Envelope code.
 */
interface PreflightResourceEnvelopeTerm {
	readonly enforcement: 'preflight';
	readonly enforcedBy: string;
	readonly errorCode: string;
}

/**
 * A term a running execution or request can actually violate, together with the single
 * declaration of how that violation is classified and described.
 */
interface ViolableResourceEnvelopeTerm {
	readonly enforcement: 'violable';
	readonly scope: 'execution' | 'request';
	readonly errorCode: ResourceEnvelopeErrorCode;
	readonly violationMessage: string;
	/** Set when the workflow author may narrow the term, so its bound is range-checked too. */
	readonly configurable?: true;
}

/**
 * A term a running request can violate whose bound belongs to the host n8n configuration or to a
 * measured resource rather than to the node. The classification is the node's — one declaration,
 * read by every enforcement site, exactly as for a violable term — but the number is not, so the
 * node never substitutes one of its own: where the host carries no bound, the term carries none
 * and nothing is enforced.
 */
interface DerivedResourceEnvelopeTerm {
	readonly enforcement: 'derived';
	readonly scope: 'execution' | 'request';
	readonly errorCode: ResourceEnvelopeErrorCode;
	readonly violationMessage: string;
	/** Whose bound it is, named so the ownership is readable at the declaration. */
	readonly derivedFrom: string;
}

type ResourceEnvelopeTermDefinition =
	| DerivedResourceEnvelopeTerm
	| ImposedResourceEnvelopeTerm
	| PreflightResourceEnvelopeTerm
	| ViolableResourceEnvelopeTerm;

/**
 * Every Resource Envelope term, and the one place that decides what a violation of it is called.
 *
 * The Resource Envelope is a single domain concept enforced in four places — this module's
 * configuration bounds, the yt-dlp option profile in `download.ts`, the post-hoc Artifact checks
 * in `download.ts`, and the supervisor watchdog in `process.ts`. Before this table each of those
 * also decided the classification of what it caught, so two of them could silently disagree:
 * `--max-filesize` made an oversized Artifact reach `validateArtifactSet` as an empty Artifact
 * set, and the violation surfaced as `INVALID_ARTIFACT_SET` instead of `RESOURCE_LIMIT` (#52).
 * Every enforcement site now reads its code from here, so a term has exactly one classification.
 *
 * Adding a term to the Resource Envelope means adding it here, which forces choosing an
 * `enforcement` and, for a violable term, a frozen `errorCode` from the ADR 0026 vocabulary.
 */
export const RESOURCE_ENVELOPE_TERMS = {
	executionInputs: {
		enforcement: 'violable',
		scope: 'execution',
		errorCode: RESOURCE_LIMIT,
		violationMessage: `The execution exceeds the ${MAXIMUM_EXECUTION_INPUTS}-item Resource Envelope.`,
	},
	executionDuration: {
		enforcement: 'violable',
		scope: 'execution',
		errorCode: RESOURCE_LIMIT,
		violationMessage:
			`The execution exceeded the ${MAXIMUM_EXECUTION_DURATION_MS / (60 * 60 * 1000)}-hour ` +
			'Resource Envelope.',
	},
	requestTimeout: {
		enforcement: 'violable',
		configurable: true,
		scope: 'request',
		// ADR 0026 freezes `REQUEST_TIMEOUT` as its own request failure code, so this is the one
		// envelope term that does not classify as RESOURCE_LIMIT. The exception is declared here
		// rather than rediscovered at the supervisor.
		errorCode: REQUEST_TIMEOUT,
		violationMessage: 'yt-dlp exceeded the request timeout.',
	},
	artifactCount: {
		enforcement: 'violable',
		configurable: true,
		scope: 'request',
		errorCode: RESOURCE_LIMIT,
		violationMessage: 'The Download Request exceeded its Artifact count budget.',
	},
	artifactSize: {
		// The file size bound is the host's. In `database` mode n8n refuses a binary above its own
		// configured limit, and in `filesystem`, `s3` and in-memory modes it applies no file size
		// limit at all — so the node reads that configuration instead of imposing a number, and
		// enforces this term only where the host actually carries a bound.
		enforcement: 'derived',
		scope: 'request',
		errorCode: RESOURCE_LIMIT,
		derivedFrom:
			'the host n8n binary storage configuration (N8N_DEFAULT_BINARY_DATA_MODE, ' +
			'N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE)',
		violationMessage: 'The Download Request exceeded the n8n binary storage file size limit.',
	},
	totalArtifactSize: {
		enforcement: 'violable',
		configurable: true,
		scope: 'request',
		errorCode: RESOURCE_LIMIT,
		violationMessage: 'The Download Request exceeded its total Artifact size budget.',
	},
	workspaceSize: {
		enforcement: 'violable',
		scope: 'request',
		errorCode: RESOURCE_LIMIT,
		violationMessage: 'yt-dlp exceeded the request workspace limit.',
	},
	fragmentConcurrency: {
		enforcement: 'imposed',
		enforcedBy: '--concurrent-fragments in the yt-dlp option profile',
		value: 1,
	},
	ffmpegThreads: {
		enforcement: 'imposed',
		enforcedBy: 'ffmpeg:-threads in the yt-dlp postprocessor arguments',
		value: 1,
	},
	playlistEntries: {
		// The playlist selection cap is checked by the V1 Argument Allowlist while the Arguments
		// value is parsed, before a Download Request exists, so it can never reach a Resource
		// Envelope enforcement site. Its code belongs to the Arguments Grammar contract.
		enforcement: 'preflight',
		enforcedBy: 'the --playlist-items validator in the V1 Argument Allowlist',
		errorCode: 'INVALID_ARGUMENTS',
	},
} as const satisfies Readonly<Record<string, ResourceEnvelopeTermDefinition>>;

export type ResourceEnvelopeTerm = keyof typeof RESOURCE_ENVELOPE_TERMS;

type TermTable = typeof RESOURCE_ENVELOPE_TERMS;

export type ViolableResourceEnvelopeTermName = {
	[Term in ResourceEnvelopeTerm]: TermTable[Term]['enforcement'] extends 'violable' ? Term : never;
}[ResourceEnvelopeTerm];

/**
 * The terms whose bound belongs to the host configuration or to a measured resource. They are
 * violated and classified like violable terms; only the ownership of the number differs.
 */
export type DerivedResourceEnvelopeTermName = {
	[Term in ResourceEnvelopeTerm]: TermTable[Term]['enforcement'] extends 'derived' ? Term : never;
}[ResourceEnvelopeTerm];

/** Every term a running execution or request can violate, whoever the bound belongs to. */
export type RuntimeViolableResourceEnvelopeTermName =
	| DerivedResourceEnvelopeTermName
	| ViolableResourceEnvelopeTermName;

/**
 * The violable terms a workflow author may narrow. A configuration outside a term's hard cap
 * violates the Resource Envelope before any request runs. A derived term is never one of these:
 * its bound is not the node's to offer.
 */
export type ConfigurableResourceEnvelopeTerm = {
	[Term in ViolableResourceEnvelopeTermName]: TermTable[Term] extends { configurable: true }
		? Term
		: never;
}[ViolableResourceEnvelopeTermName];

/**
 * The classified terms whose declared code is `RESOURCE_LIMIT`. `resourceLimitViolationError` only
 * accepts these, so a term that ADR 0026 gives its own code cannot be smuggled into a Resource
 * Limit error class by a call site.
 */
export type ResourceLimitTerm = {
	[Term in RuntimeViolableResourceEnvelopeTermName]: TermTable[Term]['errorCode'] extends typeof RESOURCE_LIMIT
		? Term
		: never;
}[RuntimeViolableResourceEnvelopeTermName];

/**
 * Every produced `ResourceEnvelope` field, and the term it carries. Adding a field without naming
 * its term does not satisfy this Interface, and the term it names has to exist in the table
 * above — so a new envelope number cannot reach an enforcement site unclassified.
 *
 * This declaration exists for that compile-time bind alone; no enforcement site reads it at run
 * time. Terms that are not produced fields — the imposed ones, and the preflight one — are bound
 * instead by the term-inventory test in `test/resource-envelope.test.ts`, which fails when the
 * table and the Resource Envelope of ADR 0019 stop agreeing.
 */
export const RESOURCE_ENVELOPE_FIELD_TERMS: Readonly<
	Record<keyof ResourceEnvelope, ResourceEnvelopeTerm>
> = {
	requestTimeoutMs: 'requestTimeout',
	maximumArtifactCount: 'artifactCount',
	maximumArtifactSizeBytes: 'artifactSize',
	maximumTotalArtifactSizeBytes: 'totalArtifactSize',
	maximumWorkspaceSizeBytes: 'workspaceSize',
};

export function classifyResourceEnvelopeViolation(
	term: RuntimeViolableResourceEnvelopeTermName,
): DerivedResourceEnvelopeTerm | ViolableResourceEnvelopeTerm {
	const definition: ResourceEnvelopeTermDefinition | undefined = RESOURCE_ENVELOPE_TERMS[term];
	if (
		definition === undefined ||
		(definition.enforcement !== 'derived' && definition.enforcement !== 'violable')
	) {
		throw new Error(`The Resource Envelope term "${term}" has no violation classification.`);
	}
	return definition;
}

/**
 * Asking for a bound outside a term's hard cap is a violation of the Resource Envelope itself,
 * not of the running request, so it is always `RESOURCE_LIMIT` — including for `requestTimeout`,
 * whose runtime expiry carries the separate frozen `REQUEST_TIMEOUT` code. That is one decision
 * for every configurable term, declared here instead of at `createResourceEnvelope`.
 */
export function resourceEnvelopeConfigurationError(
	term: ConfigurableResourceEnvelopeTerm,
): YtDlpRequestResourceLimitError {
	// A configurable term is a violable term, and this lookup keeps that true at run time as well
	// as in the type: a term the table stops classifying cannot keep a configuration bound.
	classifyResourceEnvelopeViolation(term);
	return new YtDlpRequestResourceLimitError(
		`The configured ${term} is outside the Resource Envelope.`,
	);
}

export function resourceLimitViolationError(
	term: ResourceLimitTerm,
): YtDlpRequestResourceLimitError | YtDlpExecutionResourceLimitError {
	const violation = classifyResourceEnvelopeViolation(term);
	return violation.scope === 'execution'
		? new YtDlpExecutionResourceLimitError(violation.violationMessage)
		: new YtDlpRequestResourceLimitError(violation.violationMessage);
}

/**
 * The Resource Envelope terms that reach yt-dlp as options rather than as a post-hoc check: the
 * two imposed terms, and the derived file size bound, whose break filter rejects an oversized
 * format before the bytes are spent. The filter has to break rather than skip, because a skip
 * exits 0 with nothing written and reaches `validateArtifactSet` as an empty Artifact set; a
 * break exits `YTDLP_BREAK_EXIT_CODE`, which the supervisor classifies through this module. The
 * `?` suffix passes formats whose size is unknown before the download (a direct link carries no
 * `filesize`), and those fall to the Artifact size checks in `validateArtifactSet`.
 *
 * The bound is the host's, so a host that enforces no file size limit leaves nothing to project:
 * the early abort path is then absent and the same term is classified post-hoc instead. Two
 * enforcement moments of one declaration, exactly as when the extractor reports no size.
 */
export function resourceEnvelopeOptionProfile(envelope: ResourceEnvelope): string[] {
	const { maximumArtifactSizeBytes } = envelope;
	return [
		...(maximumArtifactSizeBytes === undefined
			? []
			: [
					'--break-match-filters',
					`filesize<=?${maximumArtifactSizeBytes} & ` +
						`filesize_approx<=?${maximumArtifactSizeBytes}`,
				]),
		'--concurrent-fragments',
		String(RESOURCE_ENVELOPE_TERMS.fragmentConcurrency.value),
		'--postprocessor-args',
		`ffmpeg:-threads ${RESOURCE_ENVELOPE_TERMS.ffmpegThreads.value}`,
	];
}

function boundedInteger(
	value: number,
	maximum: number,
	term: ConfigurableResourceEnvelopeTerm,
): number {
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw resourceEnvelopeConfigurationError(term);
	}
	return value;
}

export function createResourceEnvelope(
	configuration: ResourceEnvelopeConfiguration,
	host: HostBinaryDataConfiguration = readHostBinaryDataConfiguration(),
): ResourceEnvelope {
	const requestTimeoutMinutes = boundedInteger(
		configuration.requestTimeoutMinutes ?? DEFAULT_REQUEST_TIMEOUT_MINUTES,
		MAXIMUM_REQUEST_TIMEOUT_MINUTES,
		'requestTimeout',
	);
	const maximumArtifactCount = boundedInteger(
		configuration.maximumArtifactCount ?? DEFAULT_MAXIMUM_ARTIFACT_COUNT,
		MAXIMUM_ARTIFACT_COUNT,
		'artifactCount',
	);
	const maximumTotalArtifactSizeMiB = boundedInteger(
		configuration.maximumTotalArtifactSizeMiB ?? DEFAULT_MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
		MAXIMUM_TOTAL_ARTIFACT_SIZE_MIB,
		'totalArtifactSize',
	);
	const maximumTotalArtifactSizeBytes = maximumTotalArtifactSizeMiB * MEBIBYTE;

	return {
		requestTimeoutMs: requestTimeoutMinutes * 60 * 1000,
		maximumArtifactCount,
		// Declared even when the host carries no bound, so the field-term bind stays honest and an
		// enforcement site reads "no limit" rather than a missing field.
		maximumArtifactSizeBytes: host.maximumFileSizeBytes,
		maximumTotalArtifactSizeBytes,
		maximumWorkspaceSizeBytes:
			2 * maximumTotalArtifactSizeBytes +
			TOOLCHAIN_RUNTIME_BASELINE_BYTES +
			WORKSPACE_HEADROOM_BYTES,
	};
}
