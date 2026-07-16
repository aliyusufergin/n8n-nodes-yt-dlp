import { describe, expect, it } from "vitest";

import {
  approveArguments,
  ArgumentValidationError,
  type OptionCatalog,
} from "../nodes/YtDlp/argument-policy";

const catalog: OptionCatalog = {
  ytDlpVersion: "test-version",
  options: {
    "--format": {
      arity: 1,
      classification: "pass",
    },
    "--exec": {
      arity: 1,
      classification: "restricted",
      reason: "Launching arbitrary executables is not supported.",
    },
    "--paths": {
      arity: 1,
      classification: "node-controlled",
    },
    "--password": {
      arity: 1,
      classification: "pass",
      sensitive: true,
    },
    "--username": {
      arity: 1,
      classification: "pass",
      sensitive: true,
    },
    "-u": {
      arity: 1,
      classification: "pass",
      aliasOf: "--username",
    },
    "-p": {
      arity: 1,
      classification: "pass",
      aliasOf: "--password",
    },
    "--ap-username": {
      arity: 1,
      classification: "pass",
      sensitive: true,
    },
    "--ap-password": {
      arity: 1,
      classification: "pass",
      sensitive: true,
    },
    "--output": {
      arity: 1,
      classification: "pass",
      valueKind: "output-template",
    },
    "--replace-in-metadata": {
      arity: 3,
      classification: "pass",
    },
    "--compat-options": {
      arity: 1,
      classification: "pass",
      valueKind: "compat-options",
      allowedValues: ["filename", "no-certifi"],
    },
    "--preset-alias": {
      arity: 1,
      classification: "pass",
      valueKind: "preset-alias",
      allowedValues: ["mp3", "unsafe"],
      presetExpansions: {
        mp3: ["--format", "bestaudio"],
        unsafe: ["--exec", "whoami"],
      },
    },
    "--output-na-placeholder": {
      arity: 1,
      classification: "pass",
      valueKind: "path-component",
    },
  },
};

