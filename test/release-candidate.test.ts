import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { npmPublishEnvelopeBytes } from '../scripts/release-candidate.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve('.');
const requiredLanes = [
	'source-delivery',
	'hermetic',
	'three-anchor',
	'multiworker',
	'capacity',
	'official-ejs',
	'live-canary',
	'registry-readback',
	'acceptance-stack',
] as const;
const npmPublishEnvelopeLimitBytes = 250 * 1024 * 1024;
// What a `materialize-registry` run reaches once the dist-tag gate has let it through: the fixture
// registry serves no real Sigstore material, so verification stops at the provenance bundle.
const DIST_TAG_GATE_PASSED = 'Registry provenance Sigstore signature verification failed.';
const imagesByLane: Partial<Record<(typeof requiredLanes)[number], string[]>> = {
	'acceptance-stack': [
		'docker.n8n.io/n8nio/n8n@sha256:f5140088385af2d4e681e177d8264bcb41e8fe126062030c5c65cd8f3e1605e1',
	],
	capacity: [
		'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
	],
	multiworker: [
		'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
	],
	'three-anchor': [
		'docker.n8n.io/n8nio/n8n@sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795',
		'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1',
		'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
	],
};

interface CandidateManifest {
	commit: string;
	expectedRegistry: {
		packages: Record<
			string,
			{
				dependencies?: Record<string, string>;
				integrity: string;
				optionalDependencies?: Record<string, string>;
				sha256: string;
				tarball: string;
				version: string;
			}
		>;
		provenance: {
			builderId: string;
			certificateIdentityURI: string;
			certificateIssuer: string;
			commit: string;
			predicateType: string;
			workflow: { path: string; repository: string };
		};
	};
	packages: Array<{
		contents: Array<{ mode: number; path: string; sha256: string; sizeBytes: number }>;
		name: string;
		sha256: string;
		sizeBytes: number;
		tarball: string;
		version: string;
	}>;
	rollback: {
		order: string[];
		strategy: string;
		unpublish: false;
	};
	schemaVersion: number;
	source: {
		bundles: Array<{ checksumUrl: string; name: string; sha256: string; url: string }>;
	};
	toolchain: {
		buildTools: { node: string; npm: string; sevenZip: string };
		components: string[];
		executionManifestSha256: string;
		lockSha256: string;
	};
	version: string;
}

let candidateRoot: string;
let manifest: CandidateManifest;

function sha256(contents: Buffer | string): string {
	return createHash('sha256').update(contents).digest('hex');
}

async function writeGateEvidence(
	evidenceRoot: string,
	candidateSha256: string,
	overrides: Partial<Record<(typeof requiredLanes)[number], Record<string, unknown>>> = {},
): Promise<void> {
	await mkdir(evidenceRoot, { recursive: true });
	for (const lane of requiredLanes) {
		const testId =
			lane === 'acceptance-stack'
				? 'n8n-2.34.6-acceptance-stack'
				: lane === 'live-canary'
					? 'YE7VzlLtp-4'
					: lane;
		await writeFile(
			join(evidenceRoot, `${lane}.json`),
			`${JSON.stringify({
				schemaVersion: 1,
				candidateSha256,
				completedAt: '2026-07-29T08:00:00.000Z',
				diagnostics: ['bounded fixture evidence'],
				identities: {
					...(imagesByLane[lane] === undefined ? {} : { images: imagesByLane[lane] }),
					...(lane === 'hermetic'
						? {
								isolation: {
									image:
										'node@sha256:8d3442d5f074940723be6eece34e992eb147ba1f59c73888e8f257918dea2e78',
									network: 'none',
								},
							}
						: {}),
					packages: manifest.packages.map(({ name, sha256: packageSha256, version }) => ({
						name,
						sha256: packageSha256,
						version,
					})),
					source: manifest.source,
					test: { id: testId },
					toolchain:
						lane === 'live-canary'
							? {
									...manifest.toolchain,
									versions: {
										deno: 'v2.9.3',
										ffmpeg: 'autobuild-2026-07-12-15-07',
										'yt-dlp': '2026.07.14.233956',
										'yt-dlp-ejs': '0.8.0',
									},
								}
							: manifest.toolchain,
				},
				lane,
				outcome: 'pass',
				region: 'test-region',
				waived: false,
				...overrides[lane],
			})}\n`,
		);
	}
}

