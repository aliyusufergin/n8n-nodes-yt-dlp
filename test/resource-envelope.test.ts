import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
	DEFAULT_DATABASE_MAX_FILE_SIZE_MIB,
	MEBIBYTE,
	REQUEST_TIMEOUT,
	RESOURCE_ENVELOPE_FIELD_TERMS,
	RESOURCE_ENVELOPE_TERMS,
	RESOURCE_LIMIT,
	TOOLCHAIN_RUNTIME_BASELINE_BYTES,
	WORKSPACE_DISK_RESERVE_BYTES,
	YtDlpRequestResourceLimitError,
	classifyResourceEnvelopeViolation,
	createResourceEnvelope,
	readHostBinaryDataConfiguration,
	readHostExecutionDurationMs,
	readHostResourceConfiguration,
	resourceEnvelopeOptionProfile,
	resourceLimitViolationError,
	type HostResourceConfiguration,
	type ResourceEnvelope,
	type ResourceEnvelopeConfiguration,
	type ResourceEnvelopeTerm,
} from '../nodes/YtDlp/resource-envelope';

/** Free disk space that comfortably clears the toolchain baseline and the container reserve. */
const AVAILABLE_WORKSPACE_BYTES = 8 * 1024 * MEBIBYTE;

/** A host that stores binary data outside the database, so it enforces no file size limit. */
const FILESYSTEM_HOST: HostResourceConfiguration = {
	binaryData: { mode: 'filesystem' },
	availableWorkspaceBytes: AVAILABLE_WORKSPACE_BYTES,
};

/** A host running n8n's own `database` mode default. */
const DATABASE_HOST: HostResourceConfiguration = {
	binaryData: {
		mode: 'database',
		maximumFileSizeBytes: DEFAULT_DATABASE_MAX_FILE_SIZE_MIB * MEBIBYTE,
	},
	availableWorkspaceBytes: AVAILABLE_WORKSPACE_BYTES,
};

function databaseHost(maximumFileSizeBytes: number): HostResourceConfiguration {
	return {
		binaryData: { mode: 'database', maximumFileSizeBytes },
		availableWorkspaceBytes: AVAILABLE_WORKSPACE_BYTES,
	};
}

/**
 * The request failure vocabulary ADR 0026 freezes. A Resource Envelope term may only classify
 * as a code that already exists here; widening the vocabulary is a contract change, not a
 * classification decision an enforcement site or a new term gets to make.
 */
const FROZEN_REQUEST_FAILURE_CODES = [
	'INVALID_SOURCE_URL',
	'INVALID_ARGUMENTS',
	'YTDLP_FAILED',
	'REQUEST_TIMEOUT',
	'PROCESS_OUTPUT_LIMIT',
	'RESOURCE_LIMIT',
	'INVALID_ARTIFACT_SET',
	'BINARY_TRANSFER_FAILED',
] as const;

const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(
		temporaryDirectories.map(
			async (directory) => await rm(directory, { force: true, recursive: true }),
		),
	);
});

/** A host setting delivered as a Docker secret file, the way n8n also accepts one. */
async function environmentFile(name: string, content: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-host-configuration-'));
	temporaryDirectories.push(directory);
	const path = join(directory, name);
	await writeFile(path, content);
	return path;
}

