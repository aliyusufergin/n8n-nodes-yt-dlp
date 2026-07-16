import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { OptionCatalog } from "./argument-policy";
import type { ToolchainVersions } from "./invocation-runtime";

export interface RuntimePlatform {
  platform: NodeJS.Platform;
  arch: string;
  libc: "glibc" | "musl" | "unknown";
}

export interface ToolchainManifest {
  schemaVersion: 1;
  packageVersion: string;
  target: {
    platform: "linux";
    arch: "x64" | "arm64";
    libc: "musl";
  };
  versions: ToolchainVersions;
  paths: {
    ytDlp: string;
    ffmpeg: string;
    ffprobe: string;
    node: string;
    ejs: string;
  };
  optionCatalogPath: string;
  sources: Array<{
    name: string;
    url: string;
    sha256: string;
    license: string;
    sourceUrl: string;
  }>;
}

export interface PlatformPackage {
  packageRoot: string;
  packageVersion: string;
  manifest: ToolchainManifest;
  optionCatalog: OptionCatalog;
}

export type PlatformPackageLoader = (packageName: string) => PlatformPackage;

export interface ResolvedToolchain {
  executablePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  nodePath: string;
  ejsPath: string;
  versions: ToolchainVersions;
  catalog: OptionCatalog;
}

export class PlatformResolutionError extends Error {}

const loadModule = createRequire(__filename);
const nodePackageVersion = (
  loadModule(resolve(__dirname, "..", "..", "package.json")) as {
    version: string;
  }
).version;

function resolveManifestPath(
  packageRoot: string,
  manifestPath: string,
): string {
  const absolutePath = resolve(packageRoot, manifestPath);
  const relativePath = relative(packageRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new PlatformResolutionError(
      "The installed toolchain manifest contains an unsafe path.",
    );
  }
  return absolutePath;
}

function defaultPackageLoader(packageName: string): PlatformPackage {
  try {
    const packageJsonPath = loadModule.resolve(`${packageName}/package.json`);
    const packageRoot = dirname(packageJsonPath);
    const packageJson = loadModule(packageJsonPath) as { version: string };
    const manifest = loadModule(
      resolve(packageRoot, "toolchain-manifest.json"),
    ) as ToolchainManifest;
    const optionCatalog = loadModule(
      resolveManifestPath(packageRoot, manifest.optionCatalogPath),
    ) as OptionCatalog;
    return {
      packageRoot,
      packageVersion: packageJson.version,
      manifest,
      optionCatalog,
    };
  } catch {
    throw new PlatformResolutionError(
      `The required platform package ${packageName} is missing. Reinstall n8n-nodes-yt-dlp on the n8n host.`,
    );
  }
}

export async function resolveToolchain(
  runtime: RuntimePlatform,
  loadPackage: PlatformPackageLoader = defaultPackageLoader,
): Promise<ResolvedToolchain> {
  if (
    runtime.platform !== "linux" ||
    runtime.libc !== "musl" ||
    (runtime.arch !== "x64" && runtime.arch !== "arm64")
  ) {
    throw new PlatformResolutionError(
      `Unsupported runtime ${runtime.platform}/${runtime.arch}/${runtime.libc}; expected Linux x64 or arm64 with musl.`,
    );
  }

  const packageName = `n8n-nodes-yt-dlp-linux-${runtime.arch}`;
  const platformPackage = loadPackage(packageName);
  if (platformPackage.packageVersion !== nodePackageVersion) {
    throw new PlatformResolutionError(
      `Platform package ${platformPackage.packageVersion} does not match node package version ${nodePackageVersion}. Reinstall n8n-nodes-yt-dlp.`,
    );
  }
  const { manifest } = platformPackage;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageVersion !== platformPackage.packageVersion ||
    manifest.target.platform !== runtime.platform ||
    manifest.target.arch !== runtime.arch ||
    manifest.target.libc !== runtime.libc ||
    platformPackage.optionCatalog.ytDlpVersion !== manifest.versions.ytDlp
  ) {
    throw new PlatformResolutionError(
      `The installed platform package ${packageName} has an incompatible toolchain manifest.`,
    );
  }

  const resolved = {
    executablePath: resolveManifestPath(
      platformPackage.packageRoot,
      manifest.paths.ytDlp,
    ),
    ffmpegPath: resolveManifestPath(
      platformPackage.packageRoot,
      manifest.paths.ffmpeg,
    ),
    ffprobePath: resolveManifestPath(
      platformPackage.packageRoot,
      manifest.paths.ffprobe,
    ),
    nodePath: resolveManifestPath(
      platformPackage.packageRoot,
      manifest.paths.node,
    ),
    ejsPath: resolveManifestPath(
      platformPackage.packageRoot,
      manifest.paths.ejs,
    ),
    versions: manifest.versions,
    catalog: platformPackage.optionCatalog,
  };

  await Promise.all([
    access(resolved.executablePath, constants.X_OK),
    access(resolved.ffmpegPath, constants.X_OK),
    access(resolved.ffprobePath, constants.X_OK),
    access(resolved.nodePath, constants.X_OK),
    access(resolved.ejsPath, constants.R_OK),
  ]).catch(() => {
    throw new PlatformResolutionError(
      `The installed platform package ${packageName} is incomplete or has unusable tool files.`,
    );
  });

  return resolved;
}

export function detectRuntimePlatform(): RuntimePlatform {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    libc: report?.header?.glibcVersionRuntime ? "glibc" : "musl",
  };
}
