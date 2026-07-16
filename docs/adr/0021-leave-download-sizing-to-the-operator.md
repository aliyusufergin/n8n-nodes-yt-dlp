# Leave download sizing to the operator

The node will not impose an undisclosed per-file or total download-size ceiling. Trusted workflow authors will bound work with yt-dlp's own selection and size options when needed, while deployment operators remain responsible for container disk quotas, execution capacity, n8n binary-data storage, and pruning. Documentation will warn that downloads and FFmpeg intermediates must fit in the temporary workspace and that transferring an artifact can briefly require space in both the workspace and n8n storage.
