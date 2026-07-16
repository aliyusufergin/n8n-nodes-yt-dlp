import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InvocationCancelledError,
  runInvocation,
  type InvocationArtifact,
} from "../nodes/YtDlp/invocation-runtime";

const fakeToolPath = resolve(__dirname, "fixtures/fake-tool.mjs");

const toolchain = {
  ytDlp: "test-yt-dlp",
  ffmpeg: "test-ffmpeg",
  ffprobe: "test-ffprobe",
  ejs: "test-ejs",
};

describe("invocation runtime", () => {
  it("returns process output and transfers finalized artifacts before workspace cleanup", async () => {
    let workspacePath: string | undefined;

    const outcome = await runInvocation(
      {
        executablePath: process.execPath,
        argv: [fakeToolPath, "success"],
        secretValues: [],
        timeoutSeconds: 0,
        toolchain,
      },
      async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => {
        workspacePath = resolve(sourcePath, "../../..");
        return {
          metadata,
          value: await readFile(sourcePath),
        };
      },
    );

    expect(outcome.result).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      signal: null,
      stdout: "download complete\n",
      stderr: "fixture warning\n",
      stdoutTruncated: false,
      stderrTruncated: false,
      artifactCount: 1,
      toolchain,
      error: null,
    });
    expect(outcome.result.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.artifacts).toEqual([
      {
        metadata: {
          relativePath: "nested/video.mp4",
          fileName: "video.mp4",
          fileExtension: "mp4",
          mimeType: "video/mp4",
          fileSize: 13,
        },
        value: Buffer.from("fixture-media"),
      },
    ]);
    expect(workspacePath).toBeDefined();
    await expect(access(workspacePath!)).rejects.toThrow();
  });

  it("returns a failed result and transfers only finalized regular files", async () => {
    const outcome = await runInvocation(
      {
        executablePath: process.execPath,
        argv: [fakeToolPath, "failure"],
        secretValues: [],
        timeoutSeconds: 0,
        toolchain,
      },
      async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
        metadata,
        value: await readFile(sourcePath),
      }),
    );

    expect(outcome.result).toMatchObject({
      status: "failed",
      exitCode: 2,
      signal: null,
      stderr: "download failed\n",
      artifactCount: 1,
      error: { message: "The packaged yt-dlp process failed." },
    });
    expect(
      outcome.artifacts.map((artifact) => artifact.metadata.relativePath),
    ).toEqual(["final.info.json"]);
  });

  it("redacts secrets across stream chunks before retaining bounded process output", async () => {
    const secret = 'top secret/+"quoted"';
    const outcome = await runInvocation(
      {
        executablePath: process.execPath,
        argv: [fakeToolPath, "redact", secret],
        secretValues: [secret],
        timeoutSeconds: 0,
        toolchain,
      },
      async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
        metadata,
        value: await readFile(sourcePath),
      }),
    );

    expect(outcome.result.stdoutBytes).toBeGreaterThan(1024 * 1024);
    expect(outcome.result.stdoutTruncated).toBe(true);
    expect(outcome.result.stdout).toContain("[REDACTED]");
    expect(outcome.result.stdout).toContain("[output truncated]");
    expect(outcome.result.stdout).not.toContain(secret);
    expect(outcome.result.stdout).not.toContain(encodeURIComponent(secret));
    expect(outcome.result.stdout).not.toContain(
      JSON.stringify(secret).slice(1, -1),
    );
    expect(outcome.result.stderr).toBe(
      "Authorization: [REDACTED]\n" +
        "https://[REDACTED]@example.test/video?token=[REDACTED]\n",
    );
  });

  it("times out and terminates the complete process group before cleanup", async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), "n8n-ytdlp-test-"));
    const reportPath = join(testDirectory, "report.json");

    try {
      const outcome = await runInvocation(
        {
          executablePath: process.execPath,
          argv: [fakeToolPath, "hang", reportPath],
          secretValues: [],
          timeoutSeconds: 0.1,
          toolchain,
        },
        async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
          metadata,
          value: await readFile(sourcePath),
        }),
      );
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        descendantPid: number;
        workspacePath: string;
      };

      expect(outcome.result.status).toBe("timed_out");
      expect(outcome.result.durationMs).toBeLessThan(1500);
      expect(() => process.kill(report.descendantPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      await expect(access(report.workspacePath)).rejects.toThrow();
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  });

  it("propagates cancellation after terminating descendants and cleaning the workspace", async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), "n8n-ytdlp-test-"));
    const reportPath = join(testDirectory, "report.json");
    const controller = new AbortController();

    try {
      const invocation = runInvocation(
        {
          executablePath: process.execPath,
          argv: [fakeToolPath, "hang", reportPath],
          secretValues: [],
          timeoutSeconds: 0,
          toolchain,
          signal: controller.signal,
        },
        async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
          metadata,
          value: await readFile(sourcePath),
        }),
      );
      setTimeout(() => controller.abort(), 100);

      await expect(invocation).rejects.toBeInstanceOf(InvocationCancelledError);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        descendantPid: number;
        workspacePath: string;
      };
      expect(() => process.kill(report.descendantPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      await expect(access(report.workspacePath)).rejects.toThrow();
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  });

  it("does not miss cancellation while preparing the workspace", async () => {
    const controller = new AbortController();
    const invocation = runInvocation(
      {
        executablePath: process.execPath,
        argv: [fakeToolPath, "success"],
        secretValues: [],
        timeoutSeconds: 0,
        toolchain,
        signal: controller.signal,
      },
      async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
        metadata,
        value: await readFile(sourcePath),
      }),
    );

    controller.abort();

    await expect(invocation).rejects.toBeInstanceOf(InvocationCancelledError);
  });

  it("passes only allowed operator environment and redacts proxy credentials", async () => {
    const previousProxy = process.env.HTTPS_PROXY;
    const previousArbitraryValue = process.env.ARBITRARY_PRIVATE_VALUE;
    process.env.HTTPS_PROXY = "http://proxy-user:proxy-pass@proxy.test:8080";
    process.env.ARBITRARY_PRIVATE_VALUE = "must-not-be-inherited";

    try {
      const outcome = await runInvocation(
        {
          executablePath: process.execPath,
          argv: [fakeToolPath, "environment", "proxy-pass"],
          secretValues: [],
          timeoutSeconds: 0,
          toolchain,
        },
        async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
          metadata,
          value: await readFile(sourcePath),
        }),
      );

      expect(outcome.result.stdout).toContain('"arbitrary":null');
      expect(outcome.result.stdout).toContain(
        "http://[REDACTED]@proxy.test:8080",
      );
      expect(outcome.result.stdout).not.toContain("proxy-user");
      expect(outcome.result.stdout).not.toContain("proxy-pass");
      expect(outcome.result.stdout).not.toContain("must-not-be-inherited");
    } finally {
      if (previousProxy === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = previousProxy;
      }
      if (previousArbitraryValue === undefined) {
        delete process.env.ARBITRARY_PRIVATE_VALUE;
      } else {
        process.env.ARBITRARY_PRIVATE_VALUE = previousArbitraryValue;
      }
    }
  });

  it("creates private invocation paths and a mode-0600 cookie file before spawn", async () => {
    const cookieContent =
      ".example.test\tTRUE\t/\tTRUE\t0\tsession\tcookie-secret\n";
    const outcome = await runInvocation(
      {
        executablePath: process.execPath,
        argv: ({ cookiePath, privatePath, temporaryPath }) => [
          fakeToolPath,
          "workspace",
          cookiePath!,
          cookieContent,
          temporaryPath,
          privatePath,
        ],
        cookieContent,
        secretValues: ["cookie-secret"],
        timeoutSeconds: 0,
        toolchain,
      },
      async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
        metadata,
        value: await readFile(sourcePath),
      }),
    );

    expect(JSON.parse(outcome.result.stdout)).toEqual({
      cookieMatches: true,
      cookieMode: 0o600,
      outputMode: 0o700,
      temporaryMode: 0o700,
      privateMode: 0o700,
    });
    expect(outcome.result.stdout).not.toContain("cookie-secret");
  });

  it("reclaims only abandoned workspaces with a conclusive owner marker", async () => {
    const abandonedPath = await mkdtemp(
      join(tmpdir(), "n8n-ytdlp-000-abandoned-"),
    );
    const ambiguousPath = await mkdtemp(
      join(tmpdir(), "n8n-ytdlp-000-ambiguous-"),
    );
    await writeFile(
      join(abandonedPath, ".owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        nodeVersion: 1,
        pid: 2_147_483_647,
        processStartIdentity: "1",
      }),
      { mode: 0o600 },
    );

    try {
      await runInvocation(
        {
          executablePath: process.execPath,
          argv: [fakeToolPath, "success"],
          secretValues: [],
          timeoutSeconds: 0,
          toolchain,
        },
        async (sourcePath, metadata): Promise<InvocationArtifact<Buffer>> => ({
          metadata,
          value: await readFile(sourcePath),
        }),
      );

      await expect(access(abandonedPath)).rejects.toThrow();
      await expect(access(ambiguousPath)).resolves.toBeUndefined();
    } finally {
      await rm(abandonedPath, { force: true, recursive: true });
      await rm(ambiguousPath, { force: true, recursive: true });
    }
  });
});
