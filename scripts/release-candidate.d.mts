export function npmPublishEnvelopeBytes(tarballSizeBytes: number): number;

export function recompressPlatformTarball(
	tarballPath: string,
	temporaryRoot: string,
): Promise<void>;
