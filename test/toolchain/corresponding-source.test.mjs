import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyBundleDirectory } from "../../toolchain/verify-corresponding-source.mjs";

const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-bundle-test-"));
  await mkdir(join(root, "distfiles", "direct"), { recursive: true });
  await writeFile(join(root, "distfiles", "direct", "source.tar.xz"), "");
  await writeFile(
    join(root, "bundle.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      packageVersion: "0.1.0",
      entries: [
        {
          archivePath: "distfiles/direct/source.tar.xz",
          kind: "archive",
          name: "source",
          origin: "https://example.invalid/source.tar.xz",
          sha256: emptySha256,
          versionOrCommit: "1.0.0",
        },
      ],
    })}\n`,
  );
  await writeFile(
    join(root, "SHA256SUMS"),
    `${emptySha256}  distfiles/direct/source.tar.xz\n`,
  );
  return root;
}

test("verifies a source bundle manifest and its file digests", async () => {
  const root = await fixture();

  assert.deepEqual(await verifyBundleDirectory(root, "0.1.0"), {
    entries: 1,
    packageVersion: "0.1.0",
  });
});

test("rejects a source bundle whose bytes no longer match", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "distfiles", "direct", "source.tar.xz"),
    "changed",
  );

  await assert.rejects(
    () => verifyBundleDirectory(root, "0.1.0"),
    /SHA-256 mismatch/u,
  );
});

test("rejects files hidden from the source inventory", async () => {
  const root = await fixture();
  await writeFile(join(root, "distfiles", "unlisted.patch"), "surprise");

  await assert.rejects(
    () => verifyBundleDirectory(root, "0.1.0"),
    /absent from bundle.json/u,
  );
});

test("rejects a source entry without a version or commit", async () => {
  const root = await fixture();
  const manifestPath = join(root, "bundle.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries[0].versionOrCommit = null;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(
    () => verifyBundleDirectory(root, "0.1.0"),
    /versionOrCommit/u,
  );
});

test("rejects a bundle missing a required source inventory entry", async () => {
  const root = await fixture();

  await assert.rejects(
    () =>
      verifyBundleDirectory(root, "0.1.0", {
        archive: ["missing-source", "source"],
      }),
    /Required archive inventory mismatch/u,
  );
});
