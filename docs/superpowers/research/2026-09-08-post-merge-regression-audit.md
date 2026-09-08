# Post-merge regression audit — 2026-09-08

Scope: `git diff 3256e06a~1..HEAD` on `main`, covering PR #834
(quota-independent provider switch), #836 (agent names), #838 (agent terminal
follow) and #840 (API key vault), plus whatever the four reported symptoms
turned out to actually be.

Written after four parallel read-only investigations. Everything below is
either CONFIRMED (a concrete input traced to a wrong output) or explicitly
labelled as suspicion. Fixed items say which commit. Unfixed items say why.

---

## The four reported symptoms

### 1. "The key vault has no padding" — FIXED

Two independent causes in `KeyVaultModal.tsx`.

`DialogContent` carries **no padding by design**. The primitive owns layout
only; `DialogHeader` and `DialogFooter` each supply `px-4 py-3`, and every
other feature modal pads its own body — `ViewPromptsModal` and
`RewindToPromptModal` both use `min-h-0 flex-1 overflow-y-auto px-4 py-3`.
The vault modal used `DialogHeader` and then hung the provider list, key rows,
warning banners and the footnote directly off `DialogContent`, so only the
header was ever padded.

Separately, the header passed `flex-row items-center justify-between gap-4`
**without `flex`**. `DialogHeader`'s base class list is a plain block, so all
four of those classes were inert and "Lock now" stacked under the description
instead of sitting opposite the title.

Three further things were wrong inside the same blast radius and were fixed
with it: banners, key rows and the key form used `bg-surface`, which is the
dialog's own background, so they rendered as invisible fills; the two-column
row had `overflow-y-auto` on itself *and* both children, scrolling the
provider list away with the key list; and the banners used bare `rounded`
instead of the `rounded-slab` token.

### 2. "All my Claude sessions came up as Error" — EXPLAINED, diagnosis FIXED

**Not a regression from any of the four merges.** The spawn/recover/rehydrate
path is not in the diff range at all — `src/main/sessionManager.ts` and
`hook/persistence/rehydrate.ts` do not appear in `git diff --name-only
3256e06a~1..HEAD`.

The incident journal for that launch
(`~/.config/agent-code/incidents/runs/2026-09-08T13-52-08-243Z-…`) shows
`rehydrate.complete ok:true` for both windows, then 20 × `wake.result
{ok:false, code:"start-failed", durationMs:~80}` starting two minutes later as
agents were opened from Dispatch. Per session: `provider.start.end ok:true` in
15ms, then `gate.eval {gate:"terminal", reason:"exited", elapsedMs:0}`.
`feed-debug` shows `session exited code=1` on every retry.

All six failing sessions resolved to three directories —
`~/Desktop/Development/bringdown-engine-{settlement,cli-first,fixtures}` —
none of which exist. `git worktree list` reports every `bringdown-engine-*`
worktree as prunable, and `~/Desktop/Development` has an mtime 33 minutes
before the app launched.

**Mechanism:** node-pty performs the chdir *inside the forked child*
(`node_modules/node-pty/src/unix/pty.cc`: `if (chdir(cwd_) == -1) _exit(1)`).
A deleted directory therefore produces a successful PTY creation followed by
an immediate exit(1), and every layer above reports good news on the way up.
The failure only surfaced later as the readiness wait giving up with "agent
exited before it became ready for input (start-failed)", which named neither
the cause nor the folder.

There was no cwd existence check anywhere on the spawn path. There is now, in
`spawnWithId` — the one funnel both `spawn()` and `recover()` pass through —
and `recover()` surfaces it as `Workspace folder is missing: <path>`, marked
non-retryable so Dispatch stops re-spawning it.

This will keep happening, because worktree-per-branch is the standing
workflow: **34 of the 73 persisted rows in the current `workspace.json` are
detached records.** The fix makes it legible, not impossible.

