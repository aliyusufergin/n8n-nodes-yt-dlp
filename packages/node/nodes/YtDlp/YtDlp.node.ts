import type {
  ICredentialDataDecryptedObject,
  IDataObject,
  IExecuteFunctions,
  IBinaryData,
  INode,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";

import {
  InvocationCancelledError,
  runInvocation,
  type InvocationWorkspace,
} from "./invocation-runtime";
import { executeItems, ItemExecutionError } from "./node-execution";
import { detectRuntimePlatform, resolveToolchain } from "./platform-resolver";

interface OptionalYtDlpSecretsContext {
  getNode(): Pick<INode, "credentials">;
  getCredentials(
    type: string,
    itemIndex?: number,
  ): Promise<ICredentialDataDecryptedObject>;
}

export async function getOptionalYtDlpSecrets(
  context: OptionalYtDlpSecretsContext,
  itemIndex: number,
): Promise<ICredentialDataDecryptedObject> {
  if (context.getNode().credentials?.ytDlpSecrets === undefined) {
    return {};
  }

  return await context.getCredentials("ytDlpSecrets", itemIndex);
}

function packagedArgv(
  workspace: InvocationWorkspace,
  toolchain: Awaited<ReturnType<typeof resolveToolchain>>,
  userArgv: readonly string[],
): string[] {
  return [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-remote-components",
    "--no-js-runtimes",
    "--js-runtimes",
    `node:${toolchain.nodePath}`,
    "--ffmpeg-location",
    dirname(toolchain.ffmpegPath),
    "--paths",
    `home:${workspace.outputPath}`,
    "--paths",
    `temp:${workspace.temporaryPath}`,
    "--cache-dir",
    join(workspace.privatePath, "cache"),
    ...(workspace.cookiePath === undefined
      ? []
      : ["--cookies", workspace.cookiePath]),
    ...userArgv,
  ];
}

export class YtDlp implements INodeType {
  description: INodeTypeDescription = {
    displayName: "yt-dlp",
    name: "ytDlp",
    icon: { light: "file:ytdlp.svg", dark: "file:ytdlp.dark.svg" },
    group: ["transform"],
    version: 1,
    description: "Run packaged yt-dlp arguments without a custom n8n image",
    subtitle: "Run yt-dlp",
    defaults: {
      name: "yt-dlp",
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [
      { type: NodeConnectionTypes.Main, displayName: "Result" },
      { type: NodeConnectionTypes.Main, displayName: "Artifacts" },
    ],
    credentials: [{ name: "ytDlpSecrets", required: false }],
    properties: [
      {
        displayName: "Arguments",
        name: "arguments",
        type: "string",
        typeOptions: { rows: 8 },
        default: "",
        required: true,
        placeholder: "--format best https://example.com/video",
        description:
          "Arguments that follow yt-dlp; this field is not a shell command",
      },
      {
        displayName: "Timeout Seconds",
        name: "timeoutSeconds",
        type: "number",
        typeOptions: { minValue: 0, numberPrecision: 3 },
        default: 0,
        description:
          "Maximum runtime for each input item; zero disables the timeout",
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const inputData = this.getInputData();
    const toolchain = await resolveToolchain(detectRuntimePlatform());
    const items = [];

    for (let itemIndex = 0; itemIndex < inputData.length; itemIndex += 1) {
      const credentials = await getOptionalYtDlpSecrets(this, itemIndex);
      items.push({
        arguments: this.getNodeParameter("arguments", itemIndex) as string,
        timeoutSeconds: this.getNodeParameter(
          "timeoutSeconds",
          itemIndex,
          0,
        ) as number,
        sensitiveArguments:
          (credentials.sensitiveArguments as string | undefined) ?? "",
        cookies: (credentials.cookies as string | undefined) ?? "",
      });
    }

    try {
      const outputs = await executeItems<IBinaryData>({
        items,
        catalog: toolchain.catalog,
        toolchain: toolchain.versions,
        nodeArguments: [],
        continueOnFail: this.continueOnFail(),
        runner: async ({ approvedArguments, timeoutSeconds }) =>
          await runInvocation(
            {
              executablePath: toolchain.executablePath,
              argv: (workspace) =>
                packagedArgv(workspace, toolchain, approvedArguments.argv),
              cookieContent: approvedArguments.cookieContent,
              secretValues: approvedArguments.secretValues,
              timeoutSeconds,
              toolchain: toolchain.versions,
              signal: this.getExecutionCancelSignal(),
            },
            async (sourcePath, metadata) => ({
              metadata,
              value: await this.helpers.prepareBinaryData(
                createReadStream(sourcePath),
                metadata.fileName,
                metadata.mimeType,
              ),
            }),
          ),
      });

      return [
        outputs[0].map((item) => ({
          json: item.json as unknown as IDataObject,
          pairedItem: item.pairedItem,
        })),
        outputs[1].map((item) => ({
          json: item.json as unknown as IDataObject,
          binary: item.binary,
          pairedItem: item.pairedItem,
        })),
      ];
    } catch (error) {
      if (error instanceof InvocationCancelledError) {
        throw error;
      }
      const itemIndex =
        error instanceof ItemExecutionError ? error.itemIndex : undefined;
      throw new NodeOperationError(this.getNode(), error as Error, {
        itemIndex,
      });
    }
  }
}
