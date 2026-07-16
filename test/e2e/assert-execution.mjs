import { readFile } from "node:fs/promises";

import { parseExecutionOutput } from "./parse-execution.mjs";

const execution = parseExecutionOutput(await readFile(process.argv[2], "utf8"));
const runs = execution?.data?.resultData?.runData?.["yt-dlp"];
const outputs = runs?.at(-1)?.data?.main;
const result = outputs?.[0]?.[0];
const artifacts = outputs?.[1];

if (result?.json?.status !== "succeeded" || result.json.artifactCount < 1) {
  throw new Error(
    "The yt-dlp Result output did not report a successful artifact-producing run",
  );
}
if (!Array.isArray(artifacts) || artifacts.length < 1) {
  throw new Error("The yt-dlp Artifact output is empty");
}
if (
  !artifacts.some(
    (artifact) => artifact.binary?.data?.fileName === "merged.mp4",
  )
) {
  throw new Error("The merged.mp4 binary artifact is missing");
}
if (artifacts.some((artifact) => artifact.pairedItem?.item !== 0)) {
  throw new Error("An Artifact output lost its input-item pairing");
}
