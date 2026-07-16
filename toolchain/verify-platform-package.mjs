import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageDirectory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  throw new Error('Usage: node toolchain/verify-platform-package.mjs <package-directory>');
}

const packageJson = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
const manifest = JSON.parse(
  await readFile(resolve(packageDirectory, 'toolchain-manifest.json'), 'utf8'),
);
const optionCatalog = JSON.parse(
  await readFile(resolve(packageDirectory, manifest.optionCatalogPath), 'utf8'),
);

if (manifest.packageVersion !== packageJson.version) {
  throw new Error('Platform package and manifest versions do not match');
}
if (optionCatalog.ytDlpVersion !== manifest.versions.ytDlp) {
  throw new Error('Option catalog and yt-dlp versions do not match');
}

await Promise.all([
  access(resolve(packageDirectory, 'LICENSE'), constants.R_OK),
  access(resolve(packageDirectory, 'SOURCE_OFFER.md'), constants.R_OK),
  access(resolve(packageDirectory, 'THIRD_PARTY_NOTICES.md'), constants.R_OK),
  access(resolve(packageDirectory, manifest.paths.ytDlp), constants.X_OK),
  access(resolve(packageDirectory, manifest.paths.ffmpeg), constants.X_OK),
  access(resolve(packageDirectory, manifest.paths.ffprobe), constants.X_OK),
  access(resolve(packageDirectory, manifest.paths.node), constants.X_OK),
  access(resolve(packageDirectory, manifest.paths.ejs), constants.R_OK),
  access(resolve(packageDirectory, 'vendor/licenses/ejs-LICENSE'), constants.R_OK),
  access(resolve(packageDirectory, 'vendor/licenses/node-LICENSE'), constants.R_OK),
]);
