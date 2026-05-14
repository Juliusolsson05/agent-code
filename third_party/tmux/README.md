# third_party/tmux

Pinned runtime artifact: a fully **static** `tmux` binary, shipped with
packaged Agent Code builds so terminal-persistence (tmux-backed terminal
panes) works on user machines without any Homebrew install.

See issue [#120](https://github.com/Juliusolsson05/agent-code/issues/120) for
the full plan.

## Why static, not Homebrew

The Homebrew `tmux` binary dynamically links three Homebrew dylibs
(`libevent_core`, `libncursesw`, `libutf8proc`). Copying `/opt/homebrew/bin/tmux`
into the app would fail to launch on a user machine that doesn't have those
exact Homebrew paths. The two reasonable options are:

1. Build static (chosen) — single ~1.5–2 MB binary, no external deps.
2. Copy Homebrew binary + dylibs and rewrite `install_name`s — bigger, more
   moving parts, fragile under codesigning.

This directory captures option 1.

## What is committed

```
third_party/tmux/
  manifest.json   pinned tmux + libevent + ncurses + utf8proc versions
  README.md       this file
  LICENSE.md      tmux ISC license (plus deps' license summary)
  .gitignore      keeps cache/ and build/ out of git
```

## What is NOT committed

```
third_party/tmux/cache/   final static tmux binary per platform/arch
third_party/tmux/build/   transient build inputs/outputs during a static build
```

## Status (PR 1: scaffolding)

The manifest currently has `sha256` placeholders set to `TBD-PR3`. The actual
static build script and source-archive hashes land in PR 3 (issue #120).
PR 1 only establishes the layout, manifest schema, and verifier scaffolding so
PR 3 doesn't have to bikeshed any of that.

## How it will work after PR 3

```
npm run runtime:build:tmux
npm run runtime:verify
```

`build-tmux.mjs` will:

1. Download pinned source tarballs for tmux + libevent + ncurses + utf8proc.
2. Verify each source against `manifest.sources.<name>.sha256`.
3. Configure each with `--enable-static --disable-shared`, build, and link
   tmux against the static libs.
4. Verify the final binary contains no Homebrew dylib references
   (`otool -L bundled/tmux` must show only system libraries).
5. Write the binary to `cache/<platform>-<arch>/tmux` and compute its sha256.

Before declaring success it also runs a lifecycle proof:

```
tmux -V
otool -L cache/<platform>-<arch>/tmux        # must show no /opt/homebrew paths
tmux -L agent-code-build-test -f /dev/null new-session -d -s t /bin/zsh
tmux -L agent-code-build-test send-keys -t t 'echo $TERM; tput cols' Enter
tmux -L agent-code-build-test capture-pane -t t -p
tmux -L agent-code-build-test kill-session -t t
```

If any of those fail, the build fails — we never ship a broken static tmux.

## License

tmux is ISC licensed. `libevent`, `ncurses`, and `utf8proc` ship under
BSD-style / MIT-style licenses. All upstream license texts are reproduced in
`LICENSE.md` so Agent Code's distribution complies with attribution.
