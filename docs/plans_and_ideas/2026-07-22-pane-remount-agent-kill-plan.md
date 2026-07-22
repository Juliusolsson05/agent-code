# Pane remount kills live terminal-mode agents — plan

Date: 2026-07-22
Issue: #596
Branch: `fix/focus-surface-agent-lifecycle`

## The report

"If we have an agent running in terminal mode, and we open spotlight mode
or fullscreen global editor, that agent gets killed."

## What is actually happening

Every `AgentTerminalLeaf` mount unconditionally wakes its session, and the
wake path **kills a live backend** when the provider is not "input ready"
within 30 seconds. Any remount is therefore a loaded gun.

```
MainSurface.tsx:85        Spotlight renders OUTSIDE GlobalEditorShell
                          → TileTree unmounts → every AgentTerminalLeaf unmounts
SpotlightView.tsx:62      Spotlight re-renders the focused session
                          → a NEW AgentTerminalLeaf mounts for the same sessionId
AgentTerminalLeaf.tsx:190 mount effect calls ensureSessionLive() unconditionally
                          (attach is chained behind it — the pane stays blank)
session.ts:490            ensureSessionLive always issues recoverSession()
sessionManager.ts:641     main sees the live entry, ADOPTS it,
                          returns snapshot.input from lastInputReadiness
session.ts:553            snapshot.input.ready === false
                          → waitForSessionInputReady (30s poll)
session.ts:558            on timeout → killSessionBackendIfOwned()
sessionManager.ts:1832    killOwned → kill() → session.stop()   ← process dies
```

The ownership proof at the end passes trivially: kind and cwd are the same
values that just successfully adopted the entry.

### Why readiness is false for a perfectly healthy agent

`derivePromptGateState()` (`claudeSession.ts:744`) publishes `ready: false`
when a provider condition is on screen (permission / trust prompt) **or**
when the raw composer holds any text (`occupied`, `human-draft`).

In terminal mode the user types straight into the Claude TUI and answers
permission prompts there — so "draft present" is the *normal* state, not an
edge case. `setInputReadiness` is edge-triggered (`sessionManager.ts:452`),
so once the poll starts no further event arrives to unblock it. And because
attach is chained behind the wake, the pane is blank for those 30 seconds,
so the user cannot clear the draft or answer the prompt even if they
realized they needed to. The timeout is **guaranteed**, not merely likely.

This is Claude-specific: Codex latches `composerReady` true after the first
composer sighting and never re-emits `ready: false` except on exit
(`codexSession.ts:368`), so a warmed Codex agent skips the wait entirely.

### Provenance — a correct fix applied to the wrong caller

