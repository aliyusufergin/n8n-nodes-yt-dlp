# Test Adapters

A test Adapter is anything a test substitutes for a real collaborator: a fixture executable
standing in for the packaged yt-dlp, a synthetic origin standing in for a media host, a stubbed
`IExecuteFunctions` standing in for the n8n engine.

Two rules bind every Adapter in this repository. Both come from #52, where a real classification
bug shipped past a green unit suite and a green regression test.

## 1. An Adapter may not be more forgiving than production

An Adapter has to behave at least as strictly as the thing it replaces, on every property the
test depends on. A permissive Adapter passes inputs that production would reject, so the test
reports success the system would not.

The concrete case: `test/real-toolchain.test.ts` served fixture media without `content-length`,
so Node answered chunked. A real origin advertises the size of a static file. yt-dlp could not
learn the size before downloading, the Resource Envelope's pre-download path was never taken, and
the first regression test written for #52 passed **against the unfixed node**.

In practice:

- A synthetic origin advertises `content-length` for a static body, as a real origin does.
- A fixture executable honours the parts of the option profile the test depends on.
- A stub that returns a value production could not return is a defect in the test, not a
  convenience.

## 2. An Adapter may not sit below the layer under test

The Adapter goes at a boundary that really exists — a process, a socket, an n8n helper. If it is
placed underneath a layer the test claims to cover, that layer never runs and the test says
nothing about it.

The concrete case: the Artifact budget tests in `test/download.test.ts` replace yt-dlp with a
fixture executable that writes an oversized file straight into the Artifact Directory. The
Adapter is below the yt-dlp option profile, which is itself part of how the single-Artifact
budget is enforced. Those tests pin `validateArtifactSet` and nothing more; they cannot see
whether a violation is observable at all. #52 was invisible to them by construction.

In practice:

- Name the test after the layer it actually exercises, not the behaviour you wish it covered.
- When an invariant spans two layers, one test has to run **both** of them. For the Resource
  Envelope that seam is `test/real-toolchain.test.ts`: real packaged yt-dlp, real option profile,
  real post-hoc Artifact checks, without the full n8n stack.

## Choosing the seam

| Test file | Adapter | What it can pin |
|---|---|---|
| `test/download.test.ts` | fixture executable in place of yt-dlp | workspace layout, Artifact Directory validation, argv the plan produces |
| `test/process.test.ts` | fixture executable in place of yt-dlp | process group lifecycle, output bounds, exit-code classification |
| `test/real-toolchain.test.ts` | synthetic origin only | option profile and Artifact validation **together**, against real yt-dlp |
| `e2e/release-gate/` | none | published tarballs on a real n8n |

If a change spans two rows, the test belongs in the lower row.

## When the misplaced Adapter stays

Rule 2 asks where a test's Adapter sits, not that every Adapter be removed. A test whose Adapter
is below the layer under test has two honest outcomes: move it up, or narrow what it claims and
add a test at the real seam.

The Artifact budget cases in `test/download.test.ts` took the second path deliberately. They pin
`validateArtifactSet`'s own arithmetic — the count boundary at 20 and 50, the size boundary to the
byte, the running total across several Artifacts — and reproducing those against real yt-dlp would
mean downloading hundreds of MiB per case. They keep the fixture executable, say `validates`
rather than `enforces`, and the pair they cannot see is covered in `test/real-toolchain.test.ts`.

What the rule forbids is the third outcome: leaving the Adapter where it is and letting the test
keep its original claim.
