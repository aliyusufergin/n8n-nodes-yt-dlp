# Bound captured process output

Each execution result will retain at most 1 MiB apiece from stdout and stderr, preserving the first and last 512 KiB with truncation markers and reporting truncation flags and original byte counts. Streams will still be drained continuously but will not be copied into n8n server logs or streamed as live node progress; their redacted content becomes visible only in the completed Result output. Users needing complete large metadata should write it through yt-dlp as a download artifact rather than expanding n8n's JSON execution data without bound.
