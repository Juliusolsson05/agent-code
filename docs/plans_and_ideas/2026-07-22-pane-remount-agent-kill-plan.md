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
edge case.

The timeout is **guaranteed**, not merely likely — but for one reason only,
and precision matters here because the tempting explanation is wrong.
Readiness *does* get re-published: `publishPromptGate` emits on every
transition into ready and `setInputReadiness` dedupes only unchanged values,
so clearing the draft or answering the prompt unblocks the poll. What makes
it unwinnable is that **attach is chained behind the wake**, so the pane is
blank for the whole 30 seconds and the user can do neither. The blank pane is
the bug; the edge-trigger is a red herring that sends you to the wrong file.

This is Claude-specific. Codex latches `composerReady` true after the first
composer sighting and never re-emits `ready: false` except on exit
(`codexSession.ts:368`), and opencode behaves the same way (`ready:false` at
start, `true` once the server is up, `false` again only on exit) — so a
warmed agent on either provider skips the wait entirely.

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
| Parsed-feed view mode | **Yes**, narrowly | `TileLeaf.send` wakes whenever `!runtime.inputReady` — exactly the blocked/drafted state. Pressing Send with a permission prompt showing took the same adopted → 30s → kill path. Usually dodged because a feed user can answer the condition in the UI |
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

Only call `ensureSessionLive` when the runtime is not already started (or has
exited/failed). A remount of a healthy agent becomes a pure re-attach.

Close to `TileLeaf.send` but deliberately not identical: that one also wakes
on `!runtime.inputReady`, which here would reinstate the bug outright. In
terminal mode "not ready" is the ordinary state — the user is typing into the
TUI or answering a prompt — so readiness says nothing about whether a backend
exists.

Independently worth doing even with fix 1 in place: it removes a full IPC
recovery round trip and a `spawning → started` runtime flap from every pane
remount, tab switch, and Spotlight toggle.

### 2b. Attach FIRST, not behind the wake (`AgentTerminalLeaf.tsx`)

Fix 1 disarms the timer on the *adopted* path. The *spawned* path — a
restored agent lazy-woken on cold start — was still armed, and for terminal
panes it was the same self-fulfilling trap: blank pane → user cannot answer
the trust prompt holding readiness false → 30s → kill → Retry respawns into
the same prompt → loop, with no way out but switching to feed mode.

So attach is now attempted before and independently of the wake, and retried
once the wake produces a backend. Attaching early is free: main returns
`null` without taking a reference when no entry exists. Showing the TUI
immediately is what breaks the circle — readiness resolves normally once the
user can actually answer.

### 4. Accepted cost — `lifecycle: 'live'` is not `healthy`

`live` means a `RegistryEntry` exists, and `sessions.set()` runs before
`await session.start()`. So a provider that registers and then wedges before
its composer is now adopted and skipped rather than killed. Previously the
timeout killed it and marked the pane `failed`, which is what surfaces the
Retry button; now it sits at `started` + not-ready with no in-app retry short
of closing the pane. The trade is deliberate — wrongly killing a busy healthy
agent is far more common and far worse — but #548's self-heal no longer
covers this class and nothing has replaced it. Stated here rather than
discovered later.

### 3. Attach/detach reference pairing (same code path)

Two distinct problems, and the first draft of this plan described a third
that never existed (the late attach was already guarded by `disposed`, so it
could not pin the count — recorded here so nobody re-derives the wrong
model):

**Unmatched detach.** Cleanup detached unconditionally, including when no
attach had been issued. This does NOT hurt the Spotlight remount case —
React runs a deleted subtree's passive cleanups before the new subtree's
passive effects, so the outgoing leaf always detaches before the incoming one
attaches. It hurts a *concurrent second consumer*: the debug panel's inline
terminal on the same session, or two panes rendering it through grid-related
tabs. Count 1, the unmatched detach deletes the key, and the still-mounted
consumer loses its byte forwarding while the restore-resize fires against a
terminal the user is looking at — precisely the multi-consumer case the
refcount exists for.

**Unreleased reference.** Main takes the reference when its handler runs,
which can be before this component unmounts — cleanup has then already run
and cannot release it. A flag for cleanup to read does not help, because
cleanup never runs again. So a late attach must release *itself*.

Both need `attachAgentPty` to distinguish "no backend to attach to" from
"attached, buffer happens to be empty"; it returned `''` for both. It now
returns `null` for the former, which also turns the silent-blank-pane failure
mode into a toast.

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
