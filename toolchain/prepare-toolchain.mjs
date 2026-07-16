import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { verifyYtDlpSignedChecksum } from "./verify-yt-dlp-signature.mjs";

const packageDirectory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error(
    "Usage: node toolchain/prepare-toolchain.mjs <platform-package-directory>",
  );
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(join(packageDirectory, "toolchain-manifest.json"), "utf8"),
);
const workspace = await mkdtemp(join(tmpdir(), "n8n-ytdlp-toolchain-"));
const vendorDirectory = join(packageDirectory, "vendor");

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function download(source) {
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed for ${source.name}: HTTP ${response.status}`,
    );
  }
  const destination = join(workspace, basename(new URL(source.url).pathname));
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { mode: 0o600 }),
  );
  const digest = await sha256(destination);
  if (digest !== source.sha256) {
    throw new Error(`SHA-256 mismatch for ${source.name}`);
  }
  return destination;
}

async function findFile(directory, suffix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, suffix);
      if (nested) return nested;
    } else if (entry.isFile() && entryPath.endsWith(suffix)) {
      return entryPath;
    }
  }
  return undefined;
}

function extractTar(archivePath, destination) {
  const extraction = spawnSync(
    "tar",
    ["-xJf", archivePath, "-C", destination],
    {
      encoding: "utf8",
    },
  );
  if (extraction.status !== 0) {
    throw new Error(`tar failed: ${extraction.stderr.trim()}`);
  }
}

function runDocker(arguments_, description) {
  const result = spawnSync("docker", arguments_, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function copyOciFiles(source) {
  const imageReference = `${source.image}@${source.imageDigest}`;
  runDocker(
    ["pull", "--platform", source.platform, imageReference],
    `OCI pull for ${source.name}`,
  );
  const containerId = runDocker(
    ["create", "--platform", source.platform, imageReference],
    `OCI container creation for ${source.name}`,
  );

  try {
    for (const [name, file] of Object.entries(source.files)) {
      const destination = join(vendorDirectory, name);
      runDocker(
        ["cp", `${containerId}:${file.path}`, destination],
        `OCI copy for ${name}`,
      );
      if ((await sha256(destination)) !== file.sha256) {
        throw new Error(`SHA-256 mismatch for ${source.name} ${name}`);
      }
    }
  } finally {
    runDocker(["rm", "--force", containerId], `OCI cleanup for ${source.name}`);
  }
}

try {
  await rm(vendorDirectory, { force: true, recursive: true });
  await mkdir(join(vendorDirectory, "ejs"), { mode: 0o700, recursive: true });
  await mkdir(join(vendorDirectory, "licenses"), {
    mode: 0o700,
    recursive: true,
  });
  await copyFile(
    join(repositoryRoot, "toolchain", "ejs-LICENSE"),
    join(vendorDirectory, "licenses", "ejs-LICENSE"),
  );
  await copyFile(
    join(repositoryRoot, "toolchain", "option-catalog.json"),
    join(packageDirectory, "option-catalog.json"),
  );

  for (const source of manifest.sources) {
    if (source.name === "yt-dlp") {
      await verifyYtDlpSignedChecksum(source, workspace, repositoryRoot);
    }
    if (source.image) {
      await copyOciFiles(source);
      continue;
    }
    const downloaded = await download(source);
    if (source.name === "yt-dlp") {
      await copyFile(downloaded, join(vendorDirectory, "yt-dlp"));
    } else if (source.name === "ejs") {
      await copyFile(
        downloaded,
        join(vendorDirectory, "ejs", basename(downloaded)),
      );
    } else {
      const extractionDirectory = join(workspace, `${source.name}-extracted`);
      await mkdir(extractionDirectory);
      extractTar(downloaded, extractionDirectory);
      if (source.name === "ffmpeg") {
        const ffmpeg = await findFile(extractionDirectory, "/bin/ffmpeg");
        const ffprobe = await findFile(extractionDirectory, "/bin/ffprobe");
        if (!ffmpeg || !ffprobe)
          throw new Error("FFmpeg archive layout is not recognized");
        await copyFile(ffmpeg, join(vendorDirectory, "ffmpeg"));
        await copyFile(ffprobe, join(vendorDirectory, "ffprobe"));
      } else if (source.name === "node") {
        const node = await findFile(extractionDirectory, "/bin/node");
        const nodeLicense = await findFile(extractionDirectory, "/LICENSE");
        if (!node || !nodeLicense)
          throw new Error("Node archive layout is not recognized");
        await copyFile(node, join(vendorDirectory, "node"));
        await copyFile(
          nodeLicense,
          join(vendorDirectory, "licenses", "node-LICENSE"),
        );
      }
    }
  }

  await Promise.all(
    ["yt-dlp", "ffmpeg", "ffprobe", "node"].map((name) =>
      chmod(join(vendorDirectory, name), 0o755),
    ),
  );
  await cp(
    join(repositoryRoot, "docs", "specification.md"),
    join(vendorDirectory, "BUILD_SPEC.md"),
  );
} finally {
  await rm(workspace, { force: true, recursive: true });
}
