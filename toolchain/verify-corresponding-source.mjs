import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectSourceRecipe } from "./source-recipe.mjs";

const execFileAsync = promisify(execFile);

function safeRelativePath(value) {
  const normalized = normalize(value);

  if (
    !value ||
    isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }

  return normalized;
}

async function fileHash(path, algorithm) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function sha256(path) {
  return fileHash(path, "sha256");
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relativePath(root, path));
    else
      throw new Error(
        `Unsupported file type in bundle: ${relativePath(root, path)}`,
      );
  }
  return files;
}

export function expectedInventoryFromLock(lock) {
  return {
    "alpine-aports-recipes": ["alpine-aports-selected"],
    "alpine-distfile": lock.expectedInventory.alpineDistfiles,
    "build-recipe": ["wader-static-ffmpeg"],
    "cargo-vendor": ["librsvg-cargo-vendor", "rav1e-cargo-vendor"],
    documentation: [
      "bundle-readme",
      "offline-rebuild",
      "provenance-limitations",
    ],
    "git-snapshot": [
      ...lock.reviewedGitSources.map((source) => source.name),
      ...lock.supplementalGitSources.map((source) => source.name),
      ...lock.topLevelSources.map((source) => source.name),
    ],
    license: ["GPL-3.0.txt", "THIRD_PARTY_NOTICES.md"],
    "packaging-recipe": ["n8n-nodes-ytdlp-package-recipe"],
    "provenance-evidence": [
      "alpine-packages-amd64",
      "alpine-packages-arm64",
      "original-build-run",
    ],
    "supplemental-archive": lock.supplementalArchives.map(
      (source) => source.name,
    ),
    "verification-tool": [
      "corresponding-source-lock",
      "source-bundle-verifier",
      "source-recipe-auditor",
    ],
    "wader-archive": lock.expectedInventory.waderArchives,
  };
}

function requireEntry(manifest, kind, name) {
  const entry = manifest.entries.find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );
  if (!entry) throw new Error(`Missing locked ${kind} entry: ${name}`);
  return entry;
}

