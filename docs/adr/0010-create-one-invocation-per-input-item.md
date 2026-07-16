# Create one invocation per input item

Each incoming n8n item will create one invocation whose argument line is resolved in that item's expression context. Its execution result and zero or more download artifacts will retain paired-item links to that source item; playlists or multiple URLs placed in one argument line remain part of the same invocation.
