export interface BootstrapRecoveryCandidate {
	version: string;
	commit: string;
	expectedRegistry: {
		packages: Record<string, { integrity: string }>;
		provenance: {
			builderId: string;
			certificateIdentityURI: string;
			certificateIssuer: string;
			workflow: {
				path: string;
				repository: string;
			};
		};
	};
}

export function createBootstrapProvenancePayload(
	candidate: BootstrapRecoveryCandidate,
): Buffer;

export function reconstructBootstrapProvenance(
	candidate: BootstrapRecoveryCandidate,
	rekorDocument: unknown,
	options?: {
		certificateToDer?: (certificatePem: Buffer) => Buffer;
		verifyBundle?: (
			bundle: unknown,
			expectedIdentity: {
				certificateIdentityURI: string;
				certificateIssuer: string;
			},
		) => Promise<void>;
	},
): Promise<Record<string, unknown>>;

export function inspectBootstrapRegistryState(
	candidate: BootstrapRecoveryCandidate,
	registryArgument: string,
	fetchImpl?: typeof fetch,
): Promise<{ publicationRequired: boolean }>;
