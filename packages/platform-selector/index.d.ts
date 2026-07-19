export interface VerifiedToolchain {
	readonly deno: string;
	readonly ejsCore: string;
	readonly ejsLib: string;
	readonly ffmpeg: string;
	readonly ffprobe: string;
	readonly ytDlp: string;
}

export declare class ToolchainAttestationError extends Error {
	readonly code: 'TOOLCHAIN_ATTESTATION_FAILED';
}

export declare function getVerifiedToolchain(): Promise<VerifiedToolchain>;
