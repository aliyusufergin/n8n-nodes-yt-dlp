import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const packageDirectory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  throw new Error('Usage: node toolchain/audit-option-catalog.mjs <package-directory>');
}

const manifest = JSON.parse(
  await readFile(join(packageDirectory, 'toolchain-manifest.json'), 'utf8'),
);
const catalog = JSON.parse(await readFile(resolve('toolchain/option-catalog.json'), 'utf8'));
const ytDlpSource = manifest.sources.find((source) => source.name === 'yt-dlp');
const workspace = await mkdtemp(join(tmpdir(), 'n8n-ytdlp-options-'));

try {
  const executablePath = join(packageDirectory, manifest.paths.ytDlp);
  let inspectedPath = executablePath;
  try {
    await readFile(executablePath);
  } catch {
    const portableUrl = new URL('yt-dlp', new URL('.', ytDlpSource.url)).href;
    const response = await fetch(portableUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Portable yt-dlp download failed: HTTP ${response.status}`);
    }
    inspectedPath = join(workspace, basename(new URL(portableUrl).pathname));
    await writeFile(inspectedPath, Buffer.from(await response.arrayBuffer()), { mode: 0o700 });
    await chmod(inspectedPath, 0o700);
  }

  const inspectionProgram = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from yt_dlp.options import create_parser
parser = create_parser()
options = []
for group in [parser, *parser.option_groups]:
    for option in group.option_list:
        if option.dest == 'help':
            continue
        names = [*option._short_opts, *option._long_opts]
        if names:
            options.append({'names': names, 'arity': option.nargs if option.takes_value() else 0})
print(json.dumps(options))
`;
  const inspection = spawnSync('python3', ['-c', inspectionProgram, inspectedPath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (inspection.status !== 0) {
    throw new Error(`yt-dlp option inspection failed: ${inspection.stderr.trim()}`);
  }

  const upstreamGroups = JSON.parse(inspection.stdout);
  const upstreamOptions = new Map();
  for (const group of upstreamGroups) {
    for (const name of group.names) {
      upstreamOptions.set(name, { arity: group.arity, aliases: group.names });
    }
  }

  if (process.argv.includes('--update-reviewed-2026.07.14.233956')) {
    if (catalog.ytDlpVersion !== '2026.07.14.233956') {
      throw new Error('The reviewed catalog bootstrap is valid only for yt-dlp 2026.07.14.233956');
    }

    const restricted = new Set([
      '-U',
      '-a',
      '-n',
      '--alias',
      '--batch-file',
      '--client-certificate',
      '--client-certificate-key',
      '--client-certificate-password',
      '--config-locations',
      '--cookies-from-browser',
      '--download-archive',
      '--downloader',
      '--downloader-args',
      '--dump-headers',
      '--dump-intermediate-pages',
      '--dump-pages',
      '--enable-file-urls',
      '--exec',
      '--exec-before-download',
      '--extractor-args',
      '--external-downloader',
      '--external-downloader-args',
      '--load-info-json',
      '--load-pages',
      '--netrc',
      '--netrc-cmd',
      '--netrc-location',
      '--plugin-dirs',
      '--postprocessor-args',
      '--ppa',
      '--print-to-file',
      '--print-traffic',
      '--remote-components',
      '--sponskrub-args',
      '--sponskrub-location',
      '--update',
      '--update-to',
      '--use-postprocessor',
      '--write-intermediate-pages',
      '--write-pages',
    ]);
    const nodeControlled = new Set([
      '-P',
      '--cache-dir',
      '--cookies',
      '--ffmpeg-location',
      '--ignore-config',
      '--js-runtimes',
      '--no-config',
      '--no-js-runtimes',
      '--no-plugin-dirs',
      '--no-remote-components',
      '--paths',
    ]);
    const sensitive = new Set([
      '-2',
      '-p',
      '-u',
      '--add-headers',
      '--ap-password',
      '--ap-username',
      '--cn-verification-proxy',
      '--geo-verification-proxy',
      '--password',
      '--proxy',
      '--twofactor',
      '--username',
      '--video-password',
    ]);
    const classificationRank = { pass: 0, restricted: 1, 'node-controlled': 2 };
    const generatedOptions = {};

    for (const group of upstreamGroups) {
      const canonicalName = group.names.find((name) => name.startsWith('--')) ?? group.names[0];
      const existingRules = group.names
        .map((name) => catalog.options[name])
        .filter((rule) => rule !== undefined);
      const strongestExisting = existingRules.sort(
        (left, right) => classificationRank[right.classification] - classificationRank[left.classification],
      )[0];
      const classification = group.names.some((name) => nodeControlled.has(name))
        ? 'node-controlled'
        : group.names.some((name) => restricted.has(name))
          ? 'restricted'
          : strongestExisting?.classification ?? 'pass';
      const inheritedReason = existingRules.find((rule) => rule.reason)?.reason;
      const groupIsSensitive =
        group.names.some((name) => sensitive.has(name)) ||
        existingRules.some((rule) => rule.sensitive === true);
      const valueKind =
        group.names.includes('--output') || group.names.includes('-o')
          ? 'output-template'
          : existingRules.find((rule) => rule.valueKind)?.valueKind;

      for (const name of group.names) {
        generatedOptions[name] = {
          arity: group.arity,
          classification,
          ...(name === canonicalName
            ? { aliases: group.names.filter((alias) => alias !== canonicalName) }
            : { aliasOf: canonicalName }),
          ...(classification === 'restricted' && inheritedReason ? { reason: inheritedReason } : {}),
          ...(groupIsSensitive && classification === 'pass' ? { sensitive: true } : {}),
          ...(valueKind ? { valueKind } : {}),
        };
      }
    }

    for (const [name, rule] of Object.entries(catalog.options)) {
      generatedOptions[name] ??= rule;
    }
    catalog.options = generatedOptions;
    await writeFile(
      resolve('toolchain/option-catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`,
    );
  }

  const missing = [...upstreamOptions]
    .filter(([name]) => catalog.options[name] === undefined)
    .map(([name, details]) => ({ name, ...details }));
  const wrongArity = [...upstreamOptions]
    .filter(([name, details]) => catalog.options[name]?.arity !== details.arity)
    .filter(([name]) => catalog.options[name] !== undefined)
    .map(([name, details]) => ({
      name,
      catalogArity: catalog.options[name].arity,
      upstreamArity: details.arity,
    }));

  if (missing.length > 0 || wrongArity.length > 0) {
    process.stdout.write(`${JSON.stringify({ missing, wrongArity }, null, 2)}\n`);
    process.exitCode = 1;
  }
} finally {
  await rm(workspace, { force: true, recursive: true });
}