### 3. "Jump to latest does not work for OpenCode" — DIAGNOSED, NOT FIXED

Needs a decision. See "Open decisions" below.

The command palette entry **does** work for OpenCode; the `End` key does not.
`jump-latest-message` is the app's only `context: 'feed'` binding
(`features/command-keybindings/defaults.ts:182`), and both halves of the
`feedFocused` predicate at `tile-tree/useKeybinds.ts:697-708` are false on an
OpenCode terminal pane:

- `renderedAgentSurfaceIsVisible` delegates to `getEffectiveAgentSurface`,
  which returns `'terminal'` unconditionally for `providerRuntime ===
  'terminal'` (`agentDisplayMode.ts:70`). OpenCode Terminal can never be on
  the rendered surface, so this is false 100% of the time for that provider.
- `isTextEditingTarget` returns true for any `HTMLTextAreaElement`, and
  xterm's focused element is `.xterm-helper-textarea`.

It hits any raw agent terminal, but Claude and Codex default to the rendered
feed, so OpenCode Terminal is the only session type that is *always* on the
excluded surface.

PR #838 fixed the palette-admission half (dropped `renderedViewPolicy` from
`paneCommands.ts`) and the scroll half (`agentTerminalFollow.ts` consumes
`scrollToLatestRequest`). It never touched the keybinding router — the plan
doc lists five files and neither `useKeybinds.ts` nor `defaults.ts` is among
them, and the PR's own test file says "This task does not touch `when`."
Issue #837 promised the opposite: "Scope is Claude/Codex raw views and
OpenCode Terminal."

`toggle-tail` already reaches raw terminals because it is `Alt+F` in
`context: 'global'`, which is the shape of one of the two options.

**Unverified caveat:** if the OpenCode TUI runs on xterm's alternate screen,
`term.scrollToBottom()` is a no-op regardless of keybindings, and neither
route will ever work. `packages/opencode-headless/research/07-tui-and-screen-
surface.md:55` describes OpenTUI as rendering into the alternate screen, but
`vendor/in_progress/opencode/.../tui/app.tsx:73` sets `externalOutputMode:
"passthrough"`, which points the other way. **Disambiguate by scrolling that
pane with the mouse wheel:** if scrollback works, it is the normal buffer and
the keybinding gate is the whole story.

### 4. Terminal-view rendering corruption — ONE OF THREE CAUSES FIXED

Three independent contributors. Only one is from a recent merge.

**(a) The agent-name row resized every pane after mount — FIXED, and this one
is ours.** A name arrives over IPC well after the pane mounts.
`AgentTitleHeader` keyed the row's *existence* on the name, so with Agent
names on, every named pane mounted with no row, fitted tall, told the PTY
`rows: N`, then grew a ~23px row when the reply landed, refitted, and sent
`rows: N-1` as a SIGWINCH into a live, mid-output TUI. Ink and the Claude Code
TUI erase a line count computed for the pre-resize frame, so the redraw lands
on the wrong region and leaves garbled fragments in the scrollback
permanently. New behaviour from `2b529300`: before it, the row existed only
for explicitly-titled agents, so an untitled agent never changed height. The
row now reserves its box from first paint whenever names are enabled for an
agent-kind session.

**(b) The WebGL texture atlas — the likeliest dominant cause. NOT FIXED,
needs a decision.** See "Open decisions".

`@xterm/addon-webgl` is pinned at `0.19.0` and was switched on for
`AgentTerminalLeaf` in `3b885068` on 2026-09-04. Issue #789 was filed the next
day describing near-identical symptoms, and its fix `082d845f` is an admitted
workaround whose own comment cites upstream xterm.js #5883/#6038 and ends
"The exact reported screenshot still needs user confirmation after
deployment." #789 was closed without that confirmation.

Upstream #5883 (merged 2026-05-21) fixes two bugs, and its description is the
reported symptom verbatim: "garbled or garbage characters", "characters
sampling from incorrect texture pages", "ghost glyphs and misplaced text
during heavy streaming workloads".

