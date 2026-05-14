# third_party/tmux

Pinned runtime artifact: a `tmux` binary, shipped with packaged
Agent Code so terminal-pane persistence works on user machines
without any Homebrew install.

See issue [#120](https://github.com/Juliusolsson05/agent-code/issues/120)
for the bundling plan; companion to [#119](https://github.com/Juliusolsson05/agent-code/issues/119)
which did the same thing for `mitmdump`.

## Source

Upstream [`tmux/tmux-builds`](https://github.com/tmux/tmux-builds) —
the official prebuilt-binary repo maintained by the tmux project
itself. macOS builds link only to `/usr/lib/libSystem.B.dylib` and
`/usr/lib/libresolv.9.dylib`, which are guaranteed present on every
macOS install. No Homebrew dependencies.

We deliberately do NOT roll our own static build:

- The upstream project already maintains a tested build pipeline.
- Their builds are reproducible from their CI.
- A custom build would mean owning libevent + ncurses + utf8proc
  source pins, configure flags, terminfo data handling, and codesign
  — all for a 1.6 MB binary that already exists upstream.

The lifecycle proof script that originally motivated the static-build
investigation (`tmux -V`, `new-session`, `send-keys`, `capture-pane`,
`kill-session` all work without external dependencies, and `tput
cols` inside the session returns a real number proving terminfo is
healthy) passed cleanly against the upstream binary, so we adopt it
as-is.

## What is committed

```
third_party/tmux/
  manifest.json   pinned version, per-arch archive sha256 + bytes
  README.md       this file
  LICENSE.md      tmux ISC license
  .gitignore      keeps cache/ out of git
```

## What is NOT committed

The downloaded archive and the extracted binary live under
`third_party/tmux/cache/<platform>-<arch>/` and are produced on
demand by `scripts/runtime-tools/fetch-tmux.mjs`. Binaries never
enter git; the manifest plus the fetch script is the single source
of truth.

## How to fetch / verify locally

```
npm run runtime:fetch:tmux
npm run runtime:verify
```

`fetch-tmux.mjs` downloads the pinned archive into a temp location,
verifies the sha256 against `manifest.json`, extracts the inner
`tmux` executable into `third_party/tmux/cache/<platform>-<arch>/tmux`,
sets the executable bit, and discards the archive. The verify
script re-checks the cache without re-downloading.

## How version bumps work

A version bump is a single-file PR to `manifest.json`:

1. Edit `version`.
2. Recompute each archive sha256 from the corresponding
   `tmux-<ver>-macos-<arch>.tar.gz` asset on the matching
   `tmux/tmux-builds` release.
3. Update `bytes` to match.
4. CI re-runs `fetch` + `verify` against the new hashes.

That keeps the binary out of git history while making upgrades
trivial to review.

## License

tmux is ISC licensed; the full text is reproduced in `LICENSE.md`.
The upstream `tmux/tmux-builds` releases also ship a
`LICENSES.tar.gz` covering the build-dependency licenses (libevent,
ncurses, utf8proc); when we update the bundled binary we re-vet
those licenses match what we ship.
