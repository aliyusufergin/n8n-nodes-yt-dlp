import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const outputDirectory = process.env.N8N_YTDLP_OUTPUT_DIR;

if (!outputDirectory) {
  throw new Error("Missing test output directory");
}

if (mode === "success") {
  const nestedDirectory = join(outputDirectory, "nested");
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(join(nestedDirectory, "video.mp4"), "fixture-media");
  process.stdout.write("download complete\n");
  process.stderr.write("fixture warning\n");
} else if (mode === "failure") {
  await writeFile(join(outputDirectory, "final.info.json"), "{}");
  await writeFile(join(outputDirectory, "unfinished.mp4.part"), "partial");
  await symlink(
    join(outputDirectory, "final.info.json"),
    join(outputDirectory, "linked.json"),
  );
  process.stderr.write("download failed\n");
  process.exitCode = 2;
} else if (mode === "redact") {
  const secret = process.argv[3];
  const splitAt = Math.floor(secret.length / 2);
  process.stdout.write(`prefix:${secret.slice(0, splitAt)}`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  process.stdout.write(`${secret.slice(splitAt)}\n`);
  process.stdout.write(`encoded:${encodeURIComponent(secret)}\n`);
  process.stdout.write(`json:${JSON.stringify(secret).slice(1, -1)}\n`);
  process.stdout.write("a".repeat(600 * 1024));
  process.stdout.write("b".repeat(600 * 1024));
  process.stdout.write(`tail:${secret}\n`);
  process.stderr.write("Authorization: Bearer unknown-authorization\n");
  process.stderr.write(
    "https://user:password@example.test/video?token=unknown-token\n",
  );
} else if (mode === "hang") {
  const reportPath = process.argv[3];
  const descendant = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 2000)"],
    {
      stdio: "ignore",
    },
  );
  await writeFile(
    reportPath,
    JSON.stringify({
      descendantPid: descendant.pid,
      workspacePath: process.env.HOME,
    }),
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
} else if (mode === "environment") {
  process.stdout.write(
    `${JSON.stringify({
      arbitrary: process.env.ARBITRARY_PRIVATE_VALUE ?? null,
      httpsProxy: process.env.HTTPS_PROXY ?? null,
    })}\nproxy password:${process.argv[3]}\n`,
  );
} else if (mode === "workspace") {
  const [cookiePath, expectedCookieContent, temporaryPath, privatePath] =
    process.argv.slice(3);
  const [cookieStat, outputStat, temporaryStat, privateStat] =
    await Promise.all([
      stat(cookiePath),
      stat(outputDirectory),
      stat(temporaryPath),
      stat(privatePath),
    ]);
  process.stdout.write(
    `${JSON.stringify({
      cookieMatches:
        (await readFile(cookiePath, "utf8")) === expectedCookieContent,
      cookieMode: cookieStat.mode & 0o777,
      outputMode: outputStat.mode & 0o777,
      temporaryMode: temporaryStat.mode & 0o777,
      privateMode: privateStat.mode & 0o777,
    })}\n`,
  );
} else {
  throw new Error(`Unknown fake-tool mode: ${mode}`);
}