1. Stale texture binding after an atlas page merge: a fresh page replaces the
   old one **at the same index**, and per-page version counters made
   same-index swaps undetectable.
2. Stale vertex buffer after a mid-update merge: `_requestClearModel` was set
   but never reset.

The local workaround subscribes to `onAddTextureAtlasCanvas` /
`onRemoveTextureAtlasCanvas` and calls `invalidateTextureBindings()` +
`refresh()`. That can address bug 1's symptom but cannot replicate bug 2's fix
or the bounded retry loop upstream added inside `renderRows()`, because both
live below the addon's public surface. This is consistent with the corruption
still being reported.

The fix ships in `@xterm/addon-webgl@0.20.0-beta.219` and later. **There is
still no stable 0.20.0** — latest published is `0.20.0-beta.300`.

Character-level evidence favours this over any dimension mismatch: the
screenshot has junk substituted at single space positions
("Nowvgatheringcthe#recent-changeecontext0") and single characters replaced
mid-word ("the .uck? theretis like noopadding"). A PTY geometry mismatch
cannot punch one character out of the middle of a word — a TUI writes whole
strings. Stale texture coordinates render whatever glyph now occupies that
atlas slot, which is exactly why fragments of nearby text reappear scattered.

**(c) Attach replay is parsed at 80×24 before the first fit — NOT FIXED,
pre-existing, tracked as #766.** `AgentTerminalOwnership.tsx:107-108` starts
`handoffComplete` false, so the first commit renders the leaf inside a
`hidden` div. `dimensionActive` is therefore false when the mount effect runs
and `scheduleFitAndResizeBackend()` is skipped, so `term.open(container)`
measures a hidden box and xterm stays at its default 80×24. `attachAgentPty`
resolves a few ms later and `forwarder.replay(...)` writes up to 512 KiB
immediately, while the first real `fit.fit()` only runs from a later
`requestAnimationFrame`. The raw PTY history is therefore normally parsed at
80 columns and then reflowed mid-parse. Absolute cursor-positioning sequences
in the replay land on the wrong cells.

Minimal fix: gate `forwarder.replay(...)` on a "has been fitted at least once"
latch, queueing the buffer the way `backlogQueue` already does. Issue #766
proposes removing the raw replay entirely, which subsumes it.

---

## Also fixed in this branch

These were found while auditing and are not among the reported symptoms.

- **Seven agent-name reconciler tests had never passed.**
  `createSettingsStorage`'s "storage unavailable" guard only caught a *thrown*
  access. Under `happy-dom`, `localStorage` is defined-but-undefined, so the
  assignment succeeded, a live adapter was returned, and every store write
  died inside Zustand's persist middleware with "storage.setItem is not a
  function". The agent-name reconciliation those tests were written to protect
  has therefore never actually been verified. The guard now checks the object
  is a usable `Storage`.

- **The first insertion into any pane that needed waking always failed.**
  `deliverTextToSession` and both prompt-template paths use the session-meta
  object's identity as their "is my target still the same pane?" token across
  the await. `ensureSessionLive` replaced that object on *every* wake, even a
  no-op one, so the guard read "the pane changed" and cancelled. The retry
  worked because no wake was needed by then. Now identity-preserving on a
  genuine no-op.

- **Plain terminal panes rendered no pane toast at all.** `TerminalLeaf`
  called `showPaneToast` but never rendered `PaneToast`. #840 made terminal
  panes valid insertion targets and routed all of that feature's feedback
  through pane toasts, so on a shell pane a failed insertion produced nothing
  observable — and the palette does not close on failure.

- **A bulk provider-switch return destroyed the batch even when nothing
  returned.** The modal is the only return affordance in the app. Arrival
  compaction is on by default for large conversations and blocks returns for
  minutes per pane, so a return attempted in that window returned zero agents
  and binned the record. Now trimmed to the unreturned agents and cleared only
  when empty. This module had no test file at all; it has one now.