describe('Resource Envelope policy', () => {
	it('uses the accepted request defaults', () => {
		expect(createResourceEnvelope({}, DATABASE_HOST)).toEqual({
			requestTimeoutMs: 30 * 60 * 1000,
			maximumArtifactSizeBytes: 512 * MEBIBYTE,
			maximumWorkspaceSizeBytes: AVAILABLE_WORKSPACE_BYTES - WORKSPACE_DISK_RESERVE_BYTES,
		});
	});

	it('accepts every immutable hard boundary', () => {
		expect(createResourceEnvelope({ requestTimeoutMinutes: 60 }, DATABASE_HOST)).toEqual({
			requestTimeoutMs: 60 * 60 * 1000,
			maximumArtifactSizeBytes: 512 * MEBIBYTE,
			maximumWorkspaceSizeBytes: AVAILABLE_WORKSPACE_BYTES - WORKSPACE_DISK_RESERVE_BYTES,
		});
	});

	it.each([{ requestTimeoutMinutes: 61 }, { requestTimeoutMinutes: 0 }])(
		'rejects an invalid or above-hard-cap request configuration: %o',
		(configuration) => {
			expect(() => createResourceEnvelope(configuration, DATABASE_HOST)).toThrowError(
				expect.objectContaining<Partial<YtDlpRequestResourceLimitError>>({
					code: RESOURCE_LIMIT,
					name: 'YtDlpRequestResourceLimitError',
				}),
			);
		},
	);

	it('no longer offers the Artifact count and total size bounds the node picked', () => {
		// Locality, compile time: the caps the node chose for the workflow author are gone, so the
		// configuration surface that carried them is gone too rather than silently ignored.
		// @ts-expect-error -- 'maximumArtifactCount' is no longer a Resource Envelope term.
		const artifactCount: ResourceEnvelopeConfiguration = { maximumArtifactCount: 20 };
		// @ts-expect-error -- 'maximumTotalArtifactSizeMiB' is no longer a Resource Envelope term.
		const totalArtifactSize: ResourceEnvelopeConfiguration = { maximumTotalArtifactSizeMiB: 256 };

		expect(artifactCount).toBeDefined();
		expect(totalArtifactSize).toBeDefined();
	});

	it('carries no file size bound when the host enforces none', () => {
		// The node does not substitute a number of its own for a limit the host does not have:
		// in `filesystem` and `s3` modes n8n applies no file size limit, so neither does the node.
		expect(createResourceEnvelope({}, FILESYSTEM_HOST)).toMatchObject({
			maximumArtifactSizeBytes: undefined,
		});
	});

	it('derives the file size bound from the host configuration', () => {
		expect(createResourceEnvelope({}, databaseHost(1024 * MEBIBYTE))).toMatchObject({
			maximumArtifactSizeBytes: 1024 * MEBIBYTE,
		});
	});

	it('does not let the workflow author narrow a derived term', () => {
		// Locality, compile time: a derived term's bound belongs to the host, so it is not part of
		// the configuration surface a workflow author may set.
		// @ts-expect-error -- 'maximumArtifactSizeMiB' is not a Resource Envelope configuration field.
		const configuration: ResourceEnvelopeConfiguration = { maximumArtifactSizeMiB: 1 };

		expect(configuration).toBeDefined();
	});
});

describe('derived workspace bound', () => {
	it('derives the workspace bound from the measured free disk space', () => {
		expect(
			createResourceEnvelope(
				{},
				{ binaryData: { mode: 'filesystem' }, availableWorkspaceBytes: 4 * 1024 * MEBIBYTE },
			).maximumWorkspaceSizeBytes,
		).toBe(4 * 1024 * MEBIBYTE - WORKSPACE_DISK_RESERVE_BYTES);
	});

	it('leaves the container reserve outside the bound whatever the free space is', () => {
		// The watchdog samples the workspace about once per second, so the reserve is what keeps a
		// fast download from filling the container's disk between two samples.
		for (const availableWorkspaceBytes of [1024 * MEBIBYTE, 64 * 1024 * MEBIBYTE]) {
			const envelope = createResourceEnvelope(
				{},
				{ binaryData: { mode: 'filesystem' }, availableWorkspaceBytes },
			);

			expect(availableWorkspaceBytes - envelope.maximumWorkspaceSizeBytes).toBe(
				WORKSPACE_DISK_RESERVE_BYTES,
			);
		}
	});

	it('refuses a request whose free disk cannot hold the pinned toolchain', () => {
		// A workspace that cannot even hold the unpacked toolchain has no room for an Artifact, so
		// the request is refused before the bytes are spent rather than terminated mid-download.
		expect(() =>
			createResourceEnvelope(
				{},
				{
					binaryData: { mode: 'filesystem' },
					availableWorkspaceBytes:
						TOOLCHAIN_RUNTIME_BASELINE_BYTES + WORKSPACE_DISK_RESERVE_BYTES,
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<YtDlpRequestResourceLimitError>>({
				code: RESOURCE_LIMIT,
				name: 'YtDlpRequestResourceLimitError',
			}),
		);
	});

	it('measures the free disk space where the request workspace is written', async () => {
		const host = await readHostResourceConfiguration(tmpdir(), {});

		expect(host.binaryData).toEqual({ mode: 'filesystem' });
		expect(host.availableWorkspaceBytes).toBeGreaterThan(0);
	});
});

describe('host n8n execution timeout', () => {
	it.each([
		{
			environment: {},
			workflowTimeoutSeconds: undefined,
			expected: undefined,
			why: 'n8n imposes no execution timeout by default, so the node imposes none either',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: '0' },
			workflowTimeoutSeconds: undefined,
			expected: undefined,
			why: 'a non-positive setting is n8n\u2019s way of saying there is no timeout',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: '900' },
			workflowTimeoutSeconds: undefined,
			expected: 900 * 1000,
			why: 'the configured timeout is the bound',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: '99999' },
			workflowTimeoutSeconds: undefined,
			expected: 60 * 60 * 1000,
			why: 'n8n clamps a configured timeout to EXECUTIONS_TIMEOUT_MAX, whose default is an hour',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: '99999', EXECUTIONS_TIMEOUT_MAX: '7200' },
			workflowTimeoutSeconds: undefined,
			expected: 7200 * 1000,
			why: 'the operator-raised ceiling is the one n8n clamps to',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: 'not-a-number' },
			workflowTimeoutSeconds: undefined,
			expected: undefined,
			why: 'an unreadable setting falls back to n8n\u2019s own default, not to a node number',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: '900' },
			workflowTimeoutSeconds: 120,
			expected: 120 * 1000,
			why: 'a workflow-level timeout wins over the instance setting, the way n8n resolves it',
		},
		{
			environment: {},
			workflowTimeoutSeconds: 120,
			expected: 120 * 1000,
			why: 'a workflow-level timeout applies even when the instance sets none',
		},
		{
			environment: { EXECUTIONS_TIMEOUT: '900' },
			workflowTimeoutSeconds: 0,
			expected: undefined,
			why: 'a workflow that asks for no timeout gets none, the way n8n resolves it',
		},
	])(
		'derives $expected ms when the host says $why',
		({ environment, workflowTimeoutSeconds, expected }) => {
			expect(readHostExecutionDurationMs(environment, workflowTimeoutSeconds)).toBe(expected);
		},
	);

	it('reads a Docker secret file the way n8n reads it', async () => {
		const path = await environmentFile('executions-timeout', '600\n');

		expect(readHostExecutionDurationMs({ EXECUTIONS_TIMEOUT_FILE: path })).toBe(600 * 1000);
	});
});

