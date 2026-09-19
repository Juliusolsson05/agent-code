# third_party/opencode

Pinned runtime artifact: the `opencode` CLI binary, shipped with packaged
Agent Code so OpenCode panes work on a fresh install with no user setup.
Without it the CLI must already be on PATH — and a Finder-launched app
never sources the shell rc where `~/.opencode/bin` gets added (see the
related installed-app PATH fallout in #993, and the bundling issue #994).

See issues [#119](https://github.com/Juliusolsson05/agent-code/issues/119)
(mitmdump) and [#120](https://github.com/Juliusolsson05/agent-code/issues/120)
(tmux) for the bundling pattern this follows.

## Source

Upstream [`anomalyco/opencode`](https://github.com/anomalyco/opencode)
official release assets. Each pinned `.zip` contains exactly one
`opencode` executable (a Bun-compiled Mach-O linking only system dylibs:
libSystem, libc++, libicucore, libresolv — verified with `otool -L`, so
the verify script's no-Homebrew linkage gate stays meaningful).

WHY the release zip and not the npm package (`opencode-ai`):

- The zip IS the artifact upstream ships as the standalone binary; npm
  would add a package-tree walk plus a postinstall that downloads the
  same binary anyway, and the npm copy is exactly what
  `cliUpdateOrchestrator`-style flows manage separately.
- Release zips are checksum-pinnable per-asset; an npm tarball's inner
  binary changes shape with the package's packaging scripts.
- Identical lifecycle to tmux/cloudflared: fetch → hash-verify → extract
  → ship, with the manifest as the single source of truth.

WHY `x64-baseline` for Intel Macs: the baseline build makes no AVX2
assumption, so one artifact covers every x86_64 Mac including pre-Haswell
machines. For a CLI spawned intermittently the perf delta is noise, and
in the releases inspected so far the non-baseline and baseline assets
were byte-identical anyway.

## What is committed

```
third_party/opencode/
  manifest.json   pinned version, per-arch archive sha256 + bytes + binary sha256
  README.md       this file
  LICENSE.md      upstream MIT license
  .gitignore      keeps cache/ out of git
```

## What is NOT committed

The downloaded zip and the extracted binary live under
`third_party/opencode/cache/<platform>-<arch>/` and are produced on
demand by `scripts/runtime-tools/fetch-opencode.mjs`. Binaries never
enter git; the manifest plus the fetch script is the single source of
truth.

## How to fetch / verify locally

```
npm run runtime:fetch:opencode
npm run runtime:verify
```

`fetch-opencode.mjs` downloads the pinned zip into a temp location,
verifies the archive sha256 + byte size against `manifest.json`,
extracts the inner `opencode` executable into
`third_party/opencode/cache/<platform>-<arch>/opencode`, re-verifies the
extracted binary's own sha256, sets the executable bit, and discards the
archive. `verify-opencode.mjs` re-checks the cache (hash + native
`--version` smoke + `otool -L` linkage gate) without re-downloading.

## How version bumps work

A version bump is a single-file PR to `manifest.json`:

1. Edit `version` (keep the `v` prefix out of it — `urlBase` adds it).
2. Download both darwin assets from the matching upstream release,
   compute the archive sha256 + bytes and the extracted binary's
   sha256, and pin all three per platform.
3. CI re-runs `fetch` + `verify` against the new hashes via
   `runtime:prepare:mac`.

The bundled CLI's version therefore moves with Agent Code app updates,
NOT with `opencode`'s own updater — see the note in
`src/shared/types/cliUpdate.ts`.

## License

opencode is MIT licensed; the full text is reproduced in `LICENSE.md`.
