import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

export interface ToolchainVersions {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
  ejs: string;
}

export interface InvocationInput {
  executablePath: string;
  argv:
    | readonly string[]
    | ((workspace: InvocationWorkspace) => readonly string[]);
  cookieContent?: string;
  secretValues: readonly string[];
  timeoutSeconds: number;
  toolchain: ToolchainVersions;
  signal?: AbortSignal;
}

export interface InvocationWorkspace {
  outputPath: string;
  temporaryPath: string;
  privatePath: string;
  cookiePath?: string;
}

export interface ArtifactMetadata {
  relativePath: string;
  fileName: string;
  fileExtension: string;
  mimeType: string;
  fileSize: number;
}

export interface InvocationArtifact<T> {
  metadata: ArtifactMetadata;
  value: T;
}

export interface InvocationResult {
  status: "succeeded" | "failed" | "timed_out";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactCount: number;
  toolchain: ToolchainVersions;
  error: { message: string } | null;
}

export interface InvocationOutcome<T> {
  result: InvocationResult;
  artifacts: Array<InvocationArtifact<T>>;
}

export class InvocationCancelledError extends Error {}

export type ArtifactTransfer<T> = (
  sourcePath: string,
  metadata: ArtifactMetadata,
) => Promise<InvocationArtifact<T>>;

const PASSTHROUGH_ENVIRONMENT = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "TZ",
] as const;

const MIME_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  webm: "video/webm",
  json: "application/json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  vtt: "text/vtt",
  srt: "application/x-subrip",
};

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const OUTPUT_EDGE_BYTES = 512 * 1024;
const TRUNCATION_MARKER = "\n...[output truncated]...\n";
const WORKSPACE_PREFIX = "n8n-ytdlp-";
const OWNER_MARKER_NAME = ".owner.json";
const SCAVENGE_LIMIT = 32;

interface WorkspaceOwnerMarker {
  schemaVersion: 1;
  nodeVersion: 1;
  pid: number;
  processStartIdentity: string;
}

async function processStartIdentity(pid: number): Promise<string> {
  const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = processStat.lastIndexOf(")");
  const fieldsAfterCommand = processStat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startIdentity = fieldsAfterCommand[19];

  if (
    commandEnd < 0 ||
    startIdentity === undefined ||
    !/^\d+$/u.test(startIdentity)
  ) {
    throw new Error("Linux process start identity is unavailable");
  }

  return startIdentity;
}

function isOwnerMarker(value: unknown): value is WorkspaceOwnerMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const marker = value as Partial<WorkspaceOwnerMarker>;
  return (
    marker.schemaVersion === 1 &&
    marker.nodeVersion === 1 &&
    Number.isSafeInteger(marker.pid) &&
    (marker.pid ?? 0) > 0 &&
    typeof marker.processStartIdentity === "string" &&
    /^\d+$/u.test(marker.processStartIdentity)
  );
}

