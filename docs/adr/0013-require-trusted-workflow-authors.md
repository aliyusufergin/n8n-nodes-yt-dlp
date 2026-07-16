# Require trusted workflow authors

The node will be documented for trusted workflow authors only and will not claim application-level SSRF isolation or expose itself as an AI tool. Because yt-dlp performs direct extractor, redirect, and media requests outside n8n's HTTP helpers, partial URL checks would not reliably constrain its network access; deployments that require isolation must enforce egress policy around the n8n container.
