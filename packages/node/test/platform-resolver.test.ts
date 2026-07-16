import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveToolchain,
  type PlatformPackage,
  type ToolchainManifest,
} from "../nodes/YtDlp/platform-resolver";

describe("platform package contract", () => {
  it("resolves verified executable paths from the matching package manifest", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "n8n-ytdlp-platform-"));
    const executableNames = ["yt-dlp", "ffmpeg", "ffprobe", "node"];

    try {
      await mkdir(join(packageRoot, "vendor"), { recursive: true });
      for (const executableName of executableNames) {
        const executablePath = join(packageRoot, "vendor", executableName);
        await writeFile(executablePath, "fixture");
        await chmod(executablePath, 0o755);
      }
      await mkdir(join(packageRoot, "vendor", "ejs"));
      const manifest: ToolchainManifest = {
        schemaVersion: 1,
        packageVersion: "0.1.0",
        target: { platform: "linux", arch: "x64", libc: "musl" },
        versions: {
          ytDlp: "2026.07.14.233956",
          ffmpeg: "7.1",
          ffprobe: "7.1",
          ejs: "0.3.1",
        },
        paths: {
          ytDlp: "vendor/yt-dlp",
          ffmpeg: "vendor/ffmpeg",
          ffprobe: "vendor/ffprobe",
          node: "vendor/node",
          ejs: "vendor/ejs",
        },
        optionCatalogPath: "option-catalog.json",
        sources: [],
      };
      const optionCatalog = {
        ytDlpVersion: "2026.07.14.233956",
        options: {},
      };
      const loadPackage = (packageName: string): PlatformPackage => {
        expect(packageName).toBe("n8n-nodes-yt-dlp-linux-x64");
        return {
          packageRoot,
          packageVersion: "0.1.0",
          manifest,
          optionCatalog,
        };
      };

      const resolved = await resolveToolchain(
        { platform: "linux", arch: "x64", libc: "musl" },
        loadPackage,
      );

      expect(resolved).toEqual({
        executablePath: join(packageRoot, "vendor", "yt-dlp"),
        ffmpegPath: join(packageRoot, "vendor", "ffmpeg"),
        ffprobePath: join(packageRoot, "vendor", "ffprobe"),
        nodePath: join(packageRoot, "vendor", "node"),
        ejsPath: join(packageRoot, "vendor", "ejs"),
        versions: manifest.versions,
        catalog: optionCatalog,
      });
    } finally {
      await rm(packageRoot, { force: true, recursive: true });
    }
  });

  it("rejects a platform package that is not versioned in lockstep with the node", async () => {
    const manifest: ToolchainManifest = {
      schemaVersion: 1,
      packageVersion: "0.2.0",
      target: { platform: "linux", arch: "x64", libc: "musl" },
      versions: {
        ytDlp: "2026.07.14.233956",
        ffmpeg: "7.1",
        ffprobe: "7.1",
        ejs: "0.8.0",
      },
      paths: {
        ytDlp: "vendor/yt-dlp",
        ffmpeg: "vendor/ffmpeg",
        ffprobe: "vendor/ffprobe",
        node: "vendor/node",
        ejs: "vendor/ejs",
      },
      optionCatalogPath: "option-catalog.json",
      sources: [],
    };

    await expect(
      resolveToolchain(
        { platform: "linux", arch: "x64", libc: "musl" },
        () => ({
          packageRoot: "/does-not-matter",
          packageVersion: "0.2.0",
          manifest,
          optionCatalog: { ytDlpVersion: manifest.versions.ytDlp, options: {} },
        }),
      ),
    ).rejects.toThrow("does not match node package version 0.1.0");
  });
});
