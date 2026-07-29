import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
	createBootstrapProvenancePayload,
	inspectBootstrapRegistryState,
	reconstructBootstrapProvenance,
} from '../scripts/bootstrap-recovery.mjs';

const candidate = {
	version: '0.2.0',
	commit: '25cdaedd3e10ef1a748c6a2dbc5c3ecc89cdf9f7',
	expectedRegistry: {
		packages: {
			'n8n-nodes-yt-dlp-linux-x64': {
				integrity: 'sha512-linux',
			},
			'n8n-nodes-yt-dlp-platform': {
				integrity: 'sha512-platform',
			},
			'n8n-nodes-yt-dlp': {
				integrity:
					'sha512-DnClZObcdKOlCEoAReeWlszqhtf8JXEVhCVdVECDxdMZBAbBDRIxYKwB5PA8KIOCQRupFXePvQaveu83B3cuHw==',
			},
		},
		provenance: {
			builderId: 'https://github.com/actions/runner/github-hosted',
			certificateIdentityURI:
				'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/.github/workflows/publish.yml@refs/heads/main',
			certificateIssuer: 'https://token.actions.githubusercontent.com',
			workflow: {
				path: '.github/workflows/publish.yml',
				repository: 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp',
			},
		},
	},
};

function rekorDocument(payloadHash: string) {
	const body = {
		apiVersion: '0.0.1',
		kind: 'dsse',
		spec: {
			envelopeHash: { algorithm: 'sha256', value: 'unused-by-reconstruction' },
			payloadHash: { algorithm: 'sha256', value: payloadHash },
			signatures: [{ signature: 'c2ln', verifier: 'Y2VydA==' }],
		},
	};
	return {
		entry: {
			body: Buffer.from(JSON.stringify(body)).toString('base64'),
			integratedTime: 1_785_341_560,
			logID: '00'.repeat(32),
			logIndex: 2_281_202_262,
			verification: {
				inclusionProof: {
					checkpoint: 'checkpoint',
					hashes: [],
					logIndex: 2_159_298_000,
					rootHash: '11'.repeat(32),
					treeSize: 2_159_340_741,
				},
				signedEntryTimestamp: 'c2V0',
			},
		},
	};
}

function registryFetch(mainResponse: {
	ok: boolean;
	status: number;
	json?: () => Promise<unknown>;
}) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith('/n8n-nodes-yt-dlp/0.2.0')) return mainResponse;
		const name = url.includes('linux-x64')
			? 'n8n-nodes-yt-dlp-linux-x64'
			: 'n8n-nodes-yt-dlp-platform';
		return {
			ok: true,
			status: 200,
			json: async () =>
				url.endsWith('/0.2.0')
					? {
							name,
							version: '0.2.0',
							dist: {
								integrity: name.endsWith('linux-x64')
									? 'sha512-linux'
									: 'sha512-platform',
							},
						}
					: { 'dist-tags': { latest: '0.2.0', next: '0.2.0' } },
		};
	});
}

describe('bootstrap publication recovery', () => {
	it('reconstructs and verifies the candidate-bound main-package provenance', async () => {
		const payload = createBootstrapProvenancePayload(candidate);
		expect(createHash('sha256').update(payload).digest('hex')).toBe(
			'f7cdbb5b6c8bc3f722fbb384ee2ccb66d68dcc9a3a7d26648ad95191ba941ecc',
		);
		const verifyBundle = vi.fn(async () => undefined);

		const bundle = await reconstructBootstrapProvenance(
			candidate,
			rekorDocument('f7cdbb5b6c8bc3f722fbb384ee2ccb66d68dcc9a3a7d26648ad95191ba941ecc'),
			{
				certificateToDer: () => Buffer.from('certificate-der'),
				verifyBundle,
			},
		);

		expect(verifyBundle).toHaveBeenCalledWith(bundle, {
			certificateIdentityURI:
				'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/.github/workflows/publish.yml@refs/heads/main',
			certificateIssuer: 'https://token.actions.githubusercontent.com',
		});
		expect(bundle).toMatchObject({
			mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
			dsseEnvelope: {
				payload: payload.toString('base64'),
				payloadType: 'application/vnd.in-toto+json',
				signatures: [{ keyid: '', sig: 'c2ln' }],
			},
			verificationMaterial: {
				certificate: {
					rawBytes: Buffer.from('certificate-der').toString('base64'),
				},
				tlogEntries: [
					{
						integratedTime: '1785341560',
						logIndex: '2281202262',
					},
				],
			},
		});
	});

	it('accepts candidate-bound dependency packages and reports a missing main package', async () => {
		const fetchImpl = registryFetch({ ok: false, status: 404 });

		await expect(
			inspectBootstrapRegistryState(
				candidate,
				'https://registry.npmjs.org',
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({ publicationRequired: true });
	});

	it('continues cleanup without republishing an already recovered exact main package', async () => {
		const fetchImpl = registryFetch({
			ok: true,
			status: 200,
			json: async () => ({
				name: 'n8n-nodes-yt-dlp',
				version: '0.2.0',
				dist: {
					integrity:
						'sha512-DnClZObcdKOlCEoAReeWlszqhtf8JXEVhCVdVECDxdMZBAbBDRIxYKwB5PA8KIOCQRupFXePvQaveu83B3cuHw==',
				},
			}),
		});

		await expect(
			inspectBootstrapRegistryState(
				candidate,
				'https://registry.npmjs.org',
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({ publicationRequired: false });
	});

	it('rejects any recovery registry other than the public npm registry', async () => {
		const fetchImpl = vi.fn();
		await expect(
			inspectBootstrapRegistryState(
				candidate,
				'https://registry.example.test',
				fetchImpl as unknown as typeof fetch,
			),
		).rejects.toThrow('must be https://registry.npmjs.org');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejects a Rekor entry for a different provenance payload', async () => {
		await expect(
			reconstructBootstrapProvenance(candidate, rekorDocument('0'.repeat(64)), {
				certificateToDer: () => Buffer.from('certificate-der'),
				verifyBundle: async () => undefined,
			}),
		).rejects.toThrow('Rekor payload digest does not match');
	});
});