function verifyEntryMetadata(entry, expected) {
  for (const [field, value] of Object.entries(expected)) {
    if (entry[field] !== value) {
      throw new Error(
        `Locked metadata mismatch for ${entry.name}.${field}: expected ${value}, got ${entry[field]}`,
      );
    }
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findNamedFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findNamedFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

async function validateCargoVendorArchive(
  root,
  manifest,
  sourceName,
  vendorName,
) {
  const sourceEntry = requireEntry(manifest, "wader-archive", sourceName);
  const vendorEntry = requireEntry(manifest, "cargo-vendor", vendorName);
  const sourceDirectory = await mkdtemp(join(tmpdir(), "verify-cargo-source-"));
  const vendorDirectory = await mkdtemp(join(tmpdir(), "verify-cargo-vendor-"));
  try {
    await execFileAsync("tar", [
      "-xf",
      join(root, safeRelativePath(sourceEntry.archivePath)),
      "-C",
      sourceDirectory,
    ]);
    await execFileAsync("tar", [
      "-xzf",
      join(root, safeRelativePath(vendorEntry.archivePath)),
      "-C",
      vendorDirectory,
    ]);
    const cargoLock = await findNamedFile(sourceDirectory, "Cargo.lock");
    if (!cargoLock)
      throw new Error(`${sourceName} source is missing Cargo.lock`);
    const expectedPackageChecksums = new Set(
      [
        ...(await readFile(cargoLock, "utf8")).matchAll(
          /checksum = "([a-f0-9]{64})"/gu,
        ),
      ].map((match) => match[1]),
    );
    const actualPackageChecksums = new Set();
    for (const entry of await readdir(join(vendorDirectory, "vendor"), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(vendorDirectory, "vendor", entry.name);
      const checksum = JSON.parse(
        await readFile(join(packageRoot, ".cargo-checksum.json"), "utf8"),
      );
      if (checksum.package) actualPackageChecksums.add(checksum.package);
      for (const [path, expected] of Object.entries(checksum.files)) {
        const actual = await sha256(join(packageRoot, path));
        if (actual !== expected) {
          throw new Error(
            `Cargo vendor checksum mismatch for ${vendorName}/${entry.name}/${path}`,
          );
        }
      }
    }
    if (
      expectedPackageChecksums.size !== actualPackageChecksums.size ||
      [...expectedPackageChecksums].some(
        (checksum) => !actualPackageChecksums.has(checksum),
      )
    ) {
      throw new Error(
        `${vendorName} package checksums do not match Cargo.lock`,
      );
    }
  } finally {
    await rm(sourceDirectory, { force: true, recursive: true });
    await rm(vendorDirectory, { force: true, recursive: true });
  }
}

async function validateLockedSources(root, manifest, lock) {
  verifyEntryMetadata(
    requireEntry(manifest, "build-recipe", "wader-static-ffmpeg"),
    {
      origin: lock.wader.repository,
      versionOrCommit: lock.wader.commit,
    },
  );
  verifyEntryMetadata(
    requireEntry(manifest, "alpine-aports-recipes", "alpine-aports-selected"),
    {
      origin: lock.alpine.aportsRepository,
      versionOrCommit: lock.alpine.aportsCommit,
    },
  );
  for (const source of lock.reviewedGitSources) {
    verifyEntryMetadata(requireEntry(manifest, "git-snapshot", source.name), {
      origin: source.url,
      versionOrCommit: source.commit,
    });
  }
  for (const source of [
    ...lock.supplementalGitSources,
    ...lock.topLevelSources,
  ]) {
    verifyEntryMetadata(requireEntry(manifest, "git-snapshot", source.name), {
      origin: source.repository,
      versionOrCommit: source.commit,
    });
  }
  for (const source of lock.supplementalArchives) {
    verifyEntryMetadata(
      requireEntry(manifest, "supplemental-archive", source.name),
      {
        origin: source.url,
        sha256: source.sha256,
        versionOrCommit: source.version,
      },
    );
  }

  const waderEntry = requireEntry(
    manifest,
    "build-recipe",
    "wader-static-ffmpeg",
  );
  const waderDirectory = await mkdtemp(join(tmpdir(), "verify-wader-recipe-"));
  try {
    await execFileAsync("tar", [
      "-xzf",
      join(root, safeRelativePath(waderEntry.archivePath)),
      "-C",
      waderDirectory,
    ]);
    const dockerfile = await readFile(
      join(waderDirectory, "Dockerfile"),
      "utf8",
    );
    const recipe = inspectSourceRecipe(dockerfile, lock.reviewedGitSources);
    for (const source of recipe.archives) {
      verifyEntryMetadata(
        requireEntry(manifest, "wader-archive", source.name),
        {
          origin: source.url,
          sha256: source.sha256,
          versionOrCommit: source.version,
        },
      );
    }
    for (const [name, sourceName] of [
      ["librsvg-cargo-vendor", "LIBRSVG"],
      ["rav1e-cargo-vendor", "RAV1E"],
    ]) {
      const version = recipe.archives.find(
        (source) => source.name === sourceName,
      )?.version;
      verifyEntryMetadata(requireEntry(manifest, "cargo-vendor", name), {
        versionOrCommit: version,
      });
    }
  } finally {
    await rm(waderDirectory, { force: true, recursive: true });
  }
  await validateCargoVendorArchive(
    root,
    manifest,
    "LIBRSVG",
    "librsvg-cargo-vendor",
  );
  await validateCargoVendorArchive(
    root,
    manifest,
    "RAV1E",
    "rav1e-cargo-vendor",
  );

  const aportsEntry = requireEntry(
    manifest,
    "alpine-aports-recipes",
    "alpine-aports-selected",
  );
  const aportsDirectory = await mkdtemp(
    join(tmpdir(), "verify-aports-recipe-"),
  );
  try {
    await execFileAsync("tar", [
      "-xzf",
      join(root, safeRelativePath(aportsEntry.archivePath)),
      "-C",
      aportsDirectory,
    ]);
    const checksums = new Map();
    for (const packageDirectory of lock.alpine.packageDirectories) {
      const packageRoot = join(aportsDirectory, packageDirectory);
      const apkbuild = await readFile(join(packageRoot, "APKBUILD"), "utf8");
      for (const match of apkbuild.matchAll(/([a-f0-9]{128})  ([^"\n]+)/gu)) {
        const filename = match[2].trim();
        if (!(await pathExists(join(packageRoot, filename)))) {
          checksums.set(filename, match[1]);
        }
      }
    }
    for (const filename of lock.expectedInventory.alpineDistfiles) {
      const expected = checksums.get(filename);
      if (!expected)
        throw new Error(`Missing locked Alpine checksum for ${filename}`);
      const entry = requireEntry(manifest, "alpine-distfile", filename);
      const fallback = lock.alpine.fallbackArchives?.find(
        (source) => source.filename === filename,
      );
      verifyEntryMetadata(entry, {
        origin:
          fallback?.url ??
          `${lock.alpine.distfilesBaseUrl}/${encodeURIComponent(filename)}`,
        ...(fallback ? { sha256: fallback.sha256 } : {}),
        versionOrCommit: lock.alpine.aportsCommit,
      });
      const actual = await fileHash(
        join(root, safeRelativePath(entry.archivePath)),
        "sha512",
      );
      if (actual !== expected) {
        throw new Error(`Alpine SHA-512 mismatch for ${filename}`);
      }
    }
  } finally {
    await rm(aportsDirectory, { force: true, recursive: true });
  }
}

function relativePath(root, path) {
  return path
    .slice(root.length + 1)
    .split(sep)
    .join("/");
}

export async function verifyBundleDirectory(
  rootDirectory,
  expectedVersion,
  expectedInventory,
) {
  const root = resolve(rootDirectory);
  const manifest = JSON.parse(
    await readFile(join(root, "bundle.json"), "utf8"),
  );
  const checksumText = await readFile(join(root, "SHA256SUMS"), "utf8");

  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error("Unsupported Corresponding Source manifest schema");
  }
  if (expectedVersion && manifest.packageVersion !== expectedVersion) {
    throw new Error(
      `Bundle version ${manifest.packageVersion} does not match expected ${expectedVersion}`,
    );
  }

  const checksums = new Map();
  for (const line of checksumText.trim().split("\n")) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const path = safeRelativePath(match[2]);
    if (checksums.has(path))
      throw new Error(`Duplicate SHA256SUMS path: ${path}`);
    checksums.set(path, match[1]);
  }

  for (const entry of manifest.entries) {
    for (const field of ["name", "kind", "origin", "versionOrCommit"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(
          `Bundle entry ${entry.name ?? "<unnamed>"} requires ${field}`,
        );
      }
    }
    const path = safeRelativePath(entry.archivePath);
    const expected = checksums.get(path);
    if (!expected || expected !== entry.sha256) {
      throw new Error(`Manifest and SHA256SUMS disagree for ${path}`);
    }

    const actual = await sha256(join(root, path));
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${path}`);
  }

  if (checksums.size !== manifest.entries.length) {
    throw new Error("SHA256SUMS contains files absent from bundle.json");
  }

  const physicalFiles = (await listFiles(root)).filter(
    (path) => path !== "bundle.json" && path !== "SHA256SUMS",
  );
  const unlisted = physicalFiles.find((path) => !checksums.has(path));
  if (unlisted) throw new Error(`${unlisted} is absent from bundle.json`);
  if (physicalFiles.length !== checksums.size) {
    throw new Error("bundle.json refers to a file absent from the bundle");
  }
  if (expectedInventory?.sourceLock) {
    await validateLockedSources(root, manifest, expectedInventory.sourceLock);
  }
  if (expectedInventory) {
    const kinds = expectedInventory.kinds ?? expectedInventory;
    for (const [kind, names] of Object.entries(kinds)) {
      const expectedNames = [...names].sort();
      const actualNames = manifest.entries
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.name)
        .sort();
      if (
        expectedNames.length !== actualNames.length ||
        expectedNames.some((name, index) => name !== actualNames[index])
      ) {
        throw new Error(
          `Required ${kind} inventory mismatch: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`,
        );
      }
    }
    const expectedKinds = new Set(Object.keys(kinds));
    const unexpectedKind = manifest.entries.find(
      (entry) => !expectedKinds.has(entry.kind),
    );
    if (unexpectedKind) {
      throw new Error(`Unexpected bundle entry kind: ${unexpectedKind.kind}`);
    }
  }

  return {
    entries: manifest.entries.length,
    packageVersion: manifest.packageVersion,
  };
}

async function verifyArchive(archivePath, expectedVersion, expectedInventory) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "verify-source-bundle-"),
  );
  try {
    const { stdout: archiveListing } = await execFileAsync("tar", [
      "-tzf",
      resolve(archivePath),
    ]);
    for (const entry of archiveListing.split("\n")) {
      if (entry)
        safeRelativePath(entry.endsWith("/") ? entry.slice(0, -1) : entry);
    }
    await execFileAsync("tar", [
      "-xzf",
      resolve(archivePath),
      "-C",
      temporaryDirectory,
    ]);
    const children = await readdir(temporaryDirectory);
    if (children.length !== 1)
      throw new Error("Bundle archive must have one top-level directory");
    const root = join(temporaryDirectory, children[0]);
    if (!(await stat(root)).isDirectory())
      throw new Error("Bundle root is not a directory");
    return await verifyBundleDirectory(
      root,
      expectedVersion,
      expectedInventory,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function main() {
  const input = process.argv[2];
  const expectedVersion = process.argv[3];
  if (!input) {
    throw new Error(
      "Usage: node toolchain/verify-corresponding-source.mjs <bundle-directory-or-tar.gz> [version]",
    );
  }

  const inputStat = await stat(resolve(input));
  const sourceLock = JSON.parse(
    await readFile(
      join(import.meta.dirname, "corresponding-source-lock.json"),
      "utf8",
    ),
  );
  const expectedInventory = {
    kinds: expectedInventoryFromLock(sourceLock),
    sourceLock,
  };
  const result = inputStat.isDirectory()
    ? await verifyBundleDirectory(input, expectedVersion, expectedInventory)
    : await verifyArchive(input, expectedVersion, expectedInventory);
  console.log(
    `Verified Corresponding Source Bundle ${basename(input)} (${result.entries} entries)`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
