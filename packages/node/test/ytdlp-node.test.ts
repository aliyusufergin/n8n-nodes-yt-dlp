import { describe, expect, it, vi } from "vitest";

import { getOptionalYtDlpSecrets, YtDlp } from "../nodes/YtDlp/YtDlp.node";

describe("yt-dlp n8n node", () => {
  it("exposes the minimal regular-node interface with two named outputs", () => {
    const node = new YtDlp();

    expect(node.description).toMatchObject({
      displayName: "yt-dlp",
      name: "ytDlp",
      version: 1,
      outputs: [
        { type: "main", displayName: "Result" },
        { type: "main", displayName: "Artifacts" },
      ],
      credentials: [{ name: "ytDlpSecrets", required: false }],
    });
    expect(node.description.usableAsTool).toBeUndefined();
    expect(
      node.description.properties.map((property) => property.name),
    ).toEqual(["arguments", "timeoutSeconds"]);
  });

  it("does not request optional credentials when the node has none configured", async () => {
    const getCredentials = vi.fn();

    await expect(
      getOptionalYtDlpSecrets(
        {
          getNode: () => ({ credentials: undefined }),
          getCredentials,
        },
        0,
      ),
    ).resolves.toEqual({});
    expect(getCredentials).not.toHaveBeenCalled();
  });
});