---

## Open decisions (not actioned — both are genuine trade-offs)

### D1. Who owns `End` inside a TUI? (fixes symptom 3)

`resolveEffectiveKeybindings` keys on `commandId` in a `Map`, so one command
id gets exactly one context. You cannot have both `End` in `feed` and
`Alt+End` in `global` for `jump-latest-message`.

- **Option A — make `End` work on terminal surfaces.** Widen the `feedFocused`
  predicate to accept agent panes on either surface, and exempt xterm's helper
  textarea from `isTextEditingTarget` (e.g. `el.closest('.xterm')`). Both
  edits are required; either alone changes nothing. Delivers what #837
  promised. **Cost:** bare `End` stops reaching the provider TUI's own line
  editor, which binds Home/End. Presumably why the original author left the
  gate alone.
- **Option B — move it to `Alt+End` in `global`.** One line, mirrors how
  `toggle-tail` already reaches raw terminals. **Cost:** feed users lose bare
  `End`.
- **Option C — a second command id for the terminal surface**, so the feed
  keeps `End` and terminals get `Alt+End`. No conflict, at the price of two
  near-identical palette entries.

Either way, three records asserting today's behaviour need updating:
`command-keybindings/reservations.ts:310-313`,
`command-palette/keybindingBaseline.test.ts:200-202`, and the router wiring
tests.

### D2. WebGL: bump to a beta, or turn it off? (fixes most of symptom 4)

