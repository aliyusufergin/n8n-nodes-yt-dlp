import { createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyCandidate, verifySigstoreBundle } from './release-candidate.mjs';

const recovery = {
	candidateSha256: '23b019830d524fe9a0cce7a50e78c5e505355a8df1f41c53167ce7884e3012db',
	eventName: 'workflow_dispatch',
	repositoryId: '1301443025',
	repositoryOwnerId: '254281921',
	runAttempt: '2',
	runId: '30467323585',
	rekorLogIndex: '2281202262',
};
const mainPackageName = 'n8n-nodes-yt-dlp';
const dependencyPackageNames = [
	'n8n-nodes-yt-dlp-linux-x64',
	'n8n-nodes-yt-dlp-platform',
];

function fail(message) {
	throw new Error(message);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function expectedMain(candidate) {
	const expected = candidate.expectedRegistry?.packages?.[mainPackageName];
	const provenance = candidate.expectedRegistry?.provenance;
	if (
		candidate.version !== '0.2.0' ||
		candidate.commit !== '25cdaedd3e10ef1a748c6a2dbc5c3ecc89cdf9f7' ||
		typeof expected?.integrity !== 'string' ||
		typeof provenance?.builderId !== 'string' ||
		typeof provenance?.certificateIdentityURI !== 'string' ||
		typeof provenance?.certificateIssuer !== 'string' ||
		typeof provenance?.workflow?.path !== 'string' ||
		typeof provenance?.workflow?.repository !== 'string'
	) {
		fail('Bootstrap recovery candidate identity is invalid.');
	}
	return { expected, provenance };
}

export function createBootstrapProvenancePayload(candidate) {
	const { expected, provenance } = expectedMain(candidate);
	const identityPrefix = `${provenance.workflow.repository}/${provenance.workflow.path}@`;
	if (!provenance.certificateIdentityURI.startsWith(identityPrefix)) {
		fail('Bootstrap recovery workflow identity is invalid.');
	}
	const workflowRef = provenance.certificateIdentityURI.slice(identityPrefix.length);
	const sha512 = Buffer.from(expected.integrity.slice('sha512-'.length), 'base64').toString(
		'hex',
	);
	const payload = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: [
			{
				name: `pkg:npm/${mainPackageName}@${candidate.version}`,
				digest: { sha512 },
			},
		],
		predicateType: 'https://slsa.dev/provenance/v1',
		predicate: {
			buildDefinition: {
				buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
				externalParameters: {
					workflow: {
						ref: workflowRef,
						repository: provenance.workflow.repository,
						path: provenance.workflow.path,
					},
				},
				internalParameters: {
					github: {
						event_name: recovery.eventName,
						repository_id: recovery.repositoryId,
						repository_owner_id: recovery.repositoryOwnerId,
					},
				},
				resolvedDependencies: [
					{
						uri: `git+${provenance.workflow.repository}@${workflowRef}`,
						digest: { gitCommit: candidate.commit },
					},
				],
			},
			runDetails: {
				builder: { id: provenance.builderId },
				metadata: {
					invocationId: `${provenance.workflow.repository}/actions/runs/${recovery.runId}/attempts/${recovery.runAttempt}`,
				},
			},
		},
	};
	return Buffer.from(JSON.stringify(payload));
}

function defaultCertificateToDer(certificatePem) {
	return new X509Certificate(certificatePem).raw;
}

export async function reconstructBootstrapProvenance(
	candidate,
	rekorDocument,
	{
		certificateToDer = defaultCertificateToDer,
		verifyBundle = verifySigstoreBundle,
	} = {},
) {
	const entries = Object.values(rekorDocument ?? {});
	if (entries.length !== 1) fail('Expected exactly one Rekor entry.');
	const entry = entries[0];
	if (String(entry?.logIndex) !== recovery.rekorLogIndex) {
		fail('Rekor log index does not match the bootstrap recovery.');
	}

	let body;
	try {
		body = JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8'));
	} catch {
		fail('Rekor entry body is invalid.');
	}
	const signature = body?.spec?.signatures?.[0];
	const payload = createBootstrapProvenancePayload(candidate);
	if (
		body?.apiVersion !== '0.0.1' ||
		body?.kind !== 'dsse' ||
		body?.spec?.payloadHash?.algorithm !== 'sha256' ||
		body.spec.payloadHash.value !== sha256(payload) ||
		body?.spec?.envelopeHash?.algorithm !== 'sha256' ||
		body?.spec?.signatures?.length !== 1 ||
		typeof signature?.signature !== 'string' ||
		typeof signature?.verifier !== 'string'
	) {
		fail('Rekor payload digest does not match the bootstrap recovery candidate.');
	}
	const proof = entry.verification?.inclusionProof;
	if (
		typeof entry.logID !== 'string' ||
		typeof entry.verification?.signedEntryTimestamp !== 'string' ||
		proof === undefined ||
		!Array.isArray(proof.hashes)
	) {
		fail('Rekor verification material is incomplete.');
	}

	const certificatePem = Buffer.from(signature.verifier, 'base64');
	const bundle = {
		mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
		verificationMaterial: {
			certificate: {
				rawBytes: certificateToDer(certificatePem).toString('base64'),
			},
			tlogEntries: [
				{
					logIndex: String(entry.logIndex),
					logId: {
						keyId: Buffer.from(entry.logID, 'hex').toString('base64'),
					},
					kindVersion: {
						kind: body.kind,
						version: body.apiVersion,
					},
					integratedTime: String(entry.integratedTime),
					inclusionPromise: {
						signedEntryTimestamp: entry.verification.signedEntryTimestamp,
					},
					inclusionProof: {
						logIndex: String(proof.logIndex),
						rootHash: Buffer.from(proof.rootHash, 'hex').toString('base64'),
						treeSize: String(proof.treeSize),
						hashes: proof.hashes.map((hash) =>
							Buffer.from(hash, 'hex').toString('base64'),
						),
						checkpoint: { envelope: proof.checkpoint },
					},
					canonicalizedBody: entry.body,
				},
			],
			timestampVerificationData: {},
		},
		dsseEnvelope: {
			payload: payload.toString('base64'),
			payloadType: 'application/vnd.in-toto+json',
			signatures: [{ keyid: '', sig: signature.signature }],
		},
	};
	const { provenance } = expectedMain(candidate);
	await verifyBundle(bundle, {
		certificateIdentityURI: provenance.certificateIdentityURI,
		certificateIssuer: provenance.certificateIssuer,
	});
	return bundle;
}

