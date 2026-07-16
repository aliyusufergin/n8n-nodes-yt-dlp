# Use n8n failure semantics

A non-zero or signaled invocation will raise a `NodeOperationError` and stop processing by default. With Continue On Fail enabled, the node will instead emit a failed execution result, continue with later input items, discard incomplete files, and emit any artifacts that were fully finalized before the failure; yt-dlp's own ignore-errors behavior remains governed by its eventual process exit code.
