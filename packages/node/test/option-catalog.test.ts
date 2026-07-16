import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  approveArguments,
  type OptionCatalog,
} from "../nodes/YtDlp/argument-policy";

let catalog: OptionCatalog;

beforeAll(async () => {
  catalog = JSON.parse(
    await readFile(
      resolve(__dirname, "../../../toolchain/option-catalog.json"),
      "utf8",
    ),
  ) as OptionCatalog;
});

describe("reviewed option catalog", () => {
  it.each(["aac", "mkv", "mp3", "mp4", "sleep"])(
    "recursively approves the %s preset expansion",
    (preset) => {
      expect(
        approveArguments({
          arguments: `--preset-alias ${preset} https://example.test/video`,
          nodeArguments: [],
          catalog,
        }).argv,
      ).toContain(preset);
    },
  );

  it.each(["all", "allow-unsafe-ext", "allow-unsafe-exec-expansion"])(
    "rejects unsafe or recursively broad compat value %s",
    (compatValue) => {
      expect(() =>
        approveArguments({
          arguments: `--compat-options ${compatValue} https://example.test/video`,
          nodeArguments: [],
          catalog,
        }),
      ).toThrow("contains a value that is not allowed");
    },
  );
});
