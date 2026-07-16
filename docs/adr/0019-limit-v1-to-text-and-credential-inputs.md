# Limit v1 to text and credential inputs

The first release will accept an argument line resolved from each input item plus an optional Secrets credential. Cookie content materialized from that credential is the only staged input file. Options that require an existing arbitrary file—including batch files, info JSON input, configuration files, netrc, or host paths—will be restricted, and incoming n8n binary data will not be mapped into the execution workspace. A future explicit staged-input interface can be designed if concrete use cases justify its additional path and lifecycle rules.
