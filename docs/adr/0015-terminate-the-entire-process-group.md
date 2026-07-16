# Terminate the entire process group

Each invocation will run in its own Linux process group and subscribe to n8n's execution cancellation signal. Cancellation will terminate yt-dlp and descendants with SIGTERM followed by SIGKILL after five seconds, will never be converted by Continue On Fail, and will always trigger workspace cleanup; an optional per-invocation timeout, disabled by default, will use the same termination path but follow ordinary invocation failure semantics.
