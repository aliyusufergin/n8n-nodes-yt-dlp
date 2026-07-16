# Keep the v1 node interface minimal

The first node interface will expose one required expression-capable multiline Arguments field, one optional Timeout Seconds field whose zero default disables the per-invocation timeout, and the optional yt-dlp Secrets credential. It will have fixed Result and Artifacts outputs. It will not duplicate yt-dlp's CLI as resource, operation, URL, format, or option controls; its descriptions will instead define that Arguments excludes the executable name, uses the supported argument grammar, is resolved once per input item, and is subject to the option catalog.