async function ownerIsConclusivelyGone(
  workspacePath: string,
): Promise<boolean> {
  let marker: unknown;
  try {
    marker = JSON.parse(
      await readFile(join(workspacePath, OWNER_MARKER_NAME), "utf8"),
    );
  } catch {
    return false;
  }

  if (!isOwnerMarker(marker)) {
    return false;
  }

  try {
    return (
      (await processStartIdentity(marker.pid)) !== marker.processStartIdentity
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function scavengeAbandonedWorkspaces(): Promise<void> {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  const candidates = entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(WORKSPACE_PREFIX),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, SCAVENGE_LIMIT);

  for (const candidate of candidates) {
    const workspacePath = join(tmpdir(), candidate.name);
    if (await ownerIsConclusivelyGone(workspacePath)) {
      await rm(workspacePath, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }
}

class BoundedTextCapture {
  private readonly chunks: Buffer[] = [];
  private first = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private retainedBytes = 0;
  private truncated = false;

  append(text: string): void {
    const buffer = Buffer.from(text, "utf8");
    if (!this.truncated) {
      this.chunks.push(buffer);
      this.retainedBytes += buffer.length;
      if (this.retainedBytes <= OUTPUT_LIMIT_BYTES) {
        return;
      }

      const combined = Buffer.concat(this.chunks, this.retainedBytes);
      this.first = combined.subarray(0, OUTPUT_EDGE_BYTES);
      this.tail = combined.subarray(-OUTPUT_EDGE_BYTES);
      this.chunks.length = 0;
      this.truncated = true;
      return;
    }

    this.tail = Buffer.concat([this.tail, buffer]).subarray(-OUTPUT_EDGE_BYTES);
  }

  value(): { text: string; truncated: boolean } {
    if (!this.truncated) {
      return {
        text: Buffer.concat(this.chunks, this.retainedBytes).toString("utf8"),
        truncated: false,
      };
    }

    return {
      text: `${this.first.toString("utf8")}${TRUNCATION_MARKER}${this.tail.toString("utf8")}`,
      truncated: true,
    };
  }
}

function redactStructuredValues(text: string): string {
  return text
    .replace(
      /(^|\r?\n)(authorization|proxy-authorization|cookie|set-cookie):[^\r\n]*/giu,
      "$1$2: [REDACTED]",
    )
    .replace(/((?:https?|ftp):\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(
      /([?&](?:access_token|api_?key|auth(?:orization)?|cookie|key|pass(?:word|wd)?|secret|session|sig(?:nature)?|token)=)[^&#\s]*/giu,
      "$1[REDACTED]",
    );
}

class RedactingStreamCapture {
  private readonly capture = new BoundedTextCapture();
  private readonly decoder = new StringDecoder("utf8");
  private readonly secretForms: string[];
  private readonly maximumSecretLength: number;
  private pending = "";
  private originalBytes = 0;

  constructor(secretValues: readonly string[]) {
    this.secretForms = [
      ...new Set(
        secretValues.flatMap((secret) =>
          secret.length === 0
            ? []
            : [
                secret,
                encodeURIComponent(secret),
                JSON.stringify(secret).slice(1, -1),
              ],
        ),
      ),
    ].sort((left, right) => right.length - left.length);
    this.maximumSecretLength = this.secretForms.reduce(
      (maximum, secret) => Math.max(maximum, secret.length),
      0,
    );
  }

  write(chunk: Buffer): void {
    this.originalBytes += chunk.length;
    this.pending += this.decoder.write(chunk);
    this.flushSafePrefix();
  }

  finish(): { text: string; originalBytes: number; truncated: boolean } {
    this.pending += this.decoder.end();
    this.capture.append(this.redact(this.pending));
    this.pending = "";
    const captured = this.capture.value();
    return {
      text: captured.text,
      originalBytes: this.originalBytes,
      truncated: captured.truncated,
    };
  }

  private flushSafePrefix(): void {
    if (this.maximumSecretLength === 0) {
      this.capture.append(redactStructuredValues(this.pending));
      this.pending = "";
      return;
    }

    let cutAt = Math.max(0, this.pending.length - this.maximumSecretLength + 1);
    let boundaryMoved = true;
    while (boundaryMoved && cutAt > 0) {
      boundaryMoved = false;
      for (const secret of this.secretForms) {
        const searchStart = Math.max(0, cutAt - secret.length + 1);
        const occurrence = this.pending.lastIndexOf(secret, cutAt - 1);
        if (occurrence >= searchStart && occurrence + secret.length > cutAt) {
          cutAt = occurrence;
          boundaryMoved = true;
        }
      }
    }

    if (cutAt > 0) {
      this.capture.append(this.redact(this.pending.slice(0, cutAt)));
      this.pending = this.pending.slice(cutAt);
    }
  }

  private redact(text: string): string {
    let redacted = text;
    for (const secret of this.secretForms) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redactStructuredValues(redacted);
  }
}

function createChildEnvironment(
  workspacePath: string,
  outputPath: string,
  temporaryPath: string,
  executablePath: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: workspacePath,
    XDG_CONFIG_HOME: join(workspacePath, "config"),
    XDG_CACHE_HOME: join(workspacePath, "cache"),
    TMPDIR: temporaryPath,
    PATH: dirname(executablePath),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    N8N_YTDLP_OUTPUT_DIR: outputPath,
  };

  for (const name of PASSTHROUGH_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

function extractProxySecrets(environment: NodeJS.ProcessEnv): string[] {
  const secrets = new Set<string>();

  for (const name of PASSTHROUGH_ENVIRONMENT) {
    if (!name.toLowerCase().endsWith("_proxy")) {
      continue;
    }
    const value = environment[name];
    if (value === undefined) {
      continue;
    }

    try {
      const proxyUrl = new URL(value);
      const username = decodeURIComponent(proxyUrl.username);
      const password = decodeURIComponent(proxyUrl.password);
      if (username.length > 0) {
        secrets.add(username);
      }
      if (password.length > 0) {
        secrets.add(password);
      }
      if (username.length > 0 || password.length > 0) {
        secrets.add(`${username}:${password}`);
      }
    } catch {
      // An invalid proxy value remains an operator configuration error for yt-dlp.
    }
  }

  return [...secrets];
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return;
  }

  const escalationAt = Date.now() + 5000;
  while (processGroupExists(processGroupId) && Date.now() < escalationAt) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }

  if (processGroupExists(processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
}

async function listRegularFiles(directoryPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(entryPath)));
    } else if (
      entry.isFile() &&
      !/(?:\.part(?:-Frag\d+)?|\.ytdl|\.tmp|\.temp)$/iu.test(entry.name)
    ) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function metadataFor(
  outputPath: string,
  filePath: string,
  fileSize: number,
): ArtifactMetadata {
  const extension = extname(filePath).slice(1).toLowerCase();
  return {
    relativePath: relative(outputPath, filePath).split("\\").join("/"),
    fileName: basename(filePath),
    fileExtension: extension,
    mimeType: MIME_TYPES[extension] ?? "application/octet-stream",
    fileSize,
  };
}

export async function runInvocation<T>(
  input: InvocationInput,
  transferArtifact: ArtifactTransfer<T>,
): Promise<InvocationOutcome<T>> {
  const startedAt = Date.now();
  let workspacePath: string | undefined;
  let childProcessGroupId: number | undefined;
  let terminationPromise: Promise<void> | undefined;
  let cancelled = false;
  const requestCancellation = (): void => {
    cancelled = true;
    if (childProcessGroupId !== undefined) {
      terminationPromise ??= terminateProcessGroup(childProcessGroupId);
    }
  };
  const throwIfCancelled = (): void => {
    if (cancelled) {
      throw new InvocationCancelledError("The n8n execution was cancelled.");
    }
  };
  input.signal?.addEventListener("abort", requestCancellation, { once: true });
  if (input.signal?.aborted) {
    requestCancellation();
  }

  try {
    throwIfCancelled();
    await scavengeAbandonedWorkspaces();
    throwIfCancelled();
    workspacePath = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
    const ownerMarker: WorkspaceOwnerMarker = {
      schemaVersion: 1,
      nodeVersion: 1,
      pid: process.pid,
      processStartIdentity: await processStartIdentity(process.pid),
    };
    await writeFile(
      join(workspacePath, OWNER_MARKER_NAME),
      JSON.stringify(ownerMarker),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    throwIfCancelled();
    const outputPath = join(workspacePath, "output");
    const temporaryPath = join(workspacePath, "temp");
    const privatePath = join(workspacePath, "private");
    await Promise.all([
      mkdir(outputPath, { mode: 0o700 }),
      mkdir(temporaryPath, { mode: 0o700 }),
      mkdir(privatePath, { mode: 0o700 }),
    ]);
    throwIfCancelled();
    const cookieContent = input.cookieContent;
    const cookiePath = cookieContent
      ? join(privatePath, "cookies.txt")
      : undefined;
    if (cookiePath !== undefined && cookieContent !== undefined) {
      await writeFile(cookiePath, cookieContent, { flag: "wx", mode: 0o600 });
      throwIfCancelled();
    }
    const invocationWorkspace: InvocationWorkspace = {
      outputPath,
      temporaryPath,
      privatePath,
      ...(cookiePath === undefined ? {} : { cookiePath }),
    };
    const argv =
      typeof input.argv === "function"
        ? input.argv(invocationWorkspace)
        : input.argv;

    const childEnvironment = createChildEnvironment(
      workspacePath,
      outputPath,
      temporaryPath,
      input.executablePath,
    );
    const child = spawn(input.executablePath, argv, {
      cwd: workspacePath,
      detached: true,
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcessGroupId = child.pid;
    const redactionSecrets = [
      ...input.secretValues,
      ...extractProxySecrets(childEnvironment),
    ];
    const stdoutCapture = new RedactingStreamCapture(redactionSecrets);
    const stderrCapture = new RedactingStreamCapture(redactionSecrets);
    child.stdout.on("data", (chunk: Buffer) => stdoutCapture.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrCapture.write(chunk));

    let timedOut = false;
    const requestTimeout = (): void => {
      timedOut = true;
      if (childProcessGroupId !== undefined) {
        terminationPromise ??= terminateProcessGroup(childProcessGroupId);
      }
    };
    const timeout =
      input.timeoutSeconds > 0
        ? setTimeout(requestTimeout, input.timeoutSeconds * 1000)
        : undefined;

    const processResult = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: Error;
    }>((resolveProcess) => {
      child.once("error", (error) =>
        resolveProcess({ exitCode: null, signal: null, spawnError: error }),
      );
      child.once("close", (exitCode, signal) =>
        resolveProcess({ exitCode, signal }),
      );
    });

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await terminationPromise;

    if (cancelled) {
      throw new InvocationCancelledError("The n8n execution was cancelled.");
    }

    const artifacts: Array<InvocationArtifact<T>> = [];
    for (const filePath of await listRegularFiles(outputPath)) {
      if (input.signal?.aborted) {
        throw new InvocationCancelledError("The n8n execution was cancelled.");
      }
      const fileStat = await stat(filePath);
      const metadata = metadataFor(outputPath, filePath, fileStat.size);
      artifacts.push(await transferArtifact(filePath, metadata));
    }
    if (input.signal?.aborted) {
      throw new InvocationCancelledError("The n8n execution was cancelled.");
    }

    const stdout = stdoutCapture.finish();
    const stderr = stderrCapture.finish();
    const succeeded =
      !timedOut &&
      processResult.spawnError === undefined &&
      processResult.exitCode === 0;
    const error = timedOut
      ? { message: "The packaged yt-dlp process exceeded its timeout." }
      : processResult.spawnError
        ? { message: "The packaged yt-dlp process could not be started." }
        : succeeded
          ? null
          : { message: "The packaged yt-dlp process failed." };

    return {
      result: {
        status: timedOut ? "timed_out" : succeeded ? "succeeded" : "failed",
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes: stdout.originalBytes,
        stderrBytes: stderr.originalBytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        artifactCount: artifacts.length,
        toolchain: input.toolchain,
        error,
      },
      artifacts,
    };
  } finally {
    input.signal?.removeEventListener("abort", requestCancellation);
    if (workspacePath !== undefined) {
      await rm(workspacePath, { force: true, recursive: true });
    }
  }
}