- **Option A — bump `@xterm/addon-webgl` to `0.20.0-beta.300`.** The real
  upstream fix, and the local workaround (plus its comment saying it "can go
  once a stable addon with the upstream merge/retry fixes passes the
  colored-output/scroll regression workload") could then be deleted.
  **Cost:** a beta GPU renderer in a daily-driver Electron app, with no stable
  0.20.0 in sight. Cannot be verified here without running the app.
- **Option B — stop attaching the WebGL renderer for agent terminals** and
  fall back to the DOM renderer, which is what VS Code ships as its own answer
  to this exact symptom class (`terminal.integrated.gpuAcceleration: "off"`,
  widely recommended specifically for Claude Code TUIs). **Cost:** reverses
  the deliberate perf decision in #783/`3b885068`, four days old.
- **Option C — both, behind a setting**, defaulting to DOM until 0.20.0 is
  stable.

---

## Confirmed but NOT fixed

Ordered by severity. Each is reproducible from the stated input.

1. **Return forces arrival compaction on without consent, locking N composers
   for up to 5.5 minutes.** `bulkProviderSwitch.ts:61-67` hard-codes
   `compactOnArrival: targetKind === 'claude'` on the return path.
   `ComposerInput.tsx:241` disables the composer for the whole
   `providerSwitchMessage` lifetime — a 30s readiness wait plus a 300s
   compaction wait, with no cancel. The forward flow has an explicit checkbox
   and a quota disclosure ("spends Claude quota, not Codex's"); one `Return
   20` click has neither. *Fix:* carry the forward batch's choice on
   `ProviderSwitchBatch`, and cap the arrival wait far below 300s.

2. **`switchingModel` is invisible to every close guard, so `/model` can
   fan out twice over the same panes.** `BulkProviderSwitchModal.tsx` guards
   on `busy` only (`:504-507`, `:518-520`, `:521-527`) while `runModelSwitch`
   sets only `switchingModel` (`:451-483`), and the open-reset effect clears
   both. Escape mid-loop, reopen, click again, and a second sequential loop
   interleaves PTY writes on panes that already got `/model sonnet` — the race
   the comment at `:463-466` says the loop exists to prevent. *Fix:* `const
   locked = busy || switchingModel` in all three guards.

3. **Every replaceSession / reload / resume / rewind permanently burns a name
   from the 100-entry pool.** `replaceSession` registers the successor with no
   `agentNameId` (deliberately), then awaits `killSessionBackendIfOwned` — a
   full IPC round trip, so React flushes in between. The reconciler sees the
   identity-less successor, claims one, and main allocates and **commits to
   disk**, advancing `nextIndex`. Only then does `session.ts:1153` overwrite
   with the carried identity. The allocated name is referenced by nothing and
   is never recycled. The pool drains at the rate of *replacements*, so ~100
   reloads and every new agent is "Apollo 2". Multi-pane Undo Close burns up
   to N−1 per restored tab. *Fix:* `pendingReplacementSuccessorsRef` already
   exists; expose it through `refs` and have `claimMissingIdentities` skip
   those ids.

4. **One over-long `agentNameId` kills naming for the entire window.**
   `reconcile.ts:30-31` validates identities as non-empty strings with no
   upper bound; `main/agentNames/ipc.ts:19` is `z.string().min(1).max(200)`.
   One identity over 200 chars in a user-editable `workspace.json` passes the
   renderer check, enters the array, and `requestSchema.parse` rejects the
   whole batch. `useAgentNameReconciler.ts:140` swallows it silently. This is
   verbatim the failure `reconcile.ts:12-28` claims to have fixed — only the
   type half of the contract was mirrored, not the length half. *Fix:* mirror
   the length bound, and chunk the request.

5. **The `{{key:…}}` "collect all failures" path is dead code.**
   `keyReferences.ts:60-70` branches on `value === null`, but the production
   resolver is `window.api.keyVaultResolveReference`, typed
   `Promise<string>`, and `VaultService.resolveReference` *throws* on every
   failure mode. The first bad reference escapes the loop, the aggregation
   never runs, and the documented "one error message tells the user everything
   that needs fixing" is false. Behaviour is still safe — it aborts rather
   than inserting a literal. *Fix:* `await resolve(ref).catch(() => null)`, or
   delete the aggregation and its comment.

6. **Bulk switch discards every failure message and shrink summary that
   `cc0e908d` went out of its way to produce.** `bulkProviderSwitch.ts:132-143`
   drops `result.message` and `result.shrinkSummary`. The poisoned-carrier
   abort names the exact remedy and is replaced by `Switched 0 agents to
   Claude (12 failed)`; the shrink disclosure, added so "no lossy step is
   silent", prints as `12 raw`. The single-pane path surfaces both, and the
   sibling function in the same file already argues the case ("A count alone
   is unactionable").

7. **Mid-turn agents are reported as `failed`, contradicting the modal's own
   footer**, which promises they "will be skipped until idle". The forward
   summary has no `skipped` counter; the return path does.

8. **"Ask once" confirmation is armed against a set that can grow.**
   `runSwitch` arms on the first click and reads `matchingRows` live on the
   second. Disarm handlers cover every manual change but not `agentRows`
   changing on its own — confirm for 3 agents, a fourth goes idle, and 4 get
   their history rewritten under a confirmation that named 3. *Fix:* snapshot
   the confirmed `sessionId[]` when arming.

9. **The agent-name registry grows without bound and rewrites the whole file
   per allocation.** No prune path exists. At 10k assignments it rebuilds a
   `Set` over every value per allocation and re-serialises the entire file on
   the promise tail every window queues behind. Amplified directly by
   finding 3. "Never recycle" only requires `nextIndex` to be monotonic, not
   full retention.

10. **The default quota-independent switch wakes the source provider it
    provably never uses.** `providerSwitchCore.ts:310` calls
    `ensureSessionLive` unconditionally, but `planWithoutSourceTurns` — the
    default — never touches the live source; that is the entire point. For a
    hibernated pane this is a real spawn plus a 30s readiness wait that
    `replaceSession` then kills, serialised N times across a bulk switch.

11. **`deliverTextToSession`'s refusal is an exception, not a result.**
    `encodeTerminalPaste` throws from inside `paste()`, and
    `DeliverTextResult` has no refusal variant. Combined with finding "plain
    terminal panes render no toast" (now fixed), a multiline template into a
    non-bracketed-paste program was a total silent no-op. *Fix:* add a
    `refused` variant.

12. **Unmatchable key references are pasted literally and silently.**
    `KEY_REF_PATTERN` excludes `/` from both capture groups, so
    `{{key:A/B/C}}` and `{{key:Provider}}` never match and survive
    `body.replace` untouched — contradicting the header's "resolution aborts
    loudly".

13. **Secret sinks beyond the ones the disclosure comment names.** The comment
    names drafts, scrollback and the provider transcript. It omits:
    `useAutoSave.ts:97-99` writing `draftInput` to `workspace.json` in
    plaintext; `draft.ts:109` keeping a cleared draft recoverable via undo;
    `KeyVaultModal.tsx` putting revealed plaintext in a DOM `title=`
    attribute; and — most significantly — the proxy dumps.
    `packages/claude-code-headless/src/proxy/mitmAddon.py:490` base64-encodes
    outbound request bodies into the proxy events JSONL. That directory is
    already 3.9 GB on this machine and never rotates, so submitting a prompt
    containing a vault key writes that key to disk in trivially recoverable
    form somewhere nothing prunes.

14. **`providerSwitchesInFlight.add` sits outside its try block.** A throw
    from the intervening `setRuntimes` leaks the entry permanently in a
    module-scoped Set, and that pane answers "Provider switch already in
    progress" until the window reloads. Separately, if
    `window.api.switchProvider` throws *synchronously*,
    `.finally(unsubscribeProgress)` is never attached and the progress
    listener survives for the life of the renderer.
    `startArrivalCompaction` guards exactly this; the transaction path does
    not.

15. **Unhandled rejections at three `BulkProviderSwitchModal` call sites**,
    and `runModelSwitch` has `try/finally` with no `catch` — an IPC rejection
    aborts the batch mid-way and the `finally` still toasts success with
    `failed === 0` for agents never touched.

16. **`largestSourceEstimate` re-walks every matching pane's entry window on
    every runtime tick.** The memo's own comment names `workspace.runtimes` as
    "one of the highest-churn references in the app" and then depends on it —
    O(rows × up to 2000 entries) per streaming tick while the modal is open.

17. **The vault fails on Windows/Linux with a raw TypeError.** `main/index.ts`
    wires `promptAuth` to `systemPreferences.promptTouchID` while
    `canPromptAuth` correctly gates on darwin, but `ensureUnlocked` does not
    consult the flag. Off-macOS the user gets "promptTouchID is not a
    function" instead of the honest platform message. Fails closed, so
    security is fine; the UX is not.

18. **`tailEngagedRef` is not reset when the terminal detaches.**
    `agentTerminalFollow.ts:109-114` disposes the marker but leaves the flag
    true, so a remount under the same sessionId silently loses the saved
    reading position on the next disengage.

19. **The reconciler's stated invariant is false.** It claims "on failure no
    dep changed at all — so a broken registry cannot become a hot loop", but
    `identities` is a `useMemo` over `state` and `agentNameIdentities` returns
    a fresh array every call. With an unreadable `agent-names.json`
    (deliberately never cached), every focus change, title edit, pin, split
    and close fires another failing IPC round trip forever, with no
    user-visible signal.

---

## Suspicions (stated as such, with what would confirm)

- **`isLimitIdle`'s `turnStartedAt === null` branch may green-light a switch
  over a live turn.** `turnStartedAt` is null in a fresh `emptyRuntime()`, and
  with `processActive` true from an adopted backend the guard reads "parked"
  and `replaceSession` kills a live turn. *Confirm by:* reloading the renderer
  while a Claude pane whose recent transcript holds a `rate_limit` carrier is
  mid-turn. Cheap hardening: refuse when `turnStartedAt === null &&
  processActive === true`.
- **`answerResumePrompt` presses UP a guessed number of times** (`selectedIndex
  ?? 1`) and then Enter. If the cursor was elsewhere, Enter lands on a
  different option; if that option discards history the imported transcript is
  silently lost, the wait burns its full 300s, and the switch is still
  reported successful.
- **The resume-prompt branch may be unable to satisfy its own wait** — it
  waits for a compaction whose fingerprint differs from baseline, having just
  answered "Resume from summary", which resumes *from* the existing carrier.
- **Nothing enforces one-identity-per-live-session.** `agentNameId` has no
  runtime validation at any persistence boundary. The registry guarantees
  identity→name uniqueness; nothing guarantees session→identity uniqueness.
  Every in-app path was traced and none produces a duplicate, so the invariant
  is simply unguarded against a copied or edited `workspace.json`.
- **The `__proto__` structured-clone round trip is untested.**
  `registry.ts:218` creates a real own `__proto__` data property and the
  renderer reads it back through Electron's structured clone, which is only
  ever exercised with a mocked `window.api`.

---

## Explicitly clean

The most dangerous question asked — **can a multi-line template auto-submit?**
— gets a clean answer. `encodeTerminalPaste` normalises `\r\n?` to `\n` first,
then rejects `[\x00-\x08\x0b-\x1f\x7f-\x9f]`, which catches embedded `ESC`
(so `\x1b[201~` cannot be forged to close the bracket early) and every bare
`\r` that survived normalisation. Multiline is wrapped only when
`term.modes.bracketedPasteMode` is genuinely true, read live, and is refused
with a message otherwise. Nothing appends `\r`.

Also verified clean: the `textPasteTarget` registry (no leaked registrations,
no cross-window collision, correct re-check after pane replacement);
`templateBusy` cannot deadlock (the palette unmounts and discards the ref);
the command-palette dep arrays; `keyReferences` regex and injection handling
(function replacer, so `$&`/`$1` in a secret are not interpreted; the two
placeholder grammars cannot collide); `main/ipc/keyVault.ts` (key ids
validated before any path join, unlock gate correctly fenced against a
concurrent lock, handlers registered once); the paste-target `isActive`
gating; and the agent-name hard parts — vocabulary exhaustion, cross-window
allocation serialisation with temp-file-plus-rename, Undo Close identity carry
on every path, the default-off toggle, and the prototype-pollution hardening,
which is genuinely thorough.

---

## Where the coverage holes are

Three of the highest-severity findings live in code with no adequate test, and
that is not a coincidence.

- `deliverTextToSession.renderer.test.ts` stubs `ensureSessionLive` as a no-op
  over frozen session objects, so the no-op-wake bug was structurally
  untestable there. Its one cancel test flips the validity flag by hand — it
  encodes the bug's shape as intended behaviour.
- `bulkProviderSwitch.ts` had **no test file at all**, and three findings live
  in it, one of them two-click data loss. It has one now, covering the return
  path's batch bookkeeping.
- `agentNameContinuity.renderer.test.tsx` mounts `useSessionActions` without
  the reconciler, so the interim render that burns a name cannot occur. The
  test asserts the final identity, which is correct; the leak is invisible
  to it.
- Seven `reconciler.renderer.test.tsx` tests never ran green at all, so
  nothing in agent-name reconciliation was actually verified before merge.

## Pre-existing test failures on `main` (not caused by this branch)

Verified by running the same files at `origin/main`:

- `providers/shared/renderer/protocols/media/imageAttachment.test.ts` — cites
  a missing local session file. This is open issue #839.
- `workspace/hook/persistence/codexLiveContinuity.renderer.test.tsx` — a
  `waitFor` timeout.
- `main/workflows/control.system.test.ts` — a 5s test timeout.
