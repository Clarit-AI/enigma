# Native artifact provenance

`plugins/enigma/native/<os>-<arch>/index-lock.node` is built **from this
repository's source** by `scripts/build-native.mjs`; nothing here is
vendored as a third-party binary. Per-artifact provenance lives in the
sibling `manifest.json` (toolchain string, exact compile command, build
host, `builtAt`, `binarySha256`, `sourceSha256`, and for linux the
`readelf --version-info` glibc symbol-version audit).

## What is vendored (headers only)

`native/include/*.h` are the official Node.js N-API headers, unmodified:

| file | sha256 |
|---|---|
| `js_native_api.h` | `89393f07881fcba3ed097a5989fba1746f1c2cf611f19ba4dcb17071da8a661e` |
| `js_native_api_types.h` | `0410c31e227f81e2981363c4d543f4832ac3df785343ec64cee621742ff8a034` |
| `node_api.h` | `cf2446da4783a707dc9399321cff3ea28dce86fafdf38746fc47f1b293f5a040` |
| `node_api_types.h` | `8d5d854088d5725fec9775510e0aeeeb790a41ad083c49bb721d950b86e6bd61` |

Source: `https://nodejs.org/download/release/v20.19.4/node-v20.19.4-headers.tar.gz`
(sha256 `e8140a84f5b6974bc363c96376d2dd7dd8d75f92a40d6c906e37e04220b87791`),
extracted from `include/node/`. License: Node.js (MIT + others SPDX), the
API surface is frozen by N-API's ABI-stability contract. Vendoring the
headers instead of downloading at build time keeps builds offline and
reviewable.

## What is NOT claimed

- **`sourceSha256` is staleness metadata, not proof.** It detects "the
  native sources changed after this artifact was built" (the enforceable
  staleness check `scripts/check-native.mjs` runs on every gate). It does
  **not** prove the committed bytes were produced from these sources —
  binary builds are not byte-reproducible across toolchains, so no
  byte-parity claim is made anywhere.
- **`binarySha256` pins the shipped bytes** — `check:native` re-hashes the
  committed artifact and fails on mismatch, and the **committed** artifact
  is what gets `dlopen`-loaded and exercised in CI on each platform. A
  fresh rebuild passing its own smoke does **not** validate what a
  marketplace install ships; CI runs the committed-artifact check first and
  labels any rebuild smoke separately.
- No fs-ext / NAN / node-gyp dependency exists at runtime or in
  `node_modules`; the only build tools are the platform C compiler and
  (for linux cross-builds from this workstation) Docker.
