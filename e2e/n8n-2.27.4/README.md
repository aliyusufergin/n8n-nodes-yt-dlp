# n8n 2.27.4 queue-mode acceptance lane

This disposable lane installs the exact locally packed `0.2.0` package chain
through n8n's real Community Packages REST controller. It runs unmodified n8n
2.27.4 main and worker containers with Postgres, Redis, queue mode, offloaded
manual executions, and database binary storage.

The hermetic registry is available only inside the disposable Docker network.
It presents the exact packed tarballs at n8n's default
`https://registry.npmjs.org` address using a run-specific CA. This exercises
the normal unlicensed registry path without publishing, unpacking packages
into n8n volumes, changing the n8n image, or enabling lifecycle scripts.

Run:

```bash
npm run test:e2e:n8n-2.27.4
```

The lane requires Linux x64, OpenSSL, and a Docker daemon. It uses ports 15678
and 18080 by default; override them with `E2E_N8N_PORT` and
`E2E_FIXTURE_PORT`.

On success, bounded evidence is written to
`.generated/evidence/n8n-2.27.4.json`. It records:

- the exact n8n linux/amd64 image digest;
- SHA-256 and sizes for the main, selector, and Linux-x64 tarballs;
- exact package state in both main and worker;
- production/manual Result equivalence and database binary IDs;
- direct, FFmpeg, playlist, credential/proxy, Continue On Fail, cancellation,
  resource/output limit, Nth-transfer, pruning, log, and cleanup outcomes.

The output-limit proof is the approved controlled-process seam because the V1
workflow surface cannot intentionally make the immutable packaged yt-dlp emit
eight MiB of process output. All other listed scenarios run through the real
queue worker. The stack and all named volumes are removed in `finally`; the
ignored `.generated` directory contains only local tarballs, fixtures,
run-specific certificates, registry request logs, and evidence.

This lane does not claim public-registry acceptance. Issue #21 publishes the
immutable chain under `next`; issue #22 reruns the release matrix against those
public bytes.