describe('host n8n binary data configuration', () => {
	it.each([
		{
			environment: {},
			expected: { mode: 'filesystem' },
			why: 'regular mode defaults to filesystem, the way n8n itself does',
		},
		{
			environment: { EXECUTIONS_MODE: 'queue' },
			expected: { mode: 'database', maximumFileSizeBytes: 512 * MEBIBYTE },
			why: 'queue mode defaults to database, the way n8n itself does',
		},
		{
			environment: { N8N_DEFAULT_BINARY_DATA_MODE: 'filesystem', EXECUTIONS_MODE: 'queue' },
			expected: { mode: 'filesystem' },
			why: 'an explicit mode wins over the execution-mode rule',
		},
		{
			environment: { N8N_DEFAULT_BINARY_DATA_MODE: 's3' },
			expected: { mode: 's3' },
			why: 's3 storage carries no n8n file size limit',
		},
		{
			environment: { N8N_DEFAULT_BINARY_DATA_MODE: 'default' },
			expected: { mode: 'default' },
			why: 'in-memory storage has no configured file size limit either',
		},
		{
			environment: {
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE: '1024',
			},
			expected: { mode: 'database', maximumFileSizeBytes: 1024 * MEBIBYTE },
			why: 'the operator-configured limit is the bound',
		},
		{
			environment: {
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE: '2048',
			},
			expected: { mode: 'database', maximumFileSizeBytes: 512 * MEBIBYTE },
			why: 'a value above the Postgres BYTEA schema maximum is one n8n itself refuses',
		},
		{
			environment: {
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE: 'not-a-number',
			},
			expected: { mode: 'database', maximumFileSizeBytes: 512 * MEBIBYTE },
			why: 'an unreadable limit falls back to n8n’s own default, not to a node number',
		},
		{
			environment: { N8N_DEFAULT_BINARY_DATA_MODE: 'unsupported-mode', EXECUTIONS_MODE: 'queue' },
			expected: { mode: 'database', maximumFileSizeBytes: 512 * MEBIBYTE },
			why: 'an unreadable mode falls back to the rule n8n itself falls back to',
		},
		{
			environment: {
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE: '',
			},
			expected: { mode: 'database', maximumFileSizeBytes: 0 },
			why: 'an empty setting is the zero limit n8n itself would enforce, not a missing one',
		},
		{
			environment: {
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE: '-5',
			},
			expected: { mode: 'database', maximumFileSizeBytes: -5 * MEBIBYTE },
			why: 'a negative setting is one n8n accepts, so the node refuses what n8n would refuse',
		},
		{
			environment: {
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE: ' 256 ',
			},
			expected: { mode: 'database', maximumFileSizeBytes: 256 * MEBIBYTE },
			why: 'a padded number coerces the way n8n coerces it',
		},
	])('reads $expected.mode when the host environment says $why', ({ environment, expected }) => {
		expect(readHostBinaryDataConfiguration(environment)).toEqual(expected);
	});

	it('reads a Docker secret file the way n8n reads it', async () => {
		const path = await environmentFile('max-file-size', '1024\n');

		expect(
			readHostBinaryDataConfiguration({
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE_FILE: path,
			}),
		).toEqual({ mode: 'database', maximumFileSizeBytes: 1024 * MEBIBYTE });
	});

	it('takes n8n’s own fallback when a mode secret file is not exactly a mode', async () => {
		// n8n does not trim a `_FILE` value before matching it against its mode enum, so a file
		// written with a trailing newline leaves n8n on its execution-mode rule. Reading it any
		// more forgivingly here would make the node enforce a bound its host does not have.
		const path = await environmentFile('binary-data-mode', 'database\n');

		expect(
			readHostBinaryDataConfiguration({
				N8N_DEFAULT_BINARY_DATA_MODE_FILE: path,
				EXECUTIONS_MODE: 'regular',
			}),
		).toEqual({ mode: 'filesystem' });
	});

	it('falls back to the n8n default when a secret file cannot be read', () => {
		expect(
			readHostBinaryDataConfiguration({
				N8N_DEFAULT_BINARY_DATA_MODE: 'database',
				N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE_FILE: join(tmpdir(), 'n8n-yt-dlp-absent-secret'),
			}),
		).toEqual({ mode: 'database', maximumFileSizeBytes: 512 * MEBIBYTE });
	});
});

