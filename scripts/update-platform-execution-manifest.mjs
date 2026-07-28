import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const packageRoot = resolve(process.argv[2] ?? 'packages/linux-x64');
const manifestPath = join(packageRoot, 'execution-manifest.json');
const previousManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const expectedProbeOutput = new Map(
	previousManifest.files
		.filter((file) => file.probe !== undefined)
		.map((file) => [file.name, file.probe.stdout]),
);
const files = [
	{ name: 'ytDlp', path: 'bin/yt-dlp', probe: ['--version'] },
	{ name: 'ffmpeg', path: 'bin/ffmpeg', probe: ['-version'] },
	{ name: 'ffprobe', path: 'bin/ffprobe', probe: ['-version'] },
	{ name: 'deno', path: 'bin/deno', probe: ['--version'] },
	{ name: 'ytDlpBinary', path: 'bin/yt-dlp.musl' },
	{ name: 'ffmpegBinary', path: 'bin/ffmpeg.gnu' },
	{ name: 'ffprobeBinary', path: 'bin/ffprobe.gnu' },
	{ name: 'denoBinary', path: 'bin/deno.gnu' },
	{
		name: 'muslLoader',
		path: 'runtime/musl/ld-musl-x86_64.so.1',
		executable: true,
	},
	{ name: 'muslZlib', path: 'runtime/musl/libz.so.1' },
	{
		name: 'glibcLoader',
		path: 'runtime/glibc/ld-linux-x86-64.so.2',
		executable: true,
	},
	{ name: 'glibc', path: 'runtime/glibc/libc.so.6' },
	{ name: 'glibcDl', path: 'runtime/glibc/libdl.so.2' },
	{ name: 'gccRuntime', path: 'runtime/glibc/libgcc_s.so.1' },
	{ name: 'glibcMath', path: 'runtime/glibc/libm.so.6' },
	{ name: 'glibcVectorMath', path: 'runtime/glibc/libmvec.so.1' },
	{ name: 'glibcDns', path: 'runtime/glibc/libnss_dns.so.2' },
	{ name: 'glibcFiles', path: 'runtime/glibc/libnss_files.so.2' },
	{ name: 'glibcThreads', path: 'runtime/glibc/libpthread.so.0' },
	{ name: 'glibcResolver', path: 'runtime/glibc/libresolv.so.2' },
	{ name: 'glibcRealtime', path: 'runtime/glibc/librt.so.1' },
	{ name: 'zlib', path: 'runtime/glibc/libz.so.1' },
	{ name: 'ejsCore', path: 'assets/ejs/yt.solver.core.js' },
	{ name: 'ejsLib', path: 'assets/ejs/yt.solver.lib.js' },
];

const manifestFiles = [];
for (const file of files) {
	const absolutePath = join(packageRoot, file.path);
	const executable = file.executable ?? file.path.startsWith('bin/');
	await chmod(absolutePath, executable ? 0o755 : 0o644);
	const [contents, stat] = await Promise.all([readFile(absolutePath), lstat(absolutePath)]);
	const probeStdout = expectedProbeOutput.get(file.name);
	if (file.probe !== undefined && typeof probeStdout !== 'string') {
		throw new Error(`Missing frozen probe output for ${file.name}.`);
	}
	const entry = {
		mode: {
			executable,
			groupWritable: false,
			worldWritable: false,
		},
		name: file.name,
		path: file.path,
		...(file.probe === undefined
			? {}
			: {
					probe: {
						args: file.probe,
						stdout: probeStdout,
					},
				}),
		sha256: createHash('sha256').update(contents).digest('hex'),
		size: stat.size,
	};
	manifestFiles.push(entry);
}

const manifestContents = `${JSON.stringify(
	{
		files: manifestFiles,
		packageName: 'n8n-nodes-yt-dlp-linux-x64',
		packageVersion: '0.2.0',
		schemaVersion: 1,
	},
	null,
	2,
)}\n`;
await writeFile(manifestPath, manifestContents);
process.stdout.write(`${createHash('sha256').update(manifestContents).digest('hex')}\n`);
