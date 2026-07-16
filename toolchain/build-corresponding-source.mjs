import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { inspectSourceRecipe } from "./source-recipe.mjs";
import {
  expectedInventoryFromLock,
  verifyBundleDirectory,
} from "./verify-corresponding-source.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const lockPath = join(import.meta.dirname, "corresponding-source-lock.json");

function log(message) {
  console.log(`[corresponding-source] ${message}`);
}

function safeName(value) {
  if (!/^[a-zA-Z0-9._-]+$/u.test(value))
    throw new Error(`Unsafe source name: ${value}`);
  return value;
}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hash(path, algorithm) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function sha256(path) {
  return hash(path, "sha256");
}

async function deterministicTarGz(
  sourceDirectory,
  outputPath,
  members = ["."],
) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryTar = `${outputPath}.tar`;
  await rm(temporaryTar, { force: true });
  await rm(outputPath, { force: true });
  await run("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--exclude=.git",
    "--exclude=.git/*",
    "-cf",
    temporaryTar,
    "-C",
    sourceDirectory,
    ...members,
  ]);
  await run("gzip", ["-n", temporaryTar]);
  await rename(`${temporaryTar}.gz`, outputPath);
}

async function download(source, cacheDirectory) {
  const cachePath = join(
    cacheDirectory,
    `${safeName(source.name)}-${source.sha256}`,
  );
  await mkdir(cacheDirectory, { recursive: true });

  if (await exists(cachePath)) {
    if ((await sha256(cachePath)) === source.sha256) return cachePath;
    await rm(cachePath, { force: true });
  }

  log(`downloading ${source.name}`);
  const temporaryPath = `${cachePath}.partial-${process.pid}`;
  await run("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--retry-all-errors",
    "--silent",
    "--show-error",
    "--output",
    temporaryPath,
    source.url,
  ]);
  const actual = await sha256(temporaryPath);
  if (actual !== source.sha256) {
    await rm(temporaryPath, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${source.name}: expected ${source.sha256}, got ${actual}`,
    );
  }
  await rename(temporaryPath, cachePath);
  return cachePath;
}

async function checkout(source, checkoutsDirectory) {
  const name = safeName(source.name);
  const directory = join(checkoutsDirectory, name);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  log(`checking out ${name}@${source.commit}`);
  await run("git", ["init", "--quiet"], { cwd: directory });
  await run("git", ["remote", "add", "origin", source.repository], {
    cwd: directory,
  });
  await run("git", ["fetch", "--quiet", "--depth=1", "origin", source.commit], {
    cwd: directory,
  });
  await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
    cwd: directory,
  });
  const actual = await run("git", ["rev-parse", "HEAD"], {
    capture: true,
    cwd: directory,
  });
  if (actual !== source.commit) {
    throw new Error(
      `Git revision mismatch for ${name}: expected ${source.commit}, got ${actual}`,
    );
  }
  await run(
    "git",
    [
      "-c",
      "protocol.file.allow=never",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--depth=1",
    ],
    { cwd: directory },
  );
  return directory;
}

function artifactName(source, fallbackExtension = ".source") {
  let upstreamName = source.filename;
  try {
    upstreamName ??= basename(new URL(source.url).pathname);
  } catch {
    upstreamName = "";
  }
  const name =
    upstreamName && upstreamName !== "get_patch"
      ? upstreamName
      : `${source.name}${fallbackExtension}`;
  return `${safeName(source.name)}--${name.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")}`;
}

async function addDownloadedArtifact(source, category, root, cache, metadata) {
  const cached = await download(source, cache);
  const relativePath = join("distfiles", category, artifactName(source));
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(cached, destination);
  metadata.set(relativePath, {
    kind: category === "direct" ? "wader-archive" : "supplemental-archive",
    name: source.name,
    origin: source.url,
    versionOrCommit: source.version ?? null,
  });
  return destination;
}

async function addGitSnapshot(source, category, root, checkouts, metadata) {
  const checkoutDirectory = await checkout(source, checkouts);
  const relativePath = join(
    "distfiles",
    category,
    `${safeName(source.name)}-${source.commit}.tar.gz`,
  );
  await deterministicTarGz(checkoutDirectory, join(root, relativePath));
  metadata.set(relativePath, {
    kind: "git-snapshot",
    name: source.name,
    origin: source.repository,
    provenance: source.provenance,
    versionOrCommit: source.commit,
  });
  return checkoutDirectory;
}

async function findNamedFile(root, name) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findNamedFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

export function parseApkbuildChecksums(apkbuild) {
  return [...apkbuild.matchAll(/([a-f0-9]{128})  ([^"\n]+)/gu)].map(
    (match) => ({
      filename: match[2].trim(),
      sha512: match[1],
    }),
  );
}

export async function verifyCargoVendor(outputRoot, cargoLock) {
  const expectedPackageChecksums = new Set(
    [
      ...(await readFile(cargoLock, "utf8")).matchAll(
        /checksum = "([a-f0-9]{64})"/gu,
      ),
    ].map((match) => match[1]),
  );
  const actualPackageChecksums = new Set();
  const inventory = [];
  for (const entry of await readdir(join(outputRoot, "vendor"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(outputRoot, "vendor", entry.name);
    const checksum = JSON.parse(
      await readFile(join(packageRoot, ".cargo-checksum.json"), "utf8"),
    );
    if (checksum.package) actualPackageChecksums.add(checksum.package);
    for (const [path, expected] of Object.entries(checksum.files)) {
      if ((await sha256(join(packageRoot, path))) !== expected) {
        throw new Error(
          `Cargo vendor checksum mismatch for ${entry.name}/${path}`,
        );
      }
    }
    inventory.push({
      directory: entry.name,
      packageChecksum: checksum.package,
    });
  }
  if (
    expectedPackageChecksums.size !== actualPackageChecksums.size ||
    [...expectedPackageChecksums].some(
      (checksum) => !actualPackageChecksums.has(checksum),
    )
  ) {
    throw new Error("Cargo vendor package checksums do not match Cargo.lock");
  }
  return inventory.sort((a, b) => a.directory.localeCompare(b.directory));
}

async function vendorCargo(
  name,
  sourceArchive,
  version,
  lock,
  work,
  root,
  metadata,
  cache,
) {
  const sourceRoot = join(work, "cargo-source", name);
  const outputRoot = join(work, "cargo-vendor", name);
  await rm(sourceRoot, { force: true, recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await run("tar", ["-xf", sourceArchive, "-C", sourceRoot]);
  const cargoLock = await findNamedFile(sourceRoot, "Cargo.lock");
  if (!cargoLock) throw new Error(`${name} source does not contain Cargo.lock`);
  const cargoLockDigest = await sha256(cargoLock);
  const cachedOutput = join(
    cache,
    "cargo-vendor",
    `${name}-${cargoLockDigest}`,
  );
  await rm(outputRoot, { force: true, recursive: true });
  const cacheHit = await exists(cachedOutput);
  if (cacheHit) {
    log(`reusing locked Cargo source cache for ${name}`);
    await cp(cachedOutput, outputRoot, { recursive: true });
  } else {
    await mkdir(outputRoot, { recursive: true });
    const manifestDirectory = dirname(cargoLock);
    const relativeManifestDirectory = relative(
      sourceRoot,
      manifestDirectory,
    ).replaceAll("\\", "/");
    const image = `${lock.alpine.baseImage}@${lock.alpine.baseImageDigest}`;
    log(`vendoring locked Cargo sources for ${name}`);
    await run("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "-v",
      `${sourceRoot}:/src:ro`,
      "-v",
      `${outputRoot}:/out`,
      image,
      "/bin/sh",
      "-ec",
      'apk add --no-cache cargo git ca-certificates >/dev/null; cargo vendor --quiet --locked /out/vendor --manifest-path "$1/Cargo.toml" >/out/vendor-config.toml',
      "source-vendor",
      `/src/${relativeManifestDirectory}`,
    ]);
    await mkdir(join(outputRoot, ".cargo"), { recursive: true });
    await copyFile(
      join(outputRoot, "vendor-config.toml"),
      join(outputRoot, ".cargo", "config.toml"),
    );
  }
  const inventory = await verifyCargoVendor(outputRoot, cargoLock);
  await writeFile(
    join(outputRoot, "inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  if (!cacheHit) {
    await mkdir(dirname(cachedOutput), { recursive: true });
    await cp(outputRoot, cachedOutput, { recursive: true });
  }
  const relativePath = join(
    "distfiles",
    "cargo",
    `${safeName(name)}-vendor.tar.gz`,
  );
  await deterministicTarGz(outputRoot, join(root, relativePath));
  metadata.set(relativePath, {
    kind: "cargo-vendor",
    name: `${name}-cargo-vendor`,
    origin: "Cargo.lock",
    versionOrCommit: version,
  });
}

async function collectAlpine(lock, work, root, metadata, checkouts, cache) {
  const source = {
    name: "alpine-aports",
    repository: lock.alpine.aportsRepository,
    commit: lock.alpine.aportsCommit,
  };
  const aports = await checkout(source, checkouts);
  const selected = join(work, "aports-selected");
  const previousDistfiles = join(work, "alpine-distfiles");
  const distfiles = join(cache, "alpine");
  await rm(selected, { force: true, recursive: true });
  await mkdir(selected, { recursive: true });
  if (!(await exists(distfiles)) && (await exists(previousDistfiles))) {
    await cp(previousDistfiles, distfiles, { recursive: true });
  }
  await mkdir(distfiles, { recursive: true });
  const fallbackOrigins = new Map();
  for (const fallback of lock.alpine.fallbackArchives ?? []) {
    const cached = await download(fallback, join(cache, "alpine-fallbacks"));
    await copyFile(cached, join(distfiles, fallback.filename));
    fallbackOrigins.set(fallback.filename, fallback.url);
  }
  for (const packageDirectory of lock.alpine.packageDirectories) {
    await cp(join(aports, packageDirectory), join(selected, packageDirectory), {
      recursive: true,
    });
  }
  for (const file of ["LICENSE", "README.md"]) {
    if (await exists(join(aports, file)))
      await copyFile(join(aports, file), join(selected, file));
  }
  for (const packageDirectory of lock.alpine.packageDirectories) {
    const packageRoot = join(selected, packageDirectory);
    const apkbuild = await readFile(join(packageRoot, "APKBUILD"), "utf8");
    for (const { filename, sha512: expectedSha512 } of parseApkbuildChecksums(
      apkbuild,
    )) {
      if (await exists(join(packageRoot, filename))) continue;

      const destination = join(distfiles, filename);
      const origin = `${lock.alpine.distfilesBaseUrl}/${encodeURIComponent(filename)}`;
      if (
        !(await exists(destination)) ||
        (await hash(destination, "sha512")) !== expectedSha512
      ) {
        await rm(destination, { force: true });
        log(`downloading Alpine distfile ${filename}`);
        await run("curl", [
          "--fail",
          "--location",
          "--retry",
          "3",
          "--retry-all-errors",
          "--silent",
          "--show-error",
          "--output",
          destination,
          origin,
        ]);
      }
      const actualSha512 = await hash(destination, "sha512");
      if (actualSha512 !== expectedSha512) {
        throw new Error(`Alpine SHA-512 mismatch for ${filename}`);
      }
      if (!fallbackOrigins.has(filename)) fallbackOrigins.set(filename, origin);
    }
  }

  const packageList = lock.alpine.packageDirectories
    .map((path) => `'${path}'`)
    .join(" ");
  const script = `
apk add --no-cache alpine-sdk ca-certificates >/dev/null
adduser -D -u "$HOST_UID" sourcebuilder
for package in ${packageList}; do
  echo "fetching Alpine source: $package"
  su sourcebuilder -c "cd /work/$package && SRCDEST=/out abuild fetch && SRCDEST=/out abuild verify"
done
`;
  const image = `${lock.alpine.baseImage}@${lock.alpine.baseImageDigest}`;
  for (const platform of ["linux/amd64", "linux/arm64"]) {
    log(`fetching and verifying Alpine distfiles for ${platform}`);
    await run("docker", [
      "run",
      "--rm",
      "--platform",
      platform,
      "-e",
      `HOST_UID=${process.getuid?.() ?? 1000}`,
      "-v",
      `${selected}:/work`,
      "-v",
      `${distfiles}:/out`,
      image,
      "/bin/sh",
      "-ec",
      script,
    ]);
  }
  for (const packageDirectory of lock.alpine.packageDirectories) {
    await rm(join(selected, packageDirectory, "src"), {
      force: true,
      recursive: true,
    });
  }

  const recipePath = join(
    "distfiles",
    "alpine",
    `aports-selected-${lock.alpine.aportsCommit}.tar.gz`,
  );
  await deterministicTarGz(selected, join(root, recipePath));
  metadata.set(recipePath, {
    kind: "alpine-aports-recipes",
    name: "alpine-aports-selected",
    origin: lock.alpine.aportsRepository,
    versionOrCommit: lock.alpine.aportsCommit,
  });

  for (const entry of await readdir(distfiles, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = join("distfiles", "alpine", "sources", entry.name);
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await copyFile(join(distfiles, entry.name), join(root, relativePath));
    metadata.set(relativePath, {
      kind: "alpine-distfile",
      name: entry.name,
      origin:
        fallbackOrigins.get(entry.name) ?? `aports@${lock.alpine.aportsCommit}`,
      versionOrCommit: lock.alpine.aportsCommit,
    });
  }
}

async function addPackageRecipe(root, work, metadata, packageVersion) {
  const recipe = join(work, "package-recipe");
  await rm(recipe, { force: true, recursive: true });
  for (const relativePath of [
    "toolchain/build-corresponding-source.mjs",
    "toolchain/corresponding-source-lock.json",
    "toolchain/prepare-toolchain.mjs",
    "toolchain/source-recipe.mjs",
    "toolchain/verify-corresponding-source.mjs",
    "docs/adr/0030-verify-source-completeness-without-claiming-bit-reproducibility.md",
    "docs/research/corresponding-source.md",
    "packages/platform-linux-x64/toolchain-manifest.json",
    "packages/platform-linux-arm64/toolchain-manifest.json",
    "packages/platform-linux-x64/SOURCE_OFFER.md",
    "packages/platform-linux-arm64/SOURCE_OFFER.md",
  ]) {
    const destination = join(recipe, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repositoryRoot, relativePath), destination);
  }
  const relativePath = join("build", "n8n-nodes-ytdlp-package-recipe.tar.gz");
  await deterministicTarGz(recipe, join(root, relativePath));
  metadata.set(relativePath, {
    kind: "packaging-recipe",
    name: "n8n-nodes-ytdlp-package-recipe",
    origin: "https://github.com/aliyusufergin/n8n-nodes-ytdlp",
    versionOrCommit: packageVersion,
  });
}

async function addProvenanceEvidence(root, work, lock, metadata) {
  const image = `${lock.wader.image}@${lock.wader.imageDigest}`;
  await mkdir(join(root, "manifests"), { recursive: true });
  for (const [platform, architecture] of [
    ["linux/amd64", "amd64"],
    ["linux/arm64", "arm64"],
  ]) {
    const containerId = await run(
      "docker",
      ["create", "--platform", platform, image],
      { capture: true },
    );
    const versionsPath = join(work, `wader-versions-${architecture}.json`);
    try {
      await run("docker", [
        "cp",
        `${containerId}:/versions.json`,
        versionsPath,
      ]);
    } finally {
      await run("docker", ["rm", "--force", containerId]);
    }
    const versions = JSON.parse(await readFile(versionsPath, "utf8"));
    const relativePath = join(
      "manifests",
      `alpine-packages-${architecture}.txt`,
    );
    const lines = Object.entries(versions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => `${name}=${version}`);
    await writeFile(
      join(root, relativePath),
      `# Retained /versions.json component inventory from ${image} (${platform})\n${lines.join("\n")}\n`,
    );
    metadata.set(relativePath, {
      kind: "provenance-evidence",
      name: `alpine-packages-${architecture}`,
      origin: image,
      versionOrCommit: lock.wader.commit,
    });
  }

  const relativePath = join("manifests", "original-build-run.txt");
  await writeFile(
    join(root, relativePath),
    `Wader source commit: ${lock.wader.commit}
Original GitHub Actions run: ${lock.wader.buildRunUrl}
Published OCI image: ${lock.wader.image}@${lock.wader.imageDigest}
linux/amd64 manifest: ${lock.wader.platformManifests["linux/amd64"]}
linux/arm64 manifest: ${lock.wader.platformManifests["linux/arm64"]}

Retained run metadata excerpt (queried from GitHub Actions):
- headSha: ${lock.wader.commit}
- event: push
- Build image (ubuntu-latest, amd64): success
  started 2026-06-17T19:13:24Z; completed 2026-06-17T20:21:35Z
  job ${lock.wader.buildRunUrl}/job/81980131371
- Build image (ubicloud-standard-8-arm, arm64): success
  started 2026-06-17T19:13:48Z; completed 2026-06-17T19:51:18Z
  job ${lock.wader.buildRunUrl}/job/81980131435
- Merge and push images: success
  started 2026-06-17T20:21:45Z; completed 2026-06-17T20:22:31Z
  job ${lock.wader.buildRunUrl}/job/81993390802

The image component inventories copied beside this file are retained directly
from each pinned image.
`,
  );
  metadata.set(relativePath, {
    kind: "provenance-evidence",
    name: "original-build-run",
    origin: lock.wader.buildRunUrl,
    versionOrCommit: lock.wader.commit,
  });
}

async function addComplianceDocuments(root, lock, metadata) {
  const readme = `# n8n-nodes-ytdlp ${lock.packageVersion} Corresponding Source Bundle

This archive contains the source snapshots, build recipes, patches, configuration,
license material, and dependency inventory corresponding to the packaged yt-dlp,
FFmpeg/FFprobe, Node.js, and EJS toolchain.

Verify it with:

    node tools/verify-corresponding-source.mjs . ${lock.packageVersion}

The original Wader Dockerfile is retained in its source snapshot. Direct downloads
are stored under distfiles/direct, reviewed git revisions under distfiles/git,
Alpine APKBUILD directories and verified distfiles under distfiles/alpine, and
Cargo.lock-resolved sources under distfiles/cargo. No network access is needed to
inspect or modify these sources.

This bundle does not claim bit-for-bit reproducibility; see PROVENANCE.md.
`;
  const offlineRebuild = `# Offline rebuild boundary

The archive contains the original Wader build recipe, every direct source archive,
reviewed git snapshot, selected Alpine APKBUILD directory and distfile, plus Cargo
vendor trees. These materials can be inspected and modified without network access.

It does not claim that the original FFmpeg binaries can be rebuilt bit-for-bit in a
single network-disabled Docker command. The historical Alpine APK repository used by
the upstream build is no longer fully mirrored, so an operator must first rebuild a
local APK repository from the included aports recipes and distfiles, then rewrite the
original Wader Dockerfile's acquisition steps to that local repository and the
included distfiles. GLib's inferred libffi Meson commit is documented in
PROVENANCE.md. Shipping a nominal offline.Dockerfile that still depended on missing
historical APK bytes would be misleading, so the release gate verifies source
completeness rather than claiming byte-for-byte rebuild reproducibility.
`;
  const provenance = `# Provenance and reproducibility limits

- Wader source commit: ${lock.wader.commit}
- Wader OCI image digest: ${lock.wader.imageDigest}
- Alpine aports commit: ${lock.alpine.aportsCommit}
- Alpine base image digest: ${lock.alpine.baseImageDigest}

The normal Alpine mirrors no longer retain every APK revision used by the original
build. This bundle retains their complete selected APKBUILD directories and fetched,
checksum-verified source distfiles, but does not claim that rebuilding the historical
APK repository will reproduce identical package bytes.

GLib 2.84.1 referred to the mutable \`meson\` branch of the libffi Meson port. The
snapshot at commit 83d0cfd00d7d37af4b4349511d29f1f0512621b3 matches the build-time
timeline, but the retained upstream build log did not attest that commit hash. This
inference is recorded in bundle.json and must not be presented as cryptographic proof.
`;
  for (const [path, content, name] of [
    ["README.md", readme, "bundle-readme"],
    ["OFFLINE_REBUILD.md", offlineRebuild, "offline-rebuild"],
    ["PROVENANCE.md", provenance, "provenance-limitations"],
  ]) {
    await writeFile(join(root, path), content);
    metadata.set(path, {
      kind: "documentation",
      name,
      origin: "n8n-nodes-ytdlp",
      versionOrCommit: lock.packageVersion,
    });
  }
  for (const [sourcePath, destinationName, name] of [
    [
      "toolchain/corresponding-source-lock.json",
      "corresponding-source-lock.json",
      "corresponding-source-lock",
    ],
    [
      "toolchain/verify-corresponding-source.mjs",
      "verify-corresponding-source.mjs",
      "source-bundle-verifier",
    ],
    [
      "toolchain/source-recipe.mjs",
      "source-recipe.mjs",
      "source-recipe-auditor",
    ],
  ]) {
    const relativePath = join("tools", destinationName);
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await copyFile(join(repositoryRoot, sourcePath), join(root, relativePath));
    metadata.set(relativePath, {
      kind: "verification-tool",
      name,
      origin: sourcePath,
      versionOrCommit: lock.packageVersion,
    });
  }

  for (const [sourcePath, destinationName] of [
    ["packages/platform-linux-x64/LICENSE", "GPL-3.0.txt"],
    [
      "packages/platform-linux-x64/THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_NOTICES.md",
    ],
  ]) {
    const relativePath = join("licenses", destinationName);
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await copyFile(join(repositoryRoot, sourcePath), join(root, relativePath));
    metadata.set(relativePath, {
      kind: "license",
      name: destinationName,
      origin: sourcePath,
      versionOrCommit: lock.packageVersion,
    });
  }
}

async function writeManifest(root, lock, metadata) {
  const entries = [];
  for (const [archivePath, details] of [...metadata.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    entries.push({
      ...details,
      archivePath: archivePath.replaceAll("\\", "/"),
      sha256: await sha256(join(root, archivePath)),
      usedBy: ["linux/amd64", "linux/arm64"],
    });
  }
  const manifest = {
    schemaVersion: 1,
    packageVersion: lock.packageVersion,
    generatedFrom: {
      sourceLock: "toolchain/corresponding-source-lock.json",
      waderCommit: lock.wader.commit,
      waderImageDigest: lock.wader.imageDigest,
    },
    entries,
  };
  await writeFile(
    join(root, "bundle.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(root, "SHA256SUMS"),
    `${entries.map((entry) => `${entry.sha256}  ${entry.archivePath}`).join("\n")}\n`,
  );
}

async function build(options) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const work = resolve(options.work ?? join(repositoryRoot, ".source-work"));
  const cache = resolve(options.cache ?? join(repositoryRoot, ".source-cache"));
  const checkouts = join(work, "checkouts");
  await mkdir(checkouts, { recursive: true });

  const waderSource = {
    name: "wader-static-ffmpeg",
    repository: lock.wader.repository,
    commit: lock.wader.commit,
  };
  const waderCheckout = await checkout(waderSource, checkouts);
  const dockerfile = await readFile(join(waderCheckout, "Dockerfile"), "utf8");
  const recipe = inspectSourceRecipe(dockerfile, lock.reviewedGitSources);
  if (options.plan) {
    console.log(
      JSON.stringify(
        {
          alpinePackages: lock.alpine.packageDirectories.length,
          directArchives: recipe.archives.length,
          gitSources: recipe.gitSources.length,
          supplementalArchives: lock.supplementalArchives.length,
          supplementalGitSources: lock.supplementalGitSources.length,
          topLevelSources: lock.topLevelSources.length,
          waderCommit: lock.wader.commit,
        },
        null,
        2,
      ),
    );
    return;
  }

  const bundleName = `n8n-nodes-ytdlp-${lock.packageVersion}-sources`;
  const stagingParent = join(work, "bundle");
  const root = join(stagingParent, bundleName);
  const metadata = new Map();
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { recursive: true });

  const waderPath = join(
    "build",
    `wader-static-ffmpeg-${lock.wader.commit}.tar.gz`,
  );
  await deterministicTarGz(waderCheckout, join(root, waderPath));
  metadata.set(waderPath, {
    kind: "build-recipe",
    name: "wader-static-ffmpeg",
    origin: lock.wader.repository,
    versionOrCommit: lock.wader.commit,
  });

  const directPaths = new Map();
  for (const archive of recipe.archives) {
    directPaths.set(archive.name, {
      path: await addDownloadedArtifact(
        archive,
        "direct",
        root,
        cache,
        metadata,
      ),
      version: archive.version,
    });
  }
  for (const source of recipe.gitSources) {
    await addGitSnapshot(
      { name: source.name, repository: source.url, commit: source.commit },
      "git",
      root,
      checkouts,
      metadata,
    );
  }
  for (const source of lock.supplementalArchives) {
    await addDownloadedArtifact(source, "supplemental", root, cache, metadata);
  }
  for (const source of [
    ...lock.topLevelSources,
    ...lock.supplementalGitSources,
  ]) {
    await addGitSnapshot(source, "git", root, checkouts, metadata);
  }

  const librsvg = directPaths.get("LIBRSVG");
  const rav1e = directPaths.get("RAV1E");
  if (!librsvg || !rav1e)
    throw new Error("Wader recipe is missing locked Cargo sources");
  await vendorCargo(
    "librsvg",
    librsvg.path,
    librsvg.version,
    lock,
    work,
    root,
    metadata,
    cache,
  );
  await vendorCargo(
    "rav1e",
    rav1e.path,
    rav1e.version,
    lock,
    work,
    root,
    metadata,
    cache,
  );
  await collectAlpine(lock, work, root, metadata, checkouts, cache);
  await addProvenanceEvidence(root, work, lock, metadata);
  await addPackageRecipe(root, work, metadata, lock.packageVersion);
  await addComplianceDocuments(root, lock, metadata);
  await writeManifest(root, lock, metadata);
  const verified = await verifyBundleDirectory(root, lock.packageVersion, {
    kinds: expectedInventoryFromLock(lock),
    sourceLock: lock,
  });
  log(`verified ${verified.entries} source artifacts`);

  const output = resolve(
    options.output ?? join(repositoryRoot, "dist", `${bundleName}.tar.gz`),
  );
  await mkdir(dirname(output), { recursive: true });
  await deterministicTarGz(stagingParent, output, [bundleName]);
  log(`created ${output}`);
}

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--plan") options.plan = true;
    else if (["--output", "--work", "--cache"].includes(argument)) {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await build(parseOptions(process.argv.slice(2)));
}

export { build };
