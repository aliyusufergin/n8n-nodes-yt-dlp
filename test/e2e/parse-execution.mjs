export function parseExecutionOutput(rawOutput) {
  const candidates = [rawOutput];
  for (
    let index = rawOutput.indexOf("\n{");
    index !== -1;
    index = rawOutput.indexOf("\n{", index + 2)
  ) {
    candidates.push(rawOutput.slice(index + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // n8n may write startup diagnostics before the --rawOutput JSON.
    }
  }

  throw new Error("n8n execution output did not contain valid JSON");
}