The mount-time wake is old (`d184575d`, 2026-06-23). The kill-on-timeout
arrived 2026-07-16 in `99f52138` (PR #548) with this comment, still in the
code:

> A provider that started but never reached its real composer boundary must
> be replaced, not repeatedly re-adopted on Retry.

That is right for the caller it was written for — a cold-boot dead pane
whose process was just **spawned** and never came up. It is wrong for a
caller that **adopted** a live, busy agent. The distinction already exists
in the data (`SessionRecoverResult.disposition`); `ensureSessionLive` just
throws it away.

## Blast radius — wider than reported

| Surface | Exposed | Why |
| --- | --- | --- |
| Spotlight | Yes | On entry (one leaf) **and on exit** (every terminal-mode leaf, each arming its own timer) |
| Reader mode | Yes | On exit |
| Settings page | Yes | On exit |
| **Tab switching** | **Yes** | `MainSurface` renders only the active tab's tree — no focus surface involved |
| Editor fullscreen | **No** | `GlobalEditorShell.tsx:1218` keeps children mounted under `display:none`; no remount, no wake |
| Parsed-feed view mode | No | `TileLeaf` wakes only from `send()`, and only when already not-ready/failed |
| Hybrid mode | Partly | Only via its terminal branch; a visible condition promotes the pane to the rendered surface |

**The fullscreen-editor half of the report is misattribution.** Fullscreen
provably cannot remount anything. The Spotlight-armed kill fires 30 seconds
later — very plausibly right as the user opens the editor. The
distinguishing evidence is the toast text: the kill path sets
`processError = 'Timed out waiting for agent to become ready for input'`.
Worth saying out loud rather than quietly "fixing" fullscreen too.

## The fix

Two coupled changes. Neither touches the `MainSurface` full-bleed contract
— Spotlight and Reader keep rendering outside `GlobalEditorShell`, because
the bug is the **wake semantics**, not the unmount.

### 1. Never kill a backend this call adopted (`session.ts`)

Keep `disposition` from the recovery result. Then:

- **Skip the readiness wait entirely** when the call adopted an already-live
  backend. There is nothing to wait for — the process is up, and whether its
  composer happens to hold a draft right now says nothing about health. This
  also deletes the 30-second blank-pane window.
- **Only `killSessionBackendIfOwned` when `disposition === 'spawned'`**, i.e.
  a process this call actually started that never reached its composer
  boundary — exactly #548's stated intent.

Belt and braces on purpose: the skip alone would fix the reported bug, but
the kill guard is what makes a *future* caller that waits on an adopted
session non-destructive.

### 2. Don't wake what is already awake (`AgentTerminalLeaf.tsx`)

Mirror what `TileLeaf.send` already does: only call `ensureSessionLive` when
the runtime is not already started (or has exited/failed). A remount of a
healthy agent becomes a pure re-attach.

Independently worth doing even with fix 1 in place: it removes a full IPC
recovery round trip and a `spawning → started` runtime flap from every pane
remount, tab switch, and Spotlight toggle.

### 3. Attach/detach refcount leak (same code path)

`AgentTerminalLeaf`'s detach is fire-and-forget while attach is chained
behind an `await`. A mount/unmount faster than the recovery round trip runs
`detachAgentPty` at count 0 (key already deleted), and the late attach then
pins the count at 1 forever — leaking `agent-pty-data` forwarding for a pane
that no longer exists, plus a bogus `restoreSize`. The `disposed` flag is
already there; it is just checked *after* the attach instead of before.

### 4. `TerminalLeaf` zero-dimension guard

`TerminalLeaf.fitAndNotifyResize` lacks the `cols <= 0 || rows <= 0` guard
its sibling `AgentTerminalLeaf` has. Not this bug — FitAddon's own `isNaN`
guard covers the hidden-container case — but it is a real asymmetry between
two files that are otherwise line-for-line parallel, and the next person to
read them should not have to re-derive which one is right.

## Explicitly NOT in this PR

`detachAgentPty`'s restore-resize (`sessionManager.ts:1481`) targets
`restoreSize`, which for an agent that has only ever been in terminal mode
is the **spawn default 120×40** — no renderer caller ever passes
`cols`/`rows` (`sessionManager.ts:942`). So every Spotlight enter/exit snaps
Claude's TUI to 120×40 and back to the fitted size, and the 512KB replay
buffer ends up interleaved at three widths, producing a garbled repaint.

That is a real defect and it contributes to the "my agent got wrecked"
experience. It is left alone here because the documented contract — "restore
the provider PTY size that was active before the first inline terminal took
ownership" — exists to protect the screen-snapshot/parsed-feed path, and
changing it needs its own investigation into what actually consumes PTY size
when no terminal is attached. Fixing the kill first is worth more than
bundling a size-ownership redesign into it. Filed as a follow-up on #596.

## Verification

1. `tsc --noEmit` on both projects (node, then `tsc -b` for refs, then web).
2. Existing vitest suite (`NODE_ENV=test npx vitest run` — without that the
   shell's `NODE_ENV=production` makes React's prod build reject `act()`).
3. Targeted reasoning check: with an adopted+live recovery, the readiness
   wait must not run and the kill must not be reachable.
