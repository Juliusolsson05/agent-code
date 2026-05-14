# third_party/mitmproxy

Pinned runtime artifact: `mitmdump` from the upstream
[mitmproxy](https://mitmproxy.org/) project, shipped with packaged Agent Code
builds so the Claude proxy streaming path does not require a user-installed
Homebrew mitmproxy.

## Why this exists

Claude proxy streaming spawns `mitmdump` to MITM Anthropic's `/v1/messages`
SSE responses. Depending on a user-installed Homebrew mitmproxy adds setup
friction and creates packaged-app failures when the user's `PATH`, install
location, or mitmproxy version differs from the development machine. Bundling
also pins the proxy behaviour to a known tested version so updates are an
intentional, reviewable manifest change rather than something that floats with
each user's Homebrew state.

See issue [#119](https://github.com/Juliusolsson05/agent-code/issues/119) for
the full plan.

## What is committed

```
third_party/mitmproxy/
  manifest.json   pinned version + per-arch sha256 + URL template
  README.md       this file
  LICENSE.md      mitmproxy MIT license
  .gitignore      keeps cache/ out of git
```

## What is NOT committed

The actual binary archive lives under `cache/<platform>-<arch>/` and is
fetched on demand by `scripts/runtime-tools/fetch-mitmproxy.mjs`. Cache
contents must never be committed — repo size stays small, and the manifest
plus the verifier script are the single source of truth.

## How to fetch / verify locally

```
npm run runtime:fetch:mitmproxy
npm run runtime:verify
```

`fetch-mitmproxy.mjs` downloads the pinned archive into
`third_party/mitmproxy/cache/<platform>-<arch>/`, verifies the sha256 against
`manifest.json`, and refuses to write any file that doesn't match. The verify
script just re-checks an existing cache without re-downloading.

## How version bumps work

A version bump is a single-file PR to `manifest.json`:

1. Edit `version`.
2. Recompute the sha256 of each platform archive with
   `shasum -a 256 mitmproxy-<ver>-macos-<arch>.tar.gz`.
3. Update each platform entry (`sha256`, `bytes`).
4. CI re-runs `fetch` + `verify` against the new hashes.

That keeps the binary out of git history while making upgrades trivial to
review. The optional `scripts/runtime-tools/bump-mitmproxy.mjs` can write
this PR for you from the latest upstream release.

## License

mitmproxy is MIT licensed. The license text is reproduced in `LICENSE.md`
exactly as published upstream so Agent Code's distribution complies with the
attribution requirement.
