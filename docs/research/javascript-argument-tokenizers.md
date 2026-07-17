# JavaScript argument tokenizer evaluation

Accessed: 2026-07-17

## Version anchors

- [`string-argv@0.3.2`](https://www.npmjs.com/package/string-argv/v/0.3.2), npm git head [`de7ecea79c0bbb9f5f81437b6fb4ba3c56c6b3ff`](https://github.com/mccormicka/string-argv/tree/de7ecea79c0bbb9f5f81437b6fb4ba3c56c6b3ff), npm integrity `sha512-aqD2Q0144Z+/RqG52NeHEkZauTAUWJO8c6yTftGJKO3Tja5tUgIfmIl6kExvhtxSDP7fXB6DvzkfMpCd/F3G+Q==`.
- [`shell-quote@1.10.0`](https://www.npmjs.com/package/shell-quote/v/1.10.0), npm git head [`64988d9a0e73a2ae710488952e3614958ef289d4`](https://github.com/ljharb/shell-quote/tree/64988d9a0e73a2ae710488952e3614958ef289d4), npm integrity `sha512-w1aiOKwKuRgtwAReIIj89puqg+I7GvX4IbLrvmhXbzQsj1+Zwi4VO3+fa6ZF91TWSjIxoEkKnMeHcLEODK5ZXA==`.

## Findings

1. **Kanıtlanmış platform gerçeği:** `string-argv@0.3.2` uses a regular expression to extract quoted and unquoted fragments. It does not implement the required backslash grammar or explicit unmatched-quote error, and its own tests preserve quotes in some `--key="value"` tokens. Source: [`index.ts`](https://github.com/mccormicka/string-argv/blob/de7ecea79c0bbb9f5f81437b6fb4ba3c56c6b3ff/index.ts) and [`Index.spec.js`](https://github.com/mccormicka/string-argv/blob/de7ecea79c0bbb9f5f81437b6fb4ba3c56c6b3ff/test/Index.spec.js).

2. **Kanıtlanmış platform gerçeği:** `shell-quote@1.10.0` deliberately parses environment substitutions, shell control operators, comments, and glob patterns into non-string results. Those semantics are broader than the product grammar. Source: [`parse.js`](https://github.com/ljharb/shell-quote/blob/64988d9a0e73a2ae710488952e3614958ef289d4/parse.js).

3. **Kanıtlanmış platform gerçeği:** Node.js `child_process.spawn()` accepts a command plus an argv array. A shell is not used unless requested with the `shell` option. Source: [Node.js child process documentation](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options), rolling official documentation accessed 2026-07-17.

4. **Ürün kararı:** Neither inspected tokenizer is a runtime dependency. v1 implements the smaller Arguments Grammar directly and passes its validated argv to `spawn` with `shell: false`.

5. **Ürün kararı:** Arguments is limited to 16 KiB, 256 tokens, and 8 KiB per token. CR, LF, NUL, unmatched quotes, trailing escapes, positional tokens, `--`, short clusters, and attached short-option values are rejected before process launch.

6. **E2E ile doğrulanacak varsayım:** A small lexer is easier to audit than adapting shell semantics, but its correctness is not established by design alone. Table, round-trip, property, fuzz, and injection corpus tests plus exact argv observation in a controlled fake executable are required.