describe("argument policy", () => {
  it("preserves CLI token order and quoted option values", () => {
    const approved = approveArguments({
      arguments: `--format 'best video' "https://example.test/watch?v=1&list=2"`,
      nodeArguments: ["--ignore-config"],
      catalog,
    });

    expect(approved.argv).toEqual([
      "--ignore-config",
      "--format",
      "best video",
      "https://example.test/watch?v=1&list=2",
    ]);
    expect(approved.secretValues).toEqual([]);
  });

  it("consumes every value of a multi-value option without treating values as inputs", () => {
    const approved = approveArguments({
      arguments:
        '--replace-in-metadata title "old value" ../literal-replacement https://example.test/video',
      nodeArguments: [],
      catalog,
    });

    expect(approved.argv).toEqual([
      "--replace-in-metadata",
      "title",
      "old value",
      "../literal-replacement",
      "https://example.test/video",
    ]);
  });

  it("allows only reviewed compat-option values", () => {
    expect(
      approveArguments({
        arguments:
          "--compat-options filename,no-certifi https://example.test/video",
        nodeArguments: [],
        catalog,
      }).argv,
    ).toContain("filename,no-certifi");

    expect(() =>
      approveArguments({
        arguments:
          "--compat-options allow-unsafe-ext https://example.test/video",
        nodeArguments: [],
        catalog,
      }),
    ).toThrow("contains a value that is not allowed");
  });

  it("recursively validates fixed preset expansions", () => {
    expect(
      approveArguments({
        arguments: "--preset-alias mp3 https://example.test/video",
        nodeArguments: [],
        catalog,
      }).argv,
    ).toContain("mp3");

    expect(() =>
      approveArguments({
        arguments: "--preset-alias unsafe https://example.test/video",
        nodeArguments: [],
        catalog,
      }),
    ).toThrow("Launching arbitrary executables");
  });

  it("keeps the output placeholder to a single safe path component", () => {
    expect(() =>
      approveArguments({
        arguments:
          "--output-na-placeholder ../../escape https://example.test/video",
        nodeArguments: [],
        catalog,
      }),
    ).toThrow("must be a safe path component");
  });

  it.each([
    "--format best;whoami https://example.test/video",
    "--format best && whoami",
    "--format $(whoami) https://example.test/video",
    "--format `whoami` https://example.test/video",
    "--format best > result.txt",
  ])("rejects shell syntax before approval: %s", (argumentsLine) => {
    expect(() =>
      approveArguments({
        arguments: argumentsLine,
        nodeArguments: [],
        catalog,
      }),
    ).toThrow(ArgumentValidationError);
  });

  it.each([
    ["--unknown value https://example.test/video", "Unknown yt-dlp option"],
    [
      "--exec whoami https://example.test/video",
      "Launching arbitrary executables",
    ],
    ["--paths /tmp https://example.test/video", "controlled by the node"],
  ])(
    "enforces the versioned option catalog for %s",
    (argumentsLine, message) => {
      expect(() =>
        approveArguments({
          arguments: argumentsLine,
          nodeArguments: [],
          catalog,
        }),
      ).toThrow(message);
    },
  );

  it.each([
    ["", "At least one remote input"],
    ["yt-dlp https://example.test/video", "excludes the yt-dlp executable"],
    ["--format", "requires a value"],
    ["./video.mp4", "Local file inputs"],
    ["../video.mp4", "Local file inputs"],
    ["/tmp/video.mp4", "Local file inputs"],
    ["~/video.mp4", "Local file inputs"],
    ["file:///tmp/video.mp4", "file: URLs"],
    ["-", "stdin"],
  ])(
    "rejects invalid or incomplete positional input: %s",
    (argumentsLine, message) => {
      expect(() =>
        approveArguments({
          arguments: argumentsLine,
          nodeArguments: [],
          catalog,
        }),
      ).toThrow(message);
    },
  );

  it("inserts sensitive options before the normal separator and returns their values as secrets", () => {
    const approved = approveArguments({
      arguments: "--format best -- https://example.test/video",
      sensitiveArguments: '--username alice --password "top secret"',
      nodeArguments: ["--ignore-config"],
      catalog,
    });

    expect(approved.argv).toEqual([
      "--ignore-config",
      "--format",
      "best",
      "--username",
      "alice",
      "--password",
      "top secret",
      "--",
      "https://example.test/video",
    ]);
    expect(approved.secretValues).toEqual(["alice", "top secret"]);
  });

  it.each([
    ["--username alice", "A password is required with --username"],
    ["-u alice", "A password is required with --username"],
    ["--ap-username alice", "A password is required with --ap-username"],
  ])(
    "rejects an interactive credential combination before spawn: %s",
    (sensitiveArguments, message) => {
      expect(() =>
        approveArguments({
          arguments: "https://example.test/video",
          sensitiveArguments,
          nodeArguments: [],
          catalog,
        }),
      ).toThrow(message);
    },
  );

  it.each([
    {
      name: "oversized normal arguments",
      input: { arguments: "a".repeat(64 * 1024 + 1) },
      message: "Arguments exceeds 65536 UTF-8 bytes",
    },
    {
      name: "oversized sensitive arguments",
      input: {
        arguments: "https://example.test/video",
        sensitiveArguments: `--password ${"a".repeat(64 * 1024)}`,
      },
      message: "Sensitive Arguments exceeds 65536 UTF-8 bytes",
    },
    {
      name: "oversized cookies",
      input: {
        arguments: "https://example.test/video",
        cookies: "a".repeat(10 * 1024 * 1024 + 1),
      },
      message: "Cookies exceeds 10485760 UTF-8 bytes",
    },
    {
      name: "NUL bytes",
      input: { arguments: "https://example.test/\0video" },
      message: "Arguments contains a NUL byte",
    },
  ])("bounds control-plane input: $name", ({ input, message }) => {
    expect(() =>
      approveArguments({
        ...input,
        nodeArguments: [],
        catalog,
      }),
    ).toThrow(message);
  });

  it("validates Netscape cookies and adds cookie values to the secret set", () => {
    const cookies = [
      "# Netscape HTTP Cookie File",
      ".example.test\tTRUE\t/\tTRUE\t0\tsession\tcookie-secret",
      "#HttpOnly_.example.test\tTRUE\t/\tTRUE\t1700000000\tauth\tauth-secret",
      "",
    ].join("\n");

    const approved = approveArguments({
      arguments: "https://example.test/video",
      cookies,
      nodeArguments: [],
      catalog,
    });

    expect(approved.cookieContent).toBe(cookies);
    expect(approved.secretValues).toEqual(["cookie-secret", "auth-secret"]);
  });

  it.each([
    "example.test TRUE / FALSE 0 session must-not-leak",
    "example.test\tMAYBE\t/\tFALSE\t0\tsession\tmust-not-leak",
    "example.test\tTRUE\t/\tFALSE\tnot-a-time\tsession\tmust-not-leak",
  ])(
    "rejects invalid Netscape cookie data without echoing it: %s",
    (cookies) => {
      let error: unknown;

      try {
        approveArguments({
          arguments: "https://example.test/video",
          cookies,
          nodeArguments: [],
          catalog,
        });
      } catch (caughtError) {
        error = caughtError;
      }

      expect(error).toBeInstanceOf(ArgumentValidationError);
      expect((error as Error).message).toBe(
        "Cookies line 1 is not valid Netscape cookie data.",
      );
      expect((error as Error).message).not.toContain("must-not-leak");
    },
  );

  it("accepts a relative output template beneath the node output area", () => {
    const approved = approveArguments({
      arguments:
        '--output "downloads/%(title)s.%(ext)s" https://example.test/video',
      nodeArguments: [],
      catalog,
    });

    expect(approved.argv).toEqual([
      "--output",
      "downloads/%(title)s.%(ext)s",
      "https://example.test/video",
    ]);
  });

  it.each([
    "-",
    "/tmp/%(title)s",
    "../%(title)s",
    "safe/../../%(title)s",
    "~/%(title)s",
  ])(
    "rejects an output template that can leave the output area: %s",
    (template) => {
      expect(() =>
        approveArguments({
          arguments: `--output '${template}' https://example.test/video`,
          nodeArguments: [],
          catalog,
        }),
      ).toThrow("must be a safe relative path");
    },
  );

  it("removes a backslash-newline continuation without splitting the token", () => {
    const approved = approveArguments({
      arguments: "--format best\\\nvideo https://example.test/video",
      nodeArguments: [],
      catalog,
    });

    expect(approved.argv).toEqual([
      "--format",
      "bestvideo",
      "https://example.test/video",
    ]);
  });

  it("does not let a restricted option hide in another option value position", () => {
    expect(() =>
      approveArguments({
        arguments: "--format --exec whoami https://example.test/video",
        nodeArguments: [],
        catalog,
      }),
    ).toThrow("cannot use another option as its value");
  });
});
