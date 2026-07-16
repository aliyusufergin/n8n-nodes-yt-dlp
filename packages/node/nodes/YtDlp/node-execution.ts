import {
  approveArguments,
  ArgumentValidationError,
  type ApprovedArguments,
  type OptionCatalog,
} from "./argument-policy";
import type {
  InvocationArtifact,
  InvocationOutcome,
  InvocationResult,
  ToolchainVersions,
} from "./invocation-runtime";

export interface YtDlpItemInput {
  arguments: string;
  timeoutSeconds: number;
  sensitiveArguments?: string;
  cookies?: string;
}

export interface ItemRunnerInput {
  itemIndex: number;
  timeoutSeconds: number;
  approvedArguments: ApprovedArguments;
}

export type ItemRunner<T> = (
  input: ItemRunnerInput,
) => Promise<InvocationOutcome<T>>;

export interface ExecuteItemsInput<T> {
  items: readonly YtDlpItemInput[];
  catalog: OptionCatalog;
  toolchain: ToolchainVersions;
  nodeArguments: readonly string[];
  continueOnFail: boolean;
  runner: ItemRunner<T>;
}

export interface PairedItem {
  item: number;
}

export interface ResultOutputItem {
  json: InvocationResult;
  pairedItem: PairedItem;
}

export interface ArtifactOutputItem<T> {
  json: InvocationArtifact<T>["metadata"];
  binary: { data: T };
  pairedItem: PairedItem;
}

export type ExecuteItemsOutput<T> = [
  ResultOutputItem[],
  Array<ArtifactOutputItem<T>>,
];

export class ItemExecutionError extends Error {
  constructor(
    readonly itemIndex: number,
    readonly result: InvocationResult,
  ) {
    super(result.error?.message ?? "The packaged yt-dlp process failed.");
  }
}

export async function executeItems<T>(
  input: ExecuteItemsInput<T>,
): Promise<ExecuteItemsOutput<T>> {
  const resultItems: ResultOutputItem[] = [];
  const artifactItems: Array<ArtifactOutputItem<T>> = [];

  for (const [itemIndex, item] of input.items.entries()) {
    let approvedArguments: ApprovedArguments;
    try {
      approvedArguments = approveArguments({
        arguments: item.arguments,
        sensitiveArguments: item.sensitiveArguments,
        cookies: item.cookies,
        nodeArguments: input.nodeArguments,
        catalog: input.catalog,
      });
    } catch (error) {
      if (
        !input.continueOnFail ||
        !(error instanceof ArgumentValidationError)
      ) {
        throw error;
      }
      resultItems.push({
        json: {
          status: "failed",
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          artifactCount: 0,
          toolchain: input.toolchain,
          error: { message: error.message },
        },
        pairedItem: { item: itemIndex },
      });
      continue;
    }
    const outcome = await input.runner({
      itemIndex,
      timeoutSeconds: item.timeoutSeconds,
      approvedArguments,
    });
    if (outcome.result.status !== "succeeded" && !input.continueOnFail) {
      throw new ItemExecutionError(itemIndex, outcome.result);
    }
    resultItems.push({
      json: outcome.result,
      pairedItem: { item: itemIndex },
    });
    artifactItems.push(
      ...outcome.artifacts.map((artifact) => ({
        json: artifact.metadata,
        binary: { data: artifact.value },
        pairedItem: { item: itemIndex },
      })),
    );
  }

  return [resultItems, artifactItems];
}
