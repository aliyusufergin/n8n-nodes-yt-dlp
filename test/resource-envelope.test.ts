import { describe, expect, it } from 'vitest';

import {
	MEBIBYTE,
	REQUEST_TIMEOUT,
	RESOURCE_ENVELOPE_FIELD_TERMS,
	RESOURCE_ENVELOPE_TERMS,
	RESOURCE_LIMIT,
	YtDlpRequestResourceLimitError,
	classifyResourceEnvelopeViolation,
	createResourceEnvelope,
	resourceEnvelopeOptionProfile,
	resourceEnvelopeViolationError,
	type ResourceEnvelope,
	type ResourceEnvelopeTerm,
} from '../nodes/YtDlp/resource-envelope';

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
		expect(createResourceEnvelope({})).toEqual({
			requestTimeoutMs: 30 * 60 * 1000,
			maximumArtifactCount: 20,
			maximumArtifactSizeBytes: 128 * MEBIBYTE,
			maximumTotalArtifactSizeBytes: 256 * MEBIBYTE,
			maximumWorkspaceSizeBytes: 704 * MEBIBYTE,
		});
	});

	it('accepts every immutable hard boundary', () => {
		expect(
			createResourceEnvelope({
				requestTimeoutMinutes: 60,
				maximumArtifactCount: 50,
				maximumArtifactSizeMiB: 256,
				maximumTotalArtifactSizeMiB: 512,
			}),
		).toEqual({
			requestTimeoutMs: 60 * 60 * 1000,
			maximumArtifactCount: 50,
			maximumArtifactSizeBytes: 256 * MEBIBYTE,
			maximumTotalArtifactSizeBytes: 512 * MEBIBYTE,
			maximumWorkspaceSizeBytes: 1216 * MEBIBYTE,
		});
	});

	it.each([
		{ requestTimeoutMinutes: 61 },
		{ maximumArtifactCount: 51 },
		{ maximumArtifactSizeMiB: 257 },
		{ maximumTotalArtifactSizeMiB: 513 },
		{ requestTimeoutMinutes: 0 },
		{ maximumArtifactCount: 1.5 },
	])('rejects an invalid or above-hard-cap request configuration: %o', (configuration) => {
		expect(() => createResourceEnvelope(configuration)).toThrowError(
			expect.objectContaining<Partial<YtDlpRequestResourceLimitError>>({
				code: RESOURCE_LIMIT,
				name: 'YtDlpRequestResourceLimitError',
			}),
		);
	});
});

describe('Resource Envelope violation classification', () => {
	it('names a declared term for every ResourceEnvelope field', () => {
		expect(Object.keys(RESOURCE_ENVELOPE_FIELD_TERMS).sort()).toEqual(
			Object.keys(createResourceEnvelope({})).sort(),
		);
		for (const term of Object.values(RESOURCE_ENVELOPE_FIELD_TERMS)) {
			expect(RESOURCE_ENVELOPE_TERMS).toHaveProperty(term);
		}
	});

	it('classifies every declared term exactly once', () => {
		for (const [term, definition] of Object.entries(RESOURCE_ENVELOPE_TERMS)) {
			expect(['imposed', 'preflight', 'violable'], term).toContain(definition.enforcement);
			if (definition.enforcement !== 'violable') continue;
			expect(FROZEN_REQUEST_FAILURE_CODES, term).toContain(definition.errorCode);
			expect(definition.violationMessage.length, term).toBeGreaterThan(0);
		}
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
		const error = resourceEnvelopeViolationError(term);

		expect(error).toMatchObject({ code: RESOURCE_LIMIT, name });
		expect(error.message).toBe(classifyResourceEnvelopeViolation(term).violationMessage);
	});

	it('projects the imposed terms into the yt-dlp option profile', () => {
		const envelope = createResourceEnvelope({ maximumArtifactSizeMiB: 1 });

		expect(resourceEnvelopeOptionProfile(envelope)).toEqual([
			'--break-match-filters',
			`filesize<=?${MEBIBYTE} & filesize_approx<=?${MEBIBYTE}`,
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
