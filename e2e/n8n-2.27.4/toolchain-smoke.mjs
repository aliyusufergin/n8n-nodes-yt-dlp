import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.argv[2] ?? '.');
const generatedRoot = resolve(
	process.argv[3] ?? join(repositoryRoot, 'e2e/n8n-2.27.4/.generated'),
);
const tarballRoot = join(generatedRoot, 'registry/tarballs');
const image =
	'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1';

const script = `
	set -eu
	mkdir /tmp/toolchain-smoke
	cd /tmp/toolchain-smoke
	npm init -y >/dev/null
	npm install \
		/tarballs/n8n-nodes-yt-dlp-linux-x64-0.2.0.tgz \
		/tarballs/n8n-nodes-yt-dlp-platform-0.2.0.tgz \
		--ignore-scripts \
		--no-audit \
		--no-fund \
		--legacy-peer-deps >/dev/null
	node -e "
		require('n8n-nodes-yt-dlp-platform').getVerifiedToolchain().then(
			(toolchain) => process.stdout.write(JSON.stringify(Object.keys(toolchain).sort())),
			(error) => {
				process.stderr.write(error.name + ': ' + error.message + '\\n');
				process.exitCode = 1;
			},
		);
	"
`;

const { stdout } = await execFileAsync(
	'docker',
	[
		'run',
		'--rm',
		'--user',
		'root',
		'--entrypoint',
		'/bin/sh',
		'--volume',
		`${tarballRoot}:/tarballs:ro`,
		image,
		'-c',
		script,
	],
	{
		cwd: repositoryRoot,
		env: {
			...process.env,
			DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
		},
		maxBuffer: 4 * 1024 * 1024,
		timeout: 60_000,
	},
);

const names = JSON.parse(stdout.trim());
const expected = ['deno', 'ejsCore', 'ejsLib', 'ffmpeg', 'ffprobe', 'ytDlp'];
if (JSON.stringify(names) !== JSON.stringify(expected)) {
	throw new Error(`Unexpected verified toolchain keys: ${JSON.stringify(names)}`);
}
