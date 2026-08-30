import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

export const RESOURCE_LIMIT = 'RESOURCE_LIMIT';
export const REQUEST_TIMEOUT = 'REQUEST_TIMEOUT';
export const MEBIBYTE = 1024 * 1024;

/**
 * How long a Download Request may make no progress at all before the supervisor terminates its
 * Process Group. It is not a bound on how long a request may take: a download that keeps moving
 * runs as long as it needs to, and only a process that has stopped moving is stopped. It is a node
 * constant because it protects the worker slot a hung process would hold forever, not because it
 * decides what a user may download.
 *
 * Progress is read from the two signals the supervisor already carries: bytes on the child's
 * stdout and stderr, and a change in the measured workspace size. yt-dlp runs under
 * `--no-progress`, so a running download is normally silent and the workspace is the signal that
 * carries it; the workspace is sampled about once per second, so this bound is many sampling
 * intervals wide — a stalled process has to miss hundreds of samples, not one.
 */
export const NO_PROGRESS_LIMIT_MS = 5 * 60 * 1000;

/**
 * The free disk space the workspace bound leaves untouched for the rest of the container. The
 * watchdog measures the workspace about once per second, so a request that writes faster than the
 * sampling interval overshoots its bound by whatever it wrote in between; the reserve absorbs that
 * overshoot instead of the container's last free bytes. It is a node constant because it protects
 * the host, not because it caps a download: it never decides how large an Artifact may be, only how
 * much of the disk a request may never reach.
 */
export const WORKSPACE_DISK_RESERVE_BYTES = 256 * MEBIBYTE;

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
 * n8n's own defaults for its execution timeout settings, in seconds: `-1`, meaning no timeout at
 * all, and a one hour ceiling on whatever an instance or a workflow asks for.
 */
export const DEFAULT_EXECUTIONS_TIMEOUT_SECONDS = -1;
export const DEFAULT_EXECUTIONS_TIMEOUT_MAX_SECONDS = 60 * 60;

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

/**
 * Reads one numeric n8n setting the way n8n reads it: `Number` coercion, and a value that coerces
 * to `NaN` is one n8n warns about and ignores, so it falls back to n8n's own default rather than to
 * a number the node picked.
 */
