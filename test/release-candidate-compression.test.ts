import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { recompressPlatformTarball } from '../scripts/release-candidate.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
	);
});

describe('release candidate compression', () => {
	it('recompresses identical tar bytes reproducibly across temporary roots', async () => {
		const outputs: Buffer[] = [];
		for (let index = 0; index < 2; index += 1) {
			const root = await mkdtemp(join(tmpdir(), 'n8n-yt-dlp-recompress-'));
			temporaryRoots.push(root);
			const tarballPath = join(root, 'platform.tgz');
			await writeFile(tarballPath, gzipSync('identical tar bytes'));
			if (index > 0) await setTimeout(1100);
			await recompressPlatformTarball(tarballPath, root);
			outputs.push(await readFile(tarballPath));
		}

		const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
		expect(sha256(outputs[0])).toBe(sha256(outputs[1]));
	});
});
