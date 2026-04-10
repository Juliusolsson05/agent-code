# cc-shell testbench

A standalone, isolated workbench for spawning Claude Code, capturing every
byte / snapshot / JSONL entry it produces, and iterating on parsers
**offline** against recorded sessions.

The testbench uses the same `ClaudeSession` class that powers the Electron
app (`src/core/runtime/claudeSession.ts`), so any parser/extraction logic
you validate against a fixture here will behave identically in production.

---

## Recording a session

```sh
npm run record
```

Spawns `claude` in a real PTY and bridges it to your current terminal — you
type, CC responds, just like running `claude` directly. Meanwhile every
event is captured to `recordings/<timestamp>/`:

```
recordings/2026-04-10T15-42-13-456Z/
├── meta.json          # cwd, terminal size, start time
├── raw.txt            # full ANSI byte stream from the PTY
├── raw.events.jsonl   # same bytes with millisecond timestamps (for time-faithful replay)
├── snapshots.jsonl    # periodic headless-terminal screen text
└── jsonl.jsonl        # every JSONL entry CC appended to its transcript
```

Press **Ctrl-Q** to stop recording cleanly. Ctrl-C is forwarded to CC
(it cancels the current generation, same as in cc-shell).

Override the working directory:

```sh
CC_SHELL_CWD=/path/to/some/repo npm run record
```

---

## Replaying a recording

```sh
npm run replay -- recordings/2026-04-10T15-42-13-456Z
```

Loads `raw.events.jsonl`, feeds the bytes into a fresh `@xterm/headless`
terminal, snapshots the final screen, and prints both the raw screen and
the output of every parser in `src/core/parsers/`. Use this to iterate on
the chrome-stripping heuristic without re-running CC.

For a frame-by-frame view of how the screen evolved (long output):

```sh
npm run replay -- recordings/2026-04-10T15-42-13-456Z --frames
```

---

## Why this exists

The hard part of cc-shell isn't spawning CC — it's reverse-engineering
which bytes in CC's TUI output represent the assistant's actual response
versus the bordered input box, the slash-command picker, the spinner,
the status bar, etc. These boundaries shift between CC releases. Without
a fixture-based test loop, every change requires re-spawning CC and
manually verifying the UI looks right — slow and not reproducible.

The testbench gives us:

1. **Reproducible inputs** — record once, replay forever.
2. **Pure parsers** — `src/core/parsers/` has no Node, no DOM, no Electron.
   Replay calls them directly.
3. **A fixture corpus** — `recordings/` accumulates real sessions we can
   regression-test parsers against as we evolve them.

---

## What lives where

| Concern | Path |
|---|---|
| Pure types / parsers | `src/core/types/`, `src/core/parsers/` |
| Node-only runtime (PTY, JSONL tail, ClaudeSession) | `src/core/runtime/` |
| Electron main shell | `src/main/index.ts` |
| Electron renderer (React) | `src/renderer/src/` |
| Standalone testbench | `testbench/` |

The testbench imports directly from `src/core/`. The Electron app does
the same. Only `src/main/` and `src/renderer/` are host-specific.
