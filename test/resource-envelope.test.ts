import { describe, expect, it } from 'vitest';

import {
	MEBIBYTE,
	RESOURCE_LIMIT,
	YtDlpRequestResourceLimitError,
	createResourceEnvelope,
} from '../nodes/YtDlp/resource-envelope';

describe('Resource Envelope policy', () => {
	it('uses the accepted request defaults', () => {
		expect(createResourceEnvelope({})).toEqual({
			requestTimeoutMs: 30 * 60 * 1000,
			maximumArtifactCount: 20,
			maximumArtifactSizeBytes: 128 * MEBIBYTE,
			maximumTotalArtifactSizeBytes: 256 * MEBIBYTE,
			maximumWorkspaceSizeBytes: 576 * MEBIBYTE,
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
			maximumWorkspaceSizeBytes: 1088 * MEBIBYTE,
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
