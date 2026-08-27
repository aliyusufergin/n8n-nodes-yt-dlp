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
	YtDlpRequestResourceLimitError,
	classifyResourceEnvelopeViolation,
	createResourceEnvelope,
	readHostBinaryDataConfiguration,
	resourceEnvelopeOptionProfile,
	resourceLimitViolationError,
	type HostBinaryDataConfiguration,
	type ResourceEnvelope,
	type ResourceEnvelopeConfiguration,
	type ResourceEnvelopeTerm,
} from '../nodes/YtDlp/resource-envelope';

/** A host that stores binary data outside the database, so it enforces no file size limit. */
const FILESYSTEM_HOST: HostBinaryDataConfiguration = { mode: 'filesystem' };

/** A host running n8n's own `database` mode default. */
const DATABASE_HOST: HostBinaryDataConfiguration = {
	mode: 'database',
	maximumFileSizeBytes: DEFAULT_DATABASE_MAX_FILE_SIZE_MIB * MEBIBYTE,
};

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

describe('Resource Envelope policy', () => {
	it('uses the accepted request defaults', () => {
		expect(createResourceEnvelope({}, DATABASE_HOST)).toEqual({
			requestTimeoutMs: 30 * 60 * 1000,
			maximumArtifactCount: 20,
			maximumArtifactSizeBytes: 512 * MEBIBYTE,
			maximumTotalArtifactSizeBytes: 256 * MEBIBYTE,
			maximumWorkspaceSizeBytes: 704 * MEBIBYTE,
		});
	});

	it('accepts every immutable hard boundary', () => {
		expect(
			createResourceEnvelope(
				{
					requestTimeoutMinutes: 60,
					maximumArtifactCount: 50,
					maximumTotalArtifactSizeMiB: 512,
				},
				DATABASE_HOST,
			),
		).toEqual({
			requestTimeoutMs: 60 * 60 * 1000,
			maximumArtifactCount: 50,
			maximumArtifactSizeBytes: 512 * MEBIBYTE,
			maximumTotalArtifactSizeBytes: 512 * MEBIBYTE,
			maximumWorkspaceSizeBytes: 1216 * MEBIBYTE,
		});
	});

	it.each([
		{ requestTimeoutMinutes: 61 },
		{ maximumArtifactCount: 51 },
		{ maximumTotalArtifactSizeMiB: 513 },
		{ requestTimeoutMinutes: 0 },
		{ maximumArtifactCount: 1.5 },
	])('rejects an invalid or above-hard-cap request configuration: %o', (configuration) => {
		expect(() => createResourceEnvelope(configuration, DATABASE_HOST)).toThrowError(
			expect.objectContaining<Partial<YtDlpRequestResourceLimitError>>({
				code: RESOURCE_LIMIT,
				name: 'YtDlpRequestResourceLimitError',
			}),
		);
	});

	it('carries no file size bound when the host enforces none', () => {
		// The node does not substitute a number of its own for a limit the host does not have:
		// in `filesystem` and `s3` modes n8n applies no file size limit, so neither does the node.
		expect(createResourceEnvelope({}, FILESYSTEM_HOST)).toMatchObject({
			maximumArtifactSizeBytes: undefined,
		});
	});

	it('derives the file size bound from the host configuration', () => {
		expect(
			createResourceEnvelope({}, { mode: 'database', maximumFileSizeBytes: 1024 * MEBIBYTE }),
		).toMatchObject({ maximumArtifactSizeBytes: 1024 * MEBIBYTE });
	});

	it('does not let the workflow author narrow a derived term', () => {
		// Locality, compile time: a derived term's bound belongs to the host, so it is not part of
		// the configuration surface a workflow author may set.
		// @ts-expect-error -- 'maximumArtifactSizeMiB' is not a Resource Envelope configuration field.
		const configuration: ResourceEnvelopeConfiguration = { maximumArtifactSizeMiB: 1 };

		expect(configuration).toBeDefined();
	});
});

describe('host n8n binary data configuration', () => {
	const temporaryDirectories: string[] = [];

	afterAll(async () => {
		await Promise.all(
			temporaryDirectories.map(
				async (directory) => await rm(directory, { force: true, recursive: true }),
			),
		);
	});

	async function environmentFile(name: string, content: string): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-host-configuration-'));
		temporaryDirectories.push(directory);
		const path = join(directory, name);
		await writeFile(path, content);
		return path;
	}

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

	it('declares exactly the Resource Envelope of ADR 0019', () => {
		// The tripwire for terms that are not produced envelope fields: the imposed ones and the
		// preflight one are bound by nothing at compile time, so widening the Resource Envelope
		// without classifying the new term fails here instead of silently reaching a call site.
		expect(Object.keys(RESOURCE_ENVELOPE_TERMS).sort()).toEqual([
			'artifactCount',
			'artifactSize',
			'executionDuration',
			'executionInputs',
			'ffmpegThreads',
			'fragmentConcurrency',
			'playlistEntries',
			'requestTimeout',
			'totalArtifactSize',
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

	it('classifies the file size term as derived from the host configuration', () => {
		const definition = RESOURCE_ENVELOPE_TERMS.artifactSize;

		expect(definition.enforcement).toBe('derived');
		expect(definition.derivedFrom).toContain('N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE');
	});

	it.each([
		'artifactCount',
		'artifactSize',
		'totalArtifactSize',
		'workspaceSize',
		'executionInputs',
		'executionDuration',
	] as const)('classifies a violated %s as RESOURCE_LIMIT', (term) => {
		expect(classifyResourceEnvelopeViolation(term).errorCode).toBe(RESOURCE_LIMIT);
	});

	it('keeps the frozen REQUEST_TIMEOUT code for the request timeout term', () => {
		// ADR 0026 freezes `REQUEST_TIMEOUT` as its own request failure code, so this one envelope
		// term does not classify as RESOURCE_LIMIT. The table is the place that exception is
		// declared; no enforcement site gets to decide it again.
		expect(classifyResourceEnvelopeViolation('requestTimeout').errorCode).toBe(REQUEST_TIMEOUT);
	});

	it.each([
		{ term: 'artifactSize', name: 'YtDlpRequestResourceLimitError' },
		{ term: 'executionInputs', name: 'YtDlpExecutionResourceLimitError' },
	] as const)('builds a $name for a violated $term', ({ term, name }) => {
		const error = resourceLimitViolationError(term);

		expect(error).toMatchObject({ code: RESOURCE_LIMIT, name });
		expect(error.message).toBe(classifyResourceEnvelopeViolation(term).violationMessage);
	});

	it('projects the terms that reach yt-dlp as options', () => {
		const envelope = createResourceEnvelope(
			{},
			{ mode: 'database', maximumFileSizeBytes: MEBIBYTE },
		);

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
