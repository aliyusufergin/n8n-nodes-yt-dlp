import type { ICredentialType, INodeProperties } from "n8n-workflow";

export class YtDlpSecrets implements ICredentialType {
  name = "ytDlpSecrets";

  displayName = "yt-dlp Secrets";

  icon = "file:ytdlp.svg" as const;

  documentationUrl =
    "https://github.com/aliyusufergin/n8n-nodes-ytdlp#yt-dlp-secrets-credential";

  properties: INodeProperties[] = [
    {
      displayName: "Cookies",
      name: "cookies",
      type: "string",
      typeOptions: { password: true, rows: 8 },
      default: "",
      description: "Netscape cookie-file content",
    },
    {
      displayName: "Sensitive Arguments",
      name: "sensitiveArguments",
      type: "string",
      typeOptions: { password: true, rows: 4 },
      default: "",
      description:
        "Sensitive yt-dlp options and values; positional inputs are not allowed",
    },
  ];
}
