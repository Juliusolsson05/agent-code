# Terminal throughput: route PTY data once and render with WebGL

Fixes #768. Refs #103, #390, #745, #749, #760.

## Expanded evidence and scope

The 2026-09-04 follow-up trace (25.3 minutes) contained 5,369 feed-debug
appends, up to 656 ms of elapsed IPC/write latency per append. Address #748
in a separate implementation commit: flush from the latest runtime refs on a
one-second cadence, preserve the existing one-in-flight and durable cursor
rules, retry on the next tick after failure, and best-effort flush on teardown.
Do not immediately drain on completion or reschedule the timer on every render.
This accepts up to one second of additional diagnostic loss on abrupt crash;
transcripts and ghost recovery writes are independent and unchanged.

Also address the disabled-telemetry sampling part of #767: return before
traversal/stringification when performance collection is disabled. Cap each
collection at exactly 64 samples (the current floor-step loop can take 127).
Verify both disabled zero-work and enabled bounded-sampling contracts.

The supplied startup log also proves a second main/preload/renderer build
after `build:app` completes (#779). Installed electron-vite preview builds by
default. Retain the complete build/resource pipeline, then use preview's
`--skipBuild` flag; protect build-before-launch and no-duplicate-build in a
package-script contract test. This is a startup-only fix, not evidence of live
terminal latency improvement.

## Problem

A live 2026-09-04 run had one Claude raw terminal with unusably low frame rate
and delayed input while Agent Code owned 57 child processes. The provider load
and host memory pressure make the symptom worse, but the renderer has two
independent multipliers of its own:

- Every mounted xterm host installs a listener on a renderer-global PTY IPC
  channel, then rejects events for other session ids inside its callback. With
  N terminals, every Claude repaint enters N callbacks even though one terminal
  owns the bytes. The preload contract already says each event type must have
  one subscription per renderer; the consumers violate that contract.
- All three hosts use xterm's DOM renderer. Claude repaints most of its viewport
  inside synchronized-update brackets, so a busy frame can rebuild dozens of
  rows and hundreds of spans. Electron already has a GPU process, but xterm is
  not using it.

The replay-input work in #745/#749 removed thousands of stale query replies and
coalesced outgoing input. It deliberately did not change live inbound fanout or
the renderer backend, so those costs remain on every repaint.

## Design

### One keyed dispatcher per raw PTY channel

Add a renderer-owned session-data dispatcher with one underlying preload
subscription for `session:terminal-data` and one for
`session:agent-pty-data`. Hosts register a callback under their session id;
the dispatcher looks up that id before invoking any host code.

The dispatcher keeps the underlying listener for the renderer lifetime after
its first subscriber. Terminal panes mount and unmount frequently, and
churning the global IPC listener adds unnecessary preload setup/cleanup. The
dispatcher does not buffer unowned data; attach/backfill still owns replay.
Per-session registrations still unsubscribe immediately,
and an empty key is removed from the map so detached sessions retain no host
closures.

### Shared WebGL lifecycle with a safe DOM fallback

Load `@xterm/addon-webgl` from one shared helper after `Terminal.open()`. The
addon is imported asynchronously so feed-only windows do not pay its startup
bundle cost. A host-generation guard must prevent a late import from attaching
to a disposed terminal. If construction/loading fails, or the WebGL context is
lost, dispose only the addon and leave the terminal alive on xterm's DOM
fallback. Terminal correctness and input must never depend on GPU support.

All three xterm hosts use the same helper. This keeps the fallback invariant in
one place now and gives the terminal-registry work in #760 one lifecycle seam
to adopt later.

### Explicit non-goals

- Do not solve terminal remount/replay ownership; #760 owns persistent xterm
  instances and #766 owns screen-state attach.
- Do not change the main-to-renderer PTY chunk cadence in this slice. A single
  dispatcher removes the N-way callback multiplication without adding a new
  buffering/latency policy.
- Do not treat Vite's feed-markdown dynamic-import warning as the cause of live
  terminal stalls. It affects chunking/startup and should be handled separately
  from the PTY hot path.

## Verification

Generation slices (shared implementations and final signatures stay parent-owned):

- Mounted-host coverage: `AgentTerminalLeaf.dimensionOwnership.renderer.test.tsx`
  exercises keyed PTY delivery across simultaneous agent/inline/shell hosts,
  replay/input preservation, and cleanup.
- GPU lifecycle coverage: `xtermWebglRenderer.test.ts` exercises successful
  activation, disposal, context loss, failed activation, and imports resolving
  after teardown against `attachXtermWebglRenderer`'s existing contract.

- Unit tests prove one underlying channel subscription serves many session
  handlers, routes only to the matching id, removes per-session closures, and
  does not churn the global listener after the map becomes empty.
- Unit tests prove the WebGL lifecycle attaches only to a live terminal and
  disposes cleanly on context loss, host teardown, import failure, construction
  failure, and terminal load failure.
- Existing terminal host renderer tests prove attach/replay/input and dimension
  ownership behavior remain intact.
- TypeScript, focused Vitest projects, and a production package build pass.
- The production build emits the WebGL addon as a lazy chunk rather than adding
  it to the feed-first entry bundle.
