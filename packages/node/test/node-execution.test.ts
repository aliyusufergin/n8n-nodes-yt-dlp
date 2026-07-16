import { describe, expect, it } from "vitest";

import type { OptionCatalog } from "../nodes/YtDlp/argument-policy";
import {
  executeItems,
  ItemExecutionError,
  type ItemRunner,
  type YtDlpItemInput,
} from "../nodes/YtDlp/node-execution";

const catalog: OptionCatalog = {
  ytDlpVersion: "test-version",
  options: {},
};

const toolchain = {
  ytDlp: "test-yt-dlp",
  ffmpeg: "test-ffmpeg",
  ffprobe: "test-ffprobe",
  ejs: "test-ejs",
};

describe("node execution contract", () => {
  it("runs items sequentially and pairs both result and artifact outputs", async () => {
    const events: string[] = [];
    let activeInvocations = 0;
    let maximumActiveInvocations = 0;
    const runner: ItemRunner<Buffer> = async ({ itemIndex }) => {
      events.push(`start:${itemIndex}`);
      activeInvocations += 1;
      maximumActiveInvocations = Math.max(
        maximumActiveInvocations,
        activeInvocations,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      activeInvocations -= 1;
      events.push(`end:${itemIndex}`);
      return {
        result: {
          status: "succeeded",
          exitCode: 0,
          signal: null,
          durationMs: 5,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          artifactCount: itemIndex + 1,
          toolchain,
          error: null,
        },
        artifacts: Array.from(
          { length: itemIndex + 1 },
          (_, artifactIndex) => ({
            metadata: {
              relativePath: `${itemIndex}/${artifactIndex}.mp4`,
              fileName: `${artifactIndex}.mp4`,
              fileExtension: "mp4",
              mimeType: "video/mp4",
              fileSize: 1,
            },
            value: Buffer.from([artifactIndex]),
          }),
        ),
      };
    };
    const items: YtDlpItemInput[] = [
      { arguments: "https://example.test/first", timeoutSeconds: 0 },
      { arguments: "https://example.test/second", timeoutSeconds: 0 },
    ];

    const outputs = await executeItems({
      items,
      catalog,
      toolchain,
      nodeArguments: [],
      continueOnFail: false,
      runner,
    });

    expect(maximumActiveInvocations).toBe(1);
    expect(events).toEqual(["start:0", "end:0", "start:1", "end:1"]);
    expect(outputs[0].map((item) => item.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
    ]);
    expect(outputs[1].map((item) => item.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
      { item: 1 },
    ]);
    expect(outputs[1][2]).toMatchObject({
      json: { relativePath: "1/1.mp4" },
      binary: { data: Buffer.from([1]) },
    });
  });

  it("stops later items on an invocation failure by default", async () => {
    const calledItems: number[] = [];
    const runner: ItemRunner<Buffer> = async ({ itemIndex }) => {
      calledItems.push(itemIndex);
      return {
        result: {
          status: "failed",
          exitCode: 2,
          signal: null,
          durationMs: 1,
          stdout: "",
          stderr: "failed",
          stdoutBytes: 0,
          stderrBytes: 6,
          stdoutTruncated: false,
          stderrTruncated: false,
          artifactCount: 0,
          toolchain,
          error: { message: "The packaged yt-dlp process failed." },
        },
        artifacts: [],
      };
    };

    await expect(
      executeItems({
        items: [
          { arguments: "https://example.test/first", timeoutSeconds: 0 },
          { arguments: "https://example.test/second", timeoutSeconds: 0 },
        ],
        catalog,
        toolchain,
        nodeArguments: [],
        continueOnFail: false,
        runner,
      }),
    ).rejects.toBeInstanceOf(ItemExecutionError);
    expect(calledItems).toEqual([0]);
  });

  it("emits a failed result for validation errors and continues when requested", async () => {
    const calledItems: number[] = [];
    const runner: ItemRunner<Buffer> = async ({ itemIndex }) => {
      calledItems.push(itemIndex);
      return {
        result: {
          status: "succeeded",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          artifactCount: 0,
          toolchain,
          error: null,
        },
        artifacts: [],
      };
    };

    const outputs = await executeItems({
      items: [
        { arguments: "../private-file", timeoutSeconds: 0 },
        { arguments: "https://example.test/second", timeoutSeconds: 0 },
      ],
      catalog,
      toolchain,
      nodeArguments: [],
      continueOnFail: true,
      runner,
    });

    expect(calledItems).toEqual([1]);
    expect(outputs[0]).toHaveLength(2);
    expect(outputs[0][0]).toMatchObject({
      pairedItem: { item: 0 },
      json: {
        status: "failed",
        exitCode: null,
        artifactCount: 0,
        toolchain,
        error: { message: "Local file inputs are not supported." },
      },
    });
    expect(outputs[0][1]).toMatchObject({
      pairedItem: { item: 1 },
      json: { status: "succeeded" },
    });
  });
});