async function verifyBootstrapDependencyPackages(candidate, registry, fetchImpl) {
	for (const name of dependencyPackageNames) {
		const expected = candidate.expectedRegistry.packages[name];
		const packageUrl = `${registry}/${encodeURIComponent(name)}`;
		const [packumentResponse, metadataResponse] = await Promise.all([
			fetchImpl(packageUrl, { signal: AbortSignal.timeout(30_000) }),
			fetchImpl(`${packageUrl}/${candidate.version}`, {
				signal: AbortSignal.timeout(30_000),
			}),
		]);
		if (!packumentResponse.ok || !metadataResponse.ok) {
			fail(`${name} must be published before bootstrap recovery.`);
		}
		const [packument, metadata] = await Promise.all([
			packumentResponse.json(),
			metadataResponse.json(),
		]);
		if (
			packument['dist-tags']?.next !== candidate.version ||
			(packument['dist-tags']?.latest !== undefined &&
				packument['dist-tags'].latest !== candidate.version) ||
			metadata.name !== name ||
			metadata.version !== candidate.version ||
			metadata.dist?.integrity !== expected.integrity
		) {
			fail(`${name} does not match the bootstrap recovery candidate.`);
		}
	}
}

export async function inspectBootstrapRegistryState(
	candidate,
	registryArgument,
	fetchImpl = fetch,
) {
	const registry = new URL(registryArgument);
	if (registry.href !== 'https://registry.npmjs.org/') {
		fail('Bootstrap recovery registry must be https://registry.npmjs.org.');
	}
	await verifyBootstrapDependencyPackages(
		candidate,
		registry.href.replace(/\/$/u, ''),
		fetchImpl,
	);
	const { expected } = expectedMain(candidate);
	const mainResponse = await fetchImpl(
		`${registry.href}${encodeURIComponent(mainPackageName)}/${candidate.version}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (mainResponse.status === 404) return { publicationRequired: true };
	if (!mainResponse.ok) {
		fail(`${mainPackageName} registry metadata returned HTTP ${mainResponse.status}.`);
	}
	const metadata = await mainResponse.json();
	if (
		metadata.name !== mainPackageName ||
		metadata.version !== candidate.version ||
		metadata.dist?.integrity !== expected.integrity
	) {
		fail(`${mainPackageName} does not match the bootstrap recovery candidate.`);
	}
	return { publicationRequired: false };
}

async function prepareBootstrapRecovery(
	candidateDirectory,
	registryArgument,
	outputPath,
	statePath,
	{ fetchImpl = fetch } = {},
) {
	const candidateRoot = resolve(candidateDirectory);
	const candidatePath = resolve(candidateRoot, 'release-candidate.json');
	const candidateBytes = await readFile(candidatePath);
	if (sha256(candidateBytes) !== recovery.candidateSha256) {
		fail('Bootstrap recovery candidate manifest digest mismatch.');
	}
	const candidate = await verifyCandidate(candidateRoot);
	const registryState = await inspectBootstrapRegistryState(
		candidate,
		registryArgument,
		fetchImpl,
	);
	const rekorResponse = await fetchImpl(
		`https://rekor.sigstore.dev/api/v1/log/entries?logIndex=${recovery.rekorLogIndex}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (!rekorResponse.ok) fail(`Rekor returned HTTP ${rekorResponse.status}.`);
	const bundle = await reconstructBootstrapProvenance(candidate, await rekorResponse.json());
	await writeFile(resolve(outputPath), `${JSON.stringify(bundle)}\n`);
	await writeFile(
		resolve(statePath),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				candidateSha256: recovery.candidateSha256,
				package: mainPackageName,
				publicationRequired: registryState.publicationRequired,
				version: candidate.version,
			},
			null,
			2,
		)}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({
			candidateSha256: recovery.candidateSha256,
			logIndex: recovery.rekorLogIndex,
			package: mainPackageName,
			publicationRequired: registryState.publicationRequired,
			version: candidate.version,
		})}\n`,
	);
}

async function main() {
	const [command, ...arguments_] = process.argv.slice(2);
	if (command !== 'prepare' || arguments_.length !== 4) {
		fail(
			'Usage: bootstrap-recovery.mjs prepare <candidate-directory> <registry-url> <output.sigstore> <state.json>',
		);
	}
	await prepareBootstrapRecovery(arguments_[0], arguments_[1], arguments_[2], arguments_[3]);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	await main();
}