beforeAll(async () => {
	candidateRoot = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-release-candidate-'));
	await execFileAsync(process.execPath, ['scripts/release-candidate.mjs', 'build', candidateRoot], {
		cwd: repositoryRoot,
		timeout: 240_000,
	});
	manifest = JSON.parse(
		await readFile(join(candidateRoot, 'release-candidate.json'), 'utf8'),
	) as CandidateManifest;
}, 250_000);

afterAll(async () => {
	if (candidateRoot !== undefined) {
		await rm(candidateRoot, { force: true, recursive: true });
	}
});

describe('immutable Release Candidate Chain', () => {
	it('fits the platform tarball inside the bounded npm publish request envelope', () => {
		const platform = manifest.packages.find(
			({ name }) => name === 'n8n-nodes-yt-dlp-linux-x64',
		);
		expect(platform).toBeDefined();

		expect(npmPublishEnvelopeBytes(platform!.sizeBytes)).toBeLessThanOrEqual(
			npmPublishEnvelopeLimitBytes,
		);
	});

	it('builds and attests the exact three-package chain for registry read-back', async () => {
		expect(manifest).toMatchObject({
			schemaVersion: 1,
			version: '0.2.1',
			rollback: {
				strategy: 'dist-tags-deprecation-new-patch',
				unpublish: false,
				order: ['n8n-nodes-yt-dlp', 'n8n-nodes-yt-dlp-platform', 'n8n-nodes-yt-dlp-linux-x64'],
			},
		});
		expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/u);
		expect(manifest.expectedRegistry.provenance).toEqual({
			builderId: 'https://github.com/actions/runner/github-hosted',
			certificateIdentityURI:
				'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/.github/workflows/publish.yml@refs/heads/main',
			certificateIssuer: 'https://token.actions.githubusercontent.com',
			commit: manifest.commit,
			predicateType: 'https://slsa.dev/provenance/v1',
			workflow: {
				path: '.github/workflows/publish.yml',
				repository: 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp',
			},
		});
		expect(manifest.packages.map(({ name }) => name)).toEqual([
			'n8n-nodes-yt-dlp-linux-x64',
			'n8n-nodes-yt-dlp-platform',
			'n8n-nodes-yt-dlp',
		]);
		for (const packageEvidence of manifest.packages) {
			expect(packageEvidence.version).toBe('0.2.1');
			const tarball = await readFile(join(candidateRoot, 'tarballs', packageEvidence.tarball));
			expect(packageEvidence.sha256).toBe(sha256(tarball));
			expect(packageEvidence.sizeBytes).toBe(tarball.byteLength);
			expect(packageEvidence.contents).toContainEqual(
				expect.objectContaining({
					path: 'package/package.json',
					mode: 0o644,
					sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
				}),
			);
			expect(packageEvidence.contents.some(({ path }) => path.includes('node_modules'))).toBe(
				false,
			);
			expect(manifest.expectedRegistry.packages[packageEvidence.name]).toMatchObject({
				version: '0.2.1',
				tarball: packageEvidence.tarball,
				sha256: packageEvidence.sha256,
				integrity: expect.stringMatching(/^sha512-/u),
			});
		}
		expect(manifest.toolchain).toMatchObject({
			buildTools: {
				node: expect.stringMatching(/^v\d+\./u),
				npm: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
				sevenZip: '5.2.0',
			},
			components: ['yt-dlp', 'ffmpeg', 'deno', 'linux-runtime', 'yt-dlp-ejs'],
			executionManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
			lockSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
		});
		expect(manifest.source.bundles).toContainEqual({
			checksumUrl:
				'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz.sha256',
			name: 'n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz',
			sha256: '3dcd8963e229e3b34fb9d0d969377e59e25a01146fd128282ad599200034e882',
			url: 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp/releases/download/v0.2.0/n8n-nodes-yt-dlp-ffmpeg-source-0.2.0.tar.xz',
		});
		for (const bundle of manifest.source.bundles) {
			expect(bundle.checksumUrl).toBe(`${bundle.url}.sha256`);
		}

		const attestation = JSON.parse(
			await readFile(join(candidateRoot, 'build-provenance.json'), 'utf8'),
		) as { predicateType: string; subject: Array<{ digest: { sha256: string }; name: string }> };
		expect(attestation.predicateType).toBe('https://slsa.dev/provenance/v1');
		expect(attestation.subject).toEqual(
			manifest.packages.map(({ name, sha256: digest, version }) => ({
				digest: { sha256: digest },
				name: `pkg:npm/${name}@${version}`,
			})),
		);
		expect((await readdir(join(candidateRoot, 'tarballs'))).sort()).toEqual(
			manifest.packages.map(({ tarball }) => tarball).sort(),
		);
	});

	it('finalizes bounded, identity-bound evidence only when every lane passes', async () => {
		const candidateBytes = await readFile(join(candidateRoot, 'release-candidate.json'));
		const candidateSha256 = sha256(candidateBytes);
		const evidenceRoot = join(candidateRoot, 'passing-evidence');
		const outputPath = join(candidateRoot, 'release-evidence-0.2.1.json');
		await writeGateEvidence(evidenceRoot, candidateSha256);

		await execFileAsync(
			process.execPath,
			[
				'scripts/release-candidate.mjs',
				'finalize-evidence',
				join(candidateRoot, 'release-candidate.json'),
				evidenceRoot,
				outputPath,
			],
			{ cwd: repositoryRoot },
		);

		const evidence = JSON.parse(await readFile(outputPath, 'utf8')) as {
			candidateSha256: string;
			gates: Array<{ lane: string; outcome: string }>;
			packages: CandidateManifest['packages'];
			schemaVersion: number;
			version: string;
		};
		expect(evidence).toMatchObject({
			schemaVersion: 1,
			version: '0.2.1',
			candidateSha256,
		});
		expect(evidence.gates.map(({ lane, outcome }) => ({ lane, outcome }))).toEqual(
			requiredLanes.map((lane) => ({ lane, outcome: 'pass' })),
		);
		expect(evidence.packages).toEqual(manifest.packages);
	});

	it.each([
		['inconclusive live outcome', 'live-canary', { outcome: 'inconclusive' }],
		['waived capacity lane', 'capacity', { waived: true }],
	] as const)('rejects %s', async (_, lane, override) => {
		const candidateBytes = await readFile(join(candidateRoot, 'release-candidate.json'));
		const evidenceRoot = join(candidateRoot, `rejected-${lane}`);
		await writeGateEvidence(evidenceRoot, sha256(candidateBytes), {
			[lane]: override,
		});

		await expect(
			execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'finalize-evidence',
					join(candidateRoot, 'release-candidate.json'),
					evidenceRoot,
					join(candidateRoot, `rejected-${lane}.json`),
				],
				{ cwd: repositoryRoot },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining(`${lane} must pass without a waiver`),
		});
	});

	it('rejects gate evidence without candidate-matching identities', async () => {
		const candidateBytes = await readFile(join(candidateRoot, 'release-candidate.json'));
		const evidenceRoot = join(candidateRoot, 'rejected-identities');
		await writeGateEvidence(evidenceRoot, sha256(candidateBytes), {
			'acceptance-stack': { identities: {} },
		});

		await expect(
			execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'finalize-evidence',
					join(candidateRoot, 'release-candidate.json'),
					evidenceRoot,
					join(candidateRoot, 'release-evidence-0.2.1.json'),
				],
				{ cwd: repositoryRoot },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining(
				'acceptance-stack evidence package identities do not match the candidate',
			),
		});
	});

	it('rejects the former acceptance image and an unknown runner region', async () => {
		const candidateBytes = await readFile(join(candidateRoot, 'release-candidate.json'));
		const evidenceRoot = join(candidateRoot, 'rejected-lane-identities');
		await writeGateEvidence(evidenceRoot, sha256(candidateBytes));
		const acceptancePath = join(evidenceRoot, 'acceptance-stack.json');
		const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8')) as {
			identities: { images: string[] };
		};
		// The 2.32.7 digest the acceptance stack was pinned to before ADR 0033 moved to 2.34.5.
		// A superseded pin must be rejected as hard as any unrelated image.
		acceptance.identities.images = [
			'docker.n8n.io/n8nio/n8n@sha256:882b126a8ddd0646e7d17ec47630e7704615e4647f3363471859fddc3f8946e2',
		];
		await writeFile(acceptancePath, `${JSON.stringify(acceptance)}\n`);

		const finalize = async () =>
			await execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'finalize-evidence',
					join(candidateRoot, 'release-candidate.json'),
					evidenceRoot,
					join(candidateRoot, 'release-evidence-0.2.1.json'),
				],
				{ cwd: repositoryRoot },
			);
		await expect(finalize()).rejects.toMatchObject({
			stderr: expect.stringContaining(
				'acceptance-stack evidence has the wrong official n8n image identity',
			),
		});

		await writeGateEvidence(evidenceRoot, sha256(candidateBytes), {
			'source-delivery': { region: 'unknown' },
		});
		await expect(finalize()).rejects.toMatchObject({
			stderr: expect.stringContaining('source-delivery evidence has no valid time and region'),
		});
	});

	it('blocks bootstrap continuation until token and secret retirement are proven', async () => {
		const candidatePath = join(candidateRoot, 'release-candidate.json');
		const candidateBytes = await readFile(candidatePath);
		const retirementPath = join(candidateRoot, 'bootstrap-token-retirement.json');
		const evidence = {
			schemaVersion: 1,
			candidateSha256: sha256(candidateBytes),
			completedAt: '2026-07-29T08:00:00.000Z',
			actor: 'release-operator',
			bypassTwoFactorAuthentication: true,
			environment: 'npm-bootstrap',
			tokenRevoked: true,
			tokenCreatedAt: '2026-07-29T07:00:00.000Z',
			tokenExpiresAt: '2026-07-30T07:00:00.000Z',
			tokenName: 'n8n-nodes-yt-dlp-bootstrap-0.2.0',
			tokenType: 'granular',
			environmentSecretDeleted: true,
			organizationPermissions: 'no-access',
			packageAccess: 'all-packages',
			packagePermissions: 'read-write',
			secretName: 'NPM_BOOTSTRAP_TOKEN',
			verificationMethod: 'operator-ui-read-back',
			waived: false,
		};
		await writeFile(retirementPath, `${JSON.stringify(evidence)}\n`);
		await expect(
			execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'verify-bootstrap-retirement',
					candidatePath,
					retirementPath,
				],
				{ cwd: repositoryRoot },
			),
		).resolves.toMatchObject({
			stdout: expect.stringContaining('"outcome":"pass"'),
		});

		await writeFile(
			retirementPath,
			`${JSON.stringify({ ...evidence, environmentSecretDeleted: false })}\n`,
		);
		await expect(
			execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'verify-bootstrap-retirement',
					candidatePath,
					retirementPath,
				],
				{ cwd: repositoryRoot },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining('Bootstrap retirement must prove token revocation'),
		});

		await writeFile(
			retirementPath,
			`${JSON.stringify({ ...evidence, packagePermissions: 'read-only' })}\n`,
		);
		await expect(
			execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'verify-bootstrap-retirement',
					candidatePath,
					retirementPath,
				],
				{ cwd: repositoryRoot },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining('Bootstrap retirement must prove token revocation'),
		});
	});

	it('rejects a candidate whose tarball bytes changed', async () => {
		const tarballPath = join(candidateRoot, 'tarballs', manifest.packages[0].tarball);
		const backupPath = `${tarballPath}.backup`;
		await rename(tarballPath, backupPath);
		try {
			await writeFile(tarballPath, 'modified candidate bytes');
			await expect(
				execFileAsync(
					process.execPath,
					['scripts/release-candidate.mjs', 'verify', candidateRoot],
					{ cwd: repositoryRoot },
				),
			).rejects.toMatchObject({
				stderr: expect.stringContaining(`${manifest.packages[0].name} tarball digest mismatch`),
			});
		} finally {
			await rm(tarballPath, { force: true });
			await rename(backupPath, tarballPath);
		}
	});

	// One scenario per test, sharing one fixture registry. Every verifyRegistry invocation re-hashes
	// and re-extracts the whole local chain, so a scenario costs ~11s and the happy path that also
	// materializes costs double. Collapsing these back into one `it` is what timed out in #51: the
	// combined budget landed at 118.2s against 120s and tipped over under full-suite load.
	describe('registry read-back', () => {
		let attestationRequests = 0;
		let includeFiles = true;
		let latestVersion: string | undefined;
		let nextVersion: string;
		let publishedVersions: string[];
		let provenanceCommit: string;
		let registry: string;
		let server: Server;

		const handle: RequestListener = (request, response) => {
			const url = new URL(request.url ?? '/', 'http://registry');
			const tarball = manifest.packages.find(
				(packageEvidence) => url.pathname === `/tarballs/${packageEvidence.tarball}`,
			);
			if (tarball !== undefined) {
				void readFile(join(candidateRoot, 'tarballs', tarball.tarball)).then((contents) => {
					response.end(contents);
				});
				return;
			}
			if (url.pathname.startsWith('/attestations/')) {
				attestationRequests += 1;
				const name = decodeURIComponent(url.pathname.slice('/attestations/'.length));
				const packageEvidence = manifest.packages.find(
					(candidatePackage) => candidatePackage.name === name,
				);
				if (packageEvidence === undefined) {
					response.statusCode = 404;
					response.end();
					return;
				}
				const statement = {
					_type: 'https://in-toto.io/Statement/v1',
					subject: [
						{
							name: packageEvidence.tarball,
							digest: { sha256: packageEvidence.sha256 },
						},
					],
					predicateType: 'https://slsa.dev/provenance/v1',
					predicate: {
						buildDefinition: {
							buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
							externalParameters: {
								workflow: {
									path: '.github/workflows/publish.yml',
									repository: 'https://github.com/aliyusufergin/n8n-nodes-yt-dlp',
								},
							},
							resolvedDependencies: [{ digest: { gitCommit: provenanceCommit } }],
						},
						runDetails: {
							builder: {
								id: 'https://github.com/actions/runner/github-hosted',
							},
						},
					},
				};
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						attestations: [
							{
								predicateType: statement.predicateType,
								bundle: {
									dsseEnvelope: {
										payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
										payloadType: 'application/vnd.in-toto+json',
										signatures: [{ sig: 'test-signature' }],
									},
								},
							},
						],
					}),
				);
				return;
			}
			const [, encodedName, version] = url.pathname.split('/');
			const name = decodeURIComponent(encodedName ?? '');
			const expected = manifest.expectedRegistry.packages[name];
			if (expected === undefined) {
				response.statusCode = 404;
				response.end();
				return;
			}
			if (version === undefined) {
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						'dist-tags': {
							...(latestVersion === undefined ? {} : { latest: latestVersion }),
							next: nextVersion,
						},
						versions: Object.fromEntries(
							publishedVersions.map((publishedVersion) => [publishedVersion, {}]),
						),
					}),
				);
				return;
			}
			if (version !== expected.version) {
				response.statusCode = 404;
				response.end();
				return;
			}
			const registryMetadata: Record<string, unknown> = {
				...expected,
				name,
				version,
				dist: {
					attestations: {
						provenance: {
							predicateType: 'https://slsa.dev/provenance/v1',
						},
						url: `${registry}/attestations/${name}`,
					},
					integrity: expected.integrity,
					tarball: `${registry}/tarballs/${expected.tarball}`,
				},
			};
			if (!includeFiles) delete registryMetadata.files;
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify(registryMetadata));
		};

		beforeAll(async () => {
			server = createServer(handle);
			await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
			registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});

		afterAll(async () => {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
			});
		});

		beforeEach(() => {
			attestationRequests = 0;
			includeFiles = true;
			latestVersion = undefined;
			nextVersion = manifest.version;
			publishedVersions = [manifest.version];
			provenanceCommit = manifest.commit;
		});

		const verifyWithTestSignature = async (
			allowInitialLatest = false,
			materializeDirectory?: string,
		) =>
			await execFileAsync(
				process.execPath,
				[
					'--input-type=module',
					'--eval',
					`
							import { verifyRegistry } from './scripts/release-candidate.mjs';
							const [candidateRoot, registry, outputPath] = process.argv.slice(1);
							await verifyRegistry(candidateRoot, registry, outputPath, {
								allowInitialLatest:
									process.env.ALLOW_INITIAL_LATEST === 'true',
								materializeDirectory:
									process.env.MATERIALIZE_DIRECTORY || undefined,
								verifyBundle: async (bundle, identity) => {
									if (
										bundle?.dsseEnvelope?.signatures?.length !== 1 ||
										identity?.certificateIssuer !==
											'https://token.actions.githubusercontent.com' ||
										!identity?.certificateIdentityURI?.endsWith(
											'/.github/workflows/publish.yml@refs/heads/main',
										)
									) {
										throw new Error('missing test signature');
									}
								},
							});
						`,
					candidateRoot,
					registry,
					join(candidateRoot, 'registry-readback.json'),
				],
				{
					cwd: repositoryRoot,
					env: {
						...process.env,
						ALLOW_INITIAL_LATEST: String(allowInitialLatest),
						MATERIALIZE_DIRECTORY: materializeDirectory ?? '',
						RUNNER_REGION: 'test-region',
					},
				},
			);
		const verifyProvenanceWithTestSignature = async () =>
			await execFileAsync(
				process.execPath,
				[
					'--input-type=module',
					'--eval',
					`
							import { readFile } from 'node:fs/promises';
							import { verifyRegistryProvenance } from './scripts/release-candidate.mjs';
							const [candidatePath, provenanceUrl] = process.argv.slice(1);
							const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
							await verifyRegistryProvenance(
								provenanceUrl,
								candidate.packages[0],
								candidate,
								async (bundle, identity) => {
									if (
										bundle?.dsseEnvelope?.signatures?.length !== 1 ||
										identity?.certificateIssuer !==
											'https://token.actions.githubusercontent.com'
									) {
										throw new Error('missing test signature');
									}
								},
							);
						`,
					join(candidateRoot, 'release-candidate.json'),
					`${registry}/attestations/${manifest.packages[0].name}`,
				],
				{ cwd: repositoryRoot },
			);
		it('matches registry metadata, provenance, and tarball bytes on read-back', async () => {
			await verifyWithTestSignature();
			const readback = JSON.parse(
				await readFile(join(candidateRoot, 'registry-readback.json'), 'utf8'),
			) as { packages: Array<{ name: string; provenance: string; sha256: string }> };
			expect(readback.packages).toEqual(
				manifest.packages.map(({ name, sha256: packageSha256 }) => ({
					name,
					provenance: 'https://slsa.dev/provenance/v1',
					sha256: packageSha256,
				})),
			);
			expect(attestationRequests).toBe(3);
		}, 60_000);

		it('materializes the published chain from the registry bytes it read back', async () => {
			const materializedRoot = join(candidateRoot, 'published-candidate');
			await verifyWithTestSignature(false, materializedRoot);
			for (const packageEvidence of manifest.packages) {
				const materialized = await readFile(
					join(materializedRoot, 'tarballs', packageEvidence.tarball),
				);
				expect(sha256(materialized)).toBe(packageEvidence.sha256);
				expect(materialized.byteLength).toBe(packageEvidence.sizeBytes);
			}
			await expect(
				readFile(join(materializedRoot, 'registry-readback.json'), 'utf8').then(JSON.parse),
			).resolves.toMatchObject({
				candidateSha256: sha256(await readFile(join(candidateRoot, 'release-candidate.json'))),
				lane: 'registry-readback',
				outcome: 'pass',
				registry,
			});
		}, 60_000);

		it('reads back registry metadata that omits the files field', async () => {
			includeFiles = false;
			await verifyWithTestSignature();
		}, 60_000);

		it('rejects dist-tags that do not stage the candidate under next alone', async () => {
			// A version this package will never publish, so the mismatch survives a release bump.
			nextVersion = '9.9.9';
			await expect(verifyWithTestSignature()).rejects.toMatchObject({
				stderr: expect.stringContaining('next does not identify 0.2.1'),
			});
			nextVersion = manifest.version;
			latestVersion = manifest.version;
			// An earlier published version is what makes this a promotion rather than npm's forced
			// tag on a first publication, which a read-back is required to accept.
			publishedVersions = ['0.1.0', manifest.version];
			await expect(verifyWithTestSignature()).rejects.toMatchObject({
				stderr: expect.stringContaining('latest unexpectedly identifies 0.2.1'),
			});
		}, 60_000);

		it('accepts only an exact initial publication as a bootstrap latest', async () => {
			latestVersion = manifest.version;
			await verifyWithTestSignature(true);
		}, 60_000);

		it('rejects every bootstrap registry state that is not an exact initial publication', async () => {
			// The table is built inside the test because `manifest` is only read back in beforeAll.
			const states: Array<[string, string | undefined, string[]]> = [
				['no latest tag', undefined, [manifest.version]],
				['a latest tag on another version', '0.1.0', [manifest.version]],
				['an earlier published version', manifest.version, ['0.1.0', manifest.version]],
				['both a foreign latest and an earlier version', '0.1.0', ['0.1.0', manifest.version]],
			];
			for (const [state, latest, published] of states) {
				latestVersion = latest;
				publishedVersions = published;
				await expect(verifyWithTestSignature(true), state).rejects.toMatchObject({
					stderr: expect.stringContaining(
						'bootstrap registry state is not an exact initial publication',
					),
				});
			}
		}, 60_000);

		// Only the bootstrap accepts npm's automatic first-publish `latest`. Every release after it
		// leaves `latest` on the previous version, so `materialize-registry` must refuse a candidate
		// that `latest` already names unless it is told this is the bootstrap. The gate that decides
		// that runs before the chain is re-hashed, so this reaches it without a real signature.
		let materializeCount = 0;
		const materializeRegistry = async () => {
			const label = `materialized-${(materializeCount += 1)}`;
			return await execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'materialize-registry',
					candidateRoot,
					registry,
					join(candidateRoot, label),
					join(candidateRoot, `${label}.json`),
				],
				{ cwd: repositoryRoot, env: { ...process.env, RUNNER_REGION: 'test-region' } },
			);
		};

		it('refuses a candidate that latest identifies alongside an earlier release', async () => {
			latestVersion = manifest.version;
			publishedVersions = ['0.1.0', manifest.version];

			await expect(materializeRegistry()).rejects.toMatchObject({
				stderr: expect.stringContaining(`latest unexpectedly identifies ${manifest.version}`),
			});
		}, 60_000);

		// The two states below are the ones a read-back must accept, and they are asserted by the
		// error they reach rather than by the absence of one: a negative match would also pass for
		// the dist-tag rejection this pair exists to rule out.
		it("accepts npm's forced latest on a first publication", async () => {
			latestVersion = manifest.version;
			publishedVersions = [manifest.version];

			await expect(materializeRegistry()).rejects.toMatchObject({
				stderr: expect.stringContaining(DIST_TAG_GATE_PASSED),
			});
		}, 60_000);

		it('accepts the state a release after the first publication leaves behind', async () => {
			latestVersion = '0.1.0';
			publishedVersions = ['0.1.0', manifest.version];

			await expect(materializeRegistry()).rejects.toMatchObject({
				stderr: expect.stringContaining(DIST_TAG_GATE_PASSED),
			});
		}, 60_000);

		it('rejects registry provenance that is not candidate-bound', async () => {
			provenanceCommit = '0'.repeat(40);
			await expect(verifyProvenanceWithTestSignature()).rejects.toMatchObject({
				stderr: expect.stringContaining('registry provenance is not candidate-bound'),
			});
		}, 60_000);

		it('rejects an incomplete Sigstore bundle', async () => {
			await expect(
				execFileAsync(
					process.execPath,
					[
						'--input-type=module',
						'--eval',
						`
							import { verifySigstoreBundle } from './scripts/release-candidate.mjs';
							await verifySigstoreBundle({
								dsseEnvelope: {
									payload: 'e30=',
									payloadType: 'application/vnd.in-toto+json',
									signatures: [{ sig: 'not-a-signature' }],
								},
							});
						`,
					],
					{
						cwd: repositoryRoot,
					},
				),
			).rejects.toMatchObject({
				stderr: expect.stringContaining('The Sigstore bundle is incomplete'),
			});
		}, 60_000);
	});

	it('reports exact package names after a partial publication', async () => {
		const publishedName = manifest.packages[0].name;
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://registry');
			const [, encodedName, version] = url.pathname.split('/');
			const name = decodeURIComponent(encodedName ?? '');
			response.statusCode =
				name === publishedName && version === manifest.version ? 200 : 404;
			response.end();
		});
		await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
		try {
			const address = server.address() as AddressInfo;
			const outputPath = join(candidateRoot, 'partial-publish-audit.json');
			await execFileAsync(
				process.execPath,
				[
					'scripts/release-candidate.mjs',
					'audit-registry',
					join(candidateRoot, 'release-candidate.json'),
					`http://127.0.0.1:${address.port}`,
					outputPath,
				],
				{ cwd: repositoryRoot },
			);
			const audit = JSON.parse(await readFile(outputPath, 'utf8')) as {
				missing: string[];
				published: string[];
				unexpected: Array<{ name: string; status: number }>;
			};
			expect(audit).toMatchObject({
				published: [publishedName],
				missing: manifest.packages.slice(1).map(({ name }) => name),
				unexpected: [],
			});
		} finally {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
			});
		}
	});
});
