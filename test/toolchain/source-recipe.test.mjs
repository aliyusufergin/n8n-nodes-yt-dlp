import assert from "node:assert/strict";
import { test } from "node:test";

import { inspectSourceRecipe } from "../../toolchain/source-recipe.mjs";

const sha256 = "a".repeat(64);

test("resolves every hash-verified archive used by a build recipe", () => {
  const recipe = `
ARG LIB_VERSION=1.2.3
ARG LIB_URL="https://example.invalid/lib-$LIB_VERSION.tar.xz"
ARG LIB_SHA256=${sha256}
RUN wget -O lib.tar.xz "$LIB_URL" && echo "$LIB_SHA256 lib.tar.xz" | sha256sum -c -
`;

  assert.deepEqual(inspectSourceRecipe(recipe, []), {
    archives: [
      {
        name: "LIB",
        sha256,
        url: "https://example.invalid/lib-1.2.3.tar.xz",
        version: "1.2.3",
      },
    ],
    gitSources: [],
  });
});

test("rejects an archive download without a paired digest", () => {
  const recipe = `
ARG LIB_URL="https://example.invalid/lib.tar.xz"
RUN wget -O lib.tar.xz "$LIB_URL"
`;

  assert.throws(() => inspectSourceRecipe(recipe, []), /LIB_URL.*SHA-256/u);
});

test("rejects a direct download that bypasses the hash lock", () => {
  const recipe = `RUN curl -LO https://example.invalid/source.tar.gz`;

  assert.throws(
    () => inspectSourceRecipe(recipe, []),
    /unreviewed direct download/u,
  );
});

test("rejects a network download hidden behind a non-URL build argument", () => {
  const recipe = `
ARG LIB_SOURCE=https://example.invalid/source.tar.gz
ARG LIB_SOURCE_SHA256=${sha256}
RUN wget "$LIB_SOURCE"
`;

  assert.throws(
    () => inspectSourceRecipe(recipe, []),
    /unreviewed network variable/u,
  );
});

test("rejects a git clone that is absent from the reviewed source lock", () => {
  const recipe = `RUN git clone https://example.invalid/library.git`;

  assert.throws(() => inspectSourceRecipe(recipe, []), /unreviewed git clone/u);
});

test("requires the reviewed git commit to be pinned by the recipe", () => {
  const recipe = `
ARG LIB_URL=https://example.invalid/library.git
ARG LIB_COMMIT=${"b".repeat(40)}
RUN git clone "$LIB_URL" && git checkout $LIB_COMMIT
`;
  const reviewed = [
    {
      commit: "c".repeat(40),
      name: "library",
      url: "https://example.invalid/library.git",
    },
  ];

  assert.throws(
    () => inspectSourceRecipe(recipe, reviewed),
    /reviewed commit.*not pinned/u,
  );
});

test("audits a reviewed git URL even when its argument name is not suffixed URL", () => {
  const commit = "c".repeat(40);
  const recipe = `
ARG REPOSITORY=https://example.invalid/library.git
ARG LIB_COMMIT=${commit}
RUN git clone "$REPOSITORY" && git checkout $LIB_COMMIT
`;
  const reviewed = [
    {
      commit,
      name: "library",
      url: "https://example.invalid/library.git",
    },
  ];

  assert.deepEqual(inspectSourceRecipe(recipe, reviewed).gitSources, reviewed);
});
