import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  parseApkbuildChecksums,
  verifyCargoVendor,
} from "../../toolchain/build-corresponding-source.mjs";

const root = resolve(import.meta.dirname, "../..");

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

test("source lock matches both packaged FFmpeg manifests", async () => {
  const lock = await json("toolchain/corresponding-source-lock.json");
  const rootPackage = await json("package.json");

  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.packageVersion, rootPackage.version);

  for (const platform of ["linux-x64", "linux-arm64"]) {
    const manifest = await json(
      `packages/platform-${platform}/toolchain-manifest.json`,
    );
    const ffmpeg = manifest.sources.find((source) => source.name === "ffmpeg");
    assert.equal(ffmpeg.imageDigest, lock.wader.imageDigest);
    assert.equal(
      ffmpeg.platformManifestDigest,
      lock.wader.platformManifests[ffmpeg.platform],
    );
    assert.match(ffmpeg.sourceUrl, new RegExp(`${lock.wader.commit}$`, "u"));
  }
});

test("all git source locks use full immutable commits", async () => {
  const lock = await json("toolchain/corresponding-source-lock.json");
  const sources = [
    ...lock.topLevelSources,
    ...lock.reviewedGitSources.map(({ url, ...source }) => ({
      ...source,
      repository: url,
    })),
    ...lock.supplementalGitSources,
  ];

  assert.ok(sources.length > 0);
  for (const source of sources) {
    assert.match(source.commit, /^[a-f0-9]{40}$/u, source.name);
    assert.match(source.repository, /^https:\/\//u, source.name);
  }
});

test("extracts both inline and multiline APKBUILD checksums", () => {
  const first = "a".repeat(128);
  const second = "b".repeat(128);

  assert.deepEqual(
    parseApkbuildChecksums(`sha512sums="${first}  inline.tar.gz
${second}  multiline.tar.xz
"`),
    [
      { filename: "inline.tar.gz", sha512: first },
      { filename: "multiline.tar.xz", sha512: second },
    ],
  );
});

test("revalidates cached Cargo vendor files against Cargo.lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-vendor-test-"));
  const packageRoot = join(root, "vendor", "example");
  const lockPath = join(root, "Cargo.lock");
  const packageChecksum = "c".repeat(64);
  const fileDigest = createHash("sha256").update("source").digest("hex");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "lib.rs"), "source");
  await writeFile(
    join(packageRoot, ".cargo-checksum.json"),
    JSON.stringify({
      files: { "lib.rs": fileDigest },
      package: packageChecksum,
    }),
  );
  await writeFile(lockPath, `checksum = "${packageChecksum}"\n`);

  assert.equal((await verifyCargoVendor(root, lockPath)).length, 1);
  await writeFile(join(packageRoot, "lib.rs"), "tampered");
  await assert.rejects(
    () => verifyCargoVendor(root, lockPath),
    /Cargo vendor checksum mismatch/u,
  );
});
