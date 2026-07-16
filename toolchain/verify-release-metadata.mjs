import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const rootDirectory = resolve(import.meta.dirname, "..");

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(resolve(rootDirectory, relativePath), "utf8"),
  );
}

const rootPackage = await readJson("package.json");
const nodePackage = await readJson("packages/node/package.json");
const sourceLock = await readJson("toolchain/corresponding-source-lock.json");
const platformDirectories = [
  "packages/platform-linux-x64",
  "packages/platform-linux-arm64",
];

if (nodePackage.version !== rootPackage.version) {
  throw new Error("Root workspace and node package versions do not match");
}
if (
  sourceLock.schemaVersion !== 1 ||
  sourceLock.packageVersion !== rootPackage.version
) {
  throw new Error(
    "Corresponding Source lock and workspace versions do not match",
  );
}

for (const platformDirectory of platformDirectories) {
  const platformPackage = await readJson(`${platformDirectory}/package.json`);
  const manifest = await readJson(
    `${platformDirectory}/toolchain-manifest.json`,
  );
  const sourceOffer = await readFile(
    resolve(rootDirectory, platformDirectory, "SOURCE_OFFER.md"),
    "utf8",
  );
  const expectedDependencyVersion =
    nodePackage.optionalDependencies?.[platformPackage.name];
  const expectedBundleName = `n8n-nodes-ytdlp-${rootPackage.version}-sources.tar.gz`;

  if (
    platformPackage.version !== rootPackage.version ||
    manifest.packageVersion !== rootPackage.version ||
    expectedDependencyVersion !== rootPackage.version
  ) {
    throw new Error(
      `Release versions do not match for ${platformPackage.name}`,
    );
  }
  if (!sourceOffer.includes(`/v${rootPackage.version}/${expectedBundleName}`)) {
    throw new Error(
      `Corresponding Source URL does not match for ${platformPackage.name}`,
    );
  }
}
