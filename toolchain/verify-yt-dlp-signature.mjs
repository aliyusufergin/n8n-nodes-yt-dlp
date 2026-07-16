import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Signed checksum download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

function runGpg(homeDirectory, argumentsList) {
  const result = spawnSync('gpg', ['--batch', '--homedir', homeDirectory, ...argumentsList], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`GPG verification failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function verifyYtDlpSignedChecksum(source, workspace, repositoryRoot) {
  const signature = source.signature;
  if (!signature) {
    throw new Error('yt-dlp source is missing signed-checksum metadata');
  }

  const checksumPath = join(workspace, 'SHA2-256SUMS');
  const signaturePath = join(workspace, 'SHA2-256SUMS.sig');
  const gpgHome = join(workspace, 'gnupg');
  await mkdir(gpgHome, { mode: 0o700 });
  await Promise.all([
    downloadFile(signature.checksumsUrl, checksumPath),
    downloadFile(signature.signatureUrl, signaturePath),
  ]);

  const publicKeyPath = resolve(repositoryRoot, signature.publicKeyPath);
  runGpg(gpgHome, ['--import', publicKeyPath]);
  const fingerprintOutput = runGpg(gpgHome, ['--with-colons', '--fingerprint']);
  const fingerprints = fingerprintOutput
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('fpr:'))
    .map((line) => line.split(':')[9]);
  if (!fingerprints.includes(signature.fingerprint)) {
    throw new Error('The imported yt-dlp signing-key fingerprint does not match the manifest');
  }

  runGpg(gpgHome, ['--verify', signaturePath, checksumPath]);
  const assetName = basename(new URL(source.url).pathname);
  const signedDigest = (await readFile(checksumPath, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.match(/^([0-9a-f]{64})\s+\*?(.+)$/u))
    .find((match) => match?.[2] === assetName)?.[1];
  if (signedDigest === undefined || signedDigest !== source.sha256) {
    throw new Error(`Signed checksum mismatch for ${assetName}`);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const packageDirectory = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) {
    throw new Error('Usage: node toolchain/verify-yt-dlp-signature.mjs <package-directory>');
  }

  const repositoryRoot = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, 'toolchain-manifest.json'), 'utf8'),
  );
  const source = manifest.sources.find((candidate) => candidate.name === 'yt-dlp');
  const workspace = await mkdtemp(join(tmpdir(), 'n8n-ytdlp-signature-'));
  try {
    await verifyYtDlpSignedChecksum(source, workspace, repositoryRoot);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}