function hostNumberSetting(
	environment: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
): number {
	const configured = readHostEnvironmentValue(environment, name);
	if (configured === undefined) return fallback;
	const parsed = Number(configured);
	return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * The execution duration bound, in milliseconds, or `undefined` when the host imposes no execution
 * timeout — in which case the node imposes none either. n8n's own resolution is kept intact: a
 * workflow's `executionTimeout` setting wins over `EXECUTIONS_TIMEOUT`, a positive result is clamped
 * to `EXECUTIONS_TIMEOUT_MAX`, and anything that is not positive means no timeout at all.
 */
export function readHostExecutionDurationMs(
	environment: NodeJS.ProcessEnv = process.env,
	workflowExecutionTimeoutSeconds?: number,
): number | undefined {
	const requestedSeconds =
		workflowExecutionTimeoutSeconds ??
		hostNumberSetting(environment, 'EXECUTIONS_TIMEOUT', DEFAULT_EXECUTIONS_TIMEOUT_SECONDS);
	if (!(requestedSeconds > 0)) return undefined;
	const seconds = Math.min(
		requestedSeconds,
		hostNumberSetting(
			environment,
			'EXECUTIONS_TIMEOUT_MAX',
			DEFAULT_EXECUTIONS_TIMEOUT_MAX_SECONDS,
		),
	);
	return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Everything outside the node that a derived Resource Envelope term reads its bound from: the host
 * n8n binary storage configuration, and the free disk space measured where the Download Request
 * workspace will be written.
 */
export interface HostResourceConfiguration {
	readonly binaryData: HostBinaryDataConfiguration;
	readonly availableWorkspaceBytes: number;
}

export async function readHostResourceConfiguration(
	workspaceParent: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<HostResourceConfiguration> {
	const { bavail, bsize } = await statfs(workspaceParent);
	return {
		binaryData: readHostBinaryDataConfiguration(environment),
		// `bavail` is what an unprivileged process may still write, which is what the request has.
		availableWorkspaceBytes: bavail * bsize,
	};
}

export interface ResourceEnvelope {
	noProgressLimitMs: number;
	/** Absent when the host enforces no file size limit, so no enforcement site applies one. */
	maximumArtifactSizeBytes: number | undefined;
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
	executionDuration: {
		// The execution duration bound is the host's. n8n stops an execution that outruns its own
		// timeout, so the node reads the same setting and stops the request it is running with a
		// classified violation instead of being cut off mid-transfer. Where n8n configures no
		// timeout, the node imposes none of its own and a long download simply runs.
		enforcement: 'derived',
		scope: 'execution',
		errorCode: RESOURCE_LIMIT,
		derivedFrom:
			'the host n8n execution timeout configuration (EXECUTIONS_TIMEOUT, ' +
			'EXECUTIONS_TIMEOUT_MAX) and the workflow execution timeout setting',
		violationMessage: 'The execution exceeded the n8n execution timeout.',
	},
	noProgress: {
		// The bound this term carries is the node's, and it is protection rather than capability:
		// ADR 0040 splits "this download may take at most this long" off from "this process is
		// stuck", removes the first and keeps the second, watching progress instead of elapsed
		// time. ADR 0026 freezes `REQUEST_TIMEOUT` as its own request failure code, so this is the
		// one envelope term that does not classify as RESOURCE_LIMIT, and the trigger changing
		// does not change the code. The exception is declared here rather than rediscovered at
		// the supervisor.
		enforcement: 'violable',
		scope: 'request',
		errorCode: REQUEST_TIMEOUT,
		violationMessage: 'yt-dlp stopped making progress.',
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
	workspaceSize: {
		// The workspace bound is no longer derivable from an Artifact budget the node picked, so it
		// comes from the disk the request actually has: the free space measured where the workspace
		// is written, less the reserve the node leaves for the rest of the container.
		enforcement: 'derived',
		scope: 'request',
		errorCode: RESOURCE_LIMIT,
		derivedFrom: 'the free disk space measured where the request workspace is written',
		// One message for both moments the term is enforced: the free disk measured at request
		// start cannot hold the workspace the request needs, or the running workspace grew past
		// what that disk had. Present tense, so it is true of a request that never started.
		violationMessage:
			'The Download Request workspace does not fit the free disk space available to it.',
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
 * time. Terms that are not produced fields — the imposed ones, the preflight one, and the
 * execution-scoped duration — are bound instead by the term-inventory test in
 * `test/resource-envelope.test.ts`, which fails when the table and the Resource Envelope of
 * ADR 0040 stop agreeing.
 */
export const RESOURCE_ENVELOPE_FIELD_TERMS: Readonly<
	Record<keyof ResourceEnvelope, ResourceEnvelopeTerm>
> = {
	noProgressLimitMs: 'noProgress',
	maximumArtifactSizeBytes: 'artifactSize',
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

/**
 * The workspace bound: the free disk the request actually has, less the reserve the node leaves for
 * the rest of the container. The measured toolchain baseline is the floor — a workspace that cannot
 * hold the unpacked toolchain has no room for a single Artifact byte, so the request is refused
 * before it is spent rather than terminated once the watchdog sees the unpack.
 */
function workspaceSizeBytes(availableWorkspaceBytes: number): number {
	const maximumWorkspaceSizeBytes =
		Math.floor(availableWorkspaceBytes) - WORKSPACE_DISK_RESERVE_BYTES;
	if (
		!Number.isSafeInteger(maximumWorkspaceSizeBytes) ||
		maximumWorkspaceSizeBytes <= TOOLCHAIN_RUNTIME_BASELINE_BYTES
	) {
		throw resourceLimitViolationError('workspaceSize');
	}
	return maximumWorkspaceSizeBytes;
}

/**
 * The Resource Envelope one Download Request runs inside. It takes no configuration: every bound
 * that limits what a user may download belongs to the host or to a measured resource, and the one
 * node-owned number left is protection the workflow author does not get to widen.
 */
export function createResourceEnvelope(host: HostResourceConfiguration): ResourceEnvelope {
	return {
		noProgressLimitMs: NO_PROGRESS_LIMIT_MS,
		// Declared even when the host carries no bound, so the field-term bind stays honest and an
		// enforcement site reads "no limit" rather than a missing field.
		maximumArtifactSizeBytes: host.binaryData.maximumFileSizeBytes,
		maximumWorkspaceSizeBytes: workspaceSizeBytes(host.availableWorkspaceBytes),
	};
}
