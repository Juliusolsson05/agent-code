# Screen frames: drop spinner-only repaints and alias duplicate strings

Fixes #746. Refs #390, #103.

## Problem

`session:screen` is the highest-volume IPC channel and almost all of it is
redundant. Recording `794dafdd` (13.2 min, one Claude session): 4,728
frames at 6 Hz, 8.3 KB each; `recent === plain` in every frame; 99% of
consecutive frames differ only in the spinner line (glyph rotation, the
elapsed timer, the token counter) or the `/rc connecting…` blink. Today's
recordings confirm the shape: 750/750 Claude frames with `recent === plain`
and 533/750 consecutive pairs differing in one line. Every one of those
frames is cloned through the coalescer, sent to the renderer, committed as
a new runtime object (re-rendering the workspace), forwarded to the remote
client and JSON-stringified by the session recorder.

The headless terminal already gates on EXACT equality of `plain`/`recent`
(`HeadlessTerminal.ts`), which never fires while a spinner animates.

## Design

1. **Volatile-text gate at the manager's `screen` re-emit**
   (`sessionManager.ts`, the one point feeding the forwarder, the remote
   server and the recorder). `normalizeVolatileScreenText` rewrites the
   known-volatile shapes — spinner glyphs at line start (Claude `·✢✳✶✻✽`,
   Codex braille), elapsed timers (`5s`, `1m 9s`), token counters
   (`↓ 1.2k tokens`), the `/rc connecting…` suffix, trailing whitespace —
   to fixed tokens. A frame whose normalized `plain` and `recent` equal the
   last EMITTED frame's is dropped; anything else is emitted RAW (the
   renderer still sees the real spinner on every real change).
   `lastScreenSnapshot` keeps the raw latest for MCP/debug readers and the
   provider sessions' own consumers (composer-ready, prompt gate) run before
   the manager and are untouched. Condition parsers run in the headless
   package on every raw frame.

   WHY normalize-and-compare rather than a time throttle: a throttle still
   emits N frames per second of pure spinner while an agent thinks for
   minutes; the gate emits zero and still passes a composer keystroke or a
   new output line within the same 100 ms tick.

2. **Alias duplicate strings on the renderer wire.** At the IPC edge the
   forwarder omits `recent`/`recentMarkdown` when they equal
   `plain`/`markdown` (`aliasScreenSnapshotForWire`); the preload's
   `onSessionScreen` expands them back (`expandScreenSnapshotFromWire`) so
   every renderer type and consumer is unchanged. The remote server takes
   the full payload from the manager. The session recorder taps the IPC
   send, so recordings carry the wire form; replay treats `session:screen`
   as a no-op tick (`reconstructSlices.ts`) and the redaction pass caps
   fields only when present, so nothing downstream reads the omitted keys.

Not in scope: removing the markdown walks from the headless package
(submodule), and not sending `markdown` unless a debug consumer is mounted.

## Verification

- `screenFrameGate.test.ts`: real spinner/timer/rc lines from recordings
  normalize to the same string across ticks; a composer keystroke, a new
  output line and a picker change are emitted; the first frame is always
  emitted; a session's state is dropped on removal; a frame that changes
  and then ticks emits once.
- Forwarder/preload: an aliased frame arrives in the renderer with
  `recent === plain`; a Codex frame with real scrollback keeps its own
  `recent`.
- `npx tsc -b`; `src/main/sessions`, forwarder and preload suites.
