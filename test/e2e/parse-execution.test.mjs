import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExecutionOutput } from "./parse-execution.mjs";

test("parses plain execution JSON", () => {
  assert.deepEqual(parseExecutionOutput('{"data":{"resultData":{}}}'), {
    data: { resultData: {} },
  });
});

test("ignores n8n startup diagnostics before execution JSON", () => {
  assert.deepEqual(
    parseExecutionOutput(
      'n8n Task Broker ready on 127.0.0.1, port 5679\n{"data":{}}\n',
    ),
    { data: {} },
  );
});