describe('Resource Envelope violation classification', () => {
	it('names a declared term for every ResourceEnvelope field', () => {
		expect(Object.keys(RESOURCE_ENVELOPE_FIELD_TERMS).sort()).toEqual(
			Object.keys(createResourceEnvelope({}, FILESYSTEM_HOST)).sort(),
		);
		for (const term of Object.values(RESOURCE_ENVELOPE_FIELD_TERMS)) {
			expect(RESOURCE_ENVELOPE_TERMS).toHaveProperty(term);
		}
	});

	it('declares the Resource Envelope of ADR 0040, less the two terms still in flight', () => {
		// The tripwire for terms that are not produced envelope fields: the imposed ones and the
		// preflight one are bound by nothing at compile time, so widening the Resource Envelope
		// without classifying the new term fails here instead of silently reaching a call site.
		//
		// ADR 0040 also removes `requestTimeout` and `playlistEntries`, and both are still here:
		// the request timeout becomes no-progress detection in #115 and the playlist cap goes with
		// playlist expansion in #117. Until then this list is the ADR plus those two, and it is
		// this line that has to change when they land.
		expect(Object.keys(RESOURCE_ENVELOPE_TERMS).sort()).toEqual([
			'artifactSize',
			'executionDuration',
			'ffmpegThreads',
			'fragmentConcurrency',
			'playlistEntries',
			'requestTimeout',
			'workspaceSize',
		]);
	});

	it('classifies every declared term exactly once', () => {
		for (const [term, definition] of Object.entries(RESOURCE_ENVELOPE_TERMS)) {
			expect(['derived', 'imposed', 'preflight', 'violable'], term).toContain(
				definition.enforcement,
			);
			if (definition.enforcement === 'imposed' || definition.enforcement === 'preflight') {
				// A term nothing classifies still has to say where it is enforced, so an unclassified
				// term cannot mean "nobody knows".
				expect(definition.enforcedBy.length, term).toBeGreaterThan(0);
				continue;
			}
			if (definition.enforcement === 'derived') {
				// A derived term is violable, but its bound is not the node's, so it also has to say
				// whose it is — the fourth category exists to make that ownership readable.
				expect(definition.derivedFrom.length, term).toBeGreaterThan(0);
			}
			expect(FROZEN_REQUEST_FAILURE_CODES, term).toContain(definition.errorCode);
			expect(definition.violationMessage.length, term).toBeGreaterThan(0);
		}
	});

	it.each([
		{ term: 'artifactSize', owner: 'N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE' },
		{ term: 'executionDuration', owner: 'EXECUTIONS_TIMEOUT' },
		{ term: 'workspaceSize', owner: 'free disk space' },
	] as const)('classifies $term as derived from $owner', ({ term, owner }) => {
		const definition = RESOURCE_ENVELOPE_TERMS[term];

		expect(definition.enforcement).toBe('derived');
		expect(definition.derivedFrom).toContain(owner);
	});

	it('imposes only the protection constants ADR 0040 keeps', () => {
		// ADR 0040 keeps exactly two imposed terms — both protection that does not limit what a
		// user may download, both deferred to #107. Every other bound that limits capability is
		// the host's or a measured resource's. The request timeout and the playlist selection cap
		// are not imposed terms and are not this test's subject; they move in #115 and #117.
		for (const [term, definition] of Object.entries(RESOURCE_ENVELOPE_TERMS)) {
			if (definition.enforcement !== 'imposed') continue;
			expect(['fragmentConcurrency', 'ffmpegThreads']).toContain(term);
		}
	});

	it.each(['artifactSize', 'workspaceSize', 'executionDuration'] as const)(
		'classifies a violated %s as RESOURCE_LIMIT',
		(term) => {
			expect(classifyResourceEnvelopeViolation(term).errorCode).toBe(RESOURCE_LIMIT);
		},
	);

	it('keeps the frozen REQUEST_TIMEOUT code for the request timeout term', () => {
		// ADR 0026 freezes `REQUEST_TIMEOUT` as its own request failure code, so this one envelope
		// term does not classify as RESOURCE_LIMIT. The table is the place that exception is
		// declared; no enforcement site gets to decide it again.
		expect(classifyResourceEnvelopeViolation('requestTimeout').errorCode).toBe(REQUEST_TIMEOUT);
	});

	it.each([
		{ term: 'artifactSize', name: 'YtDlpRequestResourceLimitError' },
		{ term: 'executionDuration', name: 'YtDlpExecutionResourceLimitError' },
	] as const)('builds a $name for a violated $term', ({ term, name }) => {
		const error = resourceLimitViolationError(term);

		expect(error).toMatchObject({ code: RESOURCE_LIMIT, name });
		expect(error.message).toBe(classifyResourceEnvelopeViolation(term).violationMessage);
	});

	it('projects the terms that reach yt-dlp as options', () => {
		const envelope = createResourceEnvelope({}, databaseHost(MEBIBYTE));

		expect(resourceEnvelopeOptionProfile(envelope)).toEqual([
			'--break-match-filters',
			`filesize<=?${MEBIBYTE} & filesize_approx<=?${MEBIBYTE}`,
			'--concurrent-fragments',
			'1',
			'--postprocessor-args',
			'ffmpeg:-threads 1',
		]);
	});

	it('drops the early abort filter when the derived term carries no bound', () => {
		// Without a host bound there is no number to project and no violation to classify: the
		// early abort path is simply absent. The post-hoc path still classifies through this term
		// when a bound does exist and the extractor withheld the size before the download.
		expect(resourceEnvelopeOptionProfile(createResourceEnvelope({}, FILESYSTEM_HOST))).toEqual([
			'--concurrent-fragments',
			'1',
			'--postprocessor-args',
			'ffmpeg:-threads 1',
		]);
	});

	it('rejects a term that was never declared', () => {
		// Locality, compile time: an added Resource Envelope term cannot be classified anywhere
		// until it exists in the table, so the classification decision cannot drift to a call site.
		// @ts-expect-error -- 'diskQuota' is not a declared Resource Envelope term.
		expect(() => classifyResourceEnvelopeViolation('diskQuota')).toThrowError();
	});

	it('rejects a field-term map that leaves a field unnamed', () => {
		// Locality, compile time: adding a field to `ResourceEnvelope` without naming its term
		// fails to satisfy this Interface, and the term it names must exist in the table above.
		const incomplete = { requestTimeoutMs: 'requestTimeout' } as const;
		// @ts-expect-error -- a field map missing a term does not satisfy the field-term Interface.
		const mapping: Record<keyof ResourceEnvelope, ResourceEnvelopeTerm> = incomplete;

		expect(mapping.requestTimeoutMs).toBe('requestTimeout');
	});
});
