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

## Decisions taken

### D1. Jump to Latest on OpenCode — RESOLVED, and it was not a keybinding

The keybinding analysis was correct but beside the point. A follow-up
investigation established that an OpenCode Terminal pane runs OpenTUI with
`screenMode` defaulting to `alternate-screen`, and renders its transcript into
an internal scrollbox with its own paging keybinds. Nothing is ever evicted
upward, so `viewportY === baseY` always holds and `term.scrollToBottom()` — the
entire jump implementation — is a guaranteed no-op there. No chord could have
fixed it.

`externalOutputMode: "passthrough"` in OpenCode's TUI setup looks like an
opt-out from alt-screen but is an orthogonal axis: it is the only value legal
with alternate-screen and is its default.

Claude Code and Codex are different, which is why jump works for them in the
same pane type: both render inline on the normal buffer and push history into
real xterm scrollback (Codex's `insert_history_lines`; Claude's AlternateScreen
component is documented as being for transient ctrl-o style overlays only).

**A fix was written and reverted on review.** Sending the TUI its own
scroll-to-bottom chord works — ESC + 0x07 is Ctrl+Alt+G, which OpenCode binds
to `messages_last`, and two independent passes confirmed both the binding and
the encoding. What cannot be guaranteed is what that chord MEANS on a given
machine. OpenCode keybinds are user-configurable, and a supported
configuration can move `messages_last` elsewhere and put `messages_undo` —
which aborts the session and reverts history — on Ctrl+Alt+G. A command
labelled "Jump to Latest Message" must not be able to do that, and documenting
the exposure is not mitigating it.

Reading the effective binding would mean reimplementing OpenCode's config
loader: JSONC, global plus per-project plus every `.opencode` directory up to
home, variable substitution, a legacy migration, a win32 special case and
plugin-registered binds. That reimplementation would drift.

The rebinding-immune route exists — OpenCode's server exposes
`POST /tui/execute-command`, whose alias table dispatches `session.last` below
the keybind layer — but it needs a known server URL, which means running
`opencode serve` and attaching the TUI to it rather than spawning the TUI
directly. That is a transport change for this runtime and the right place for
this to land.

What DID ship: the command's description no longer claims a behaviour it
cannot deliver, and the limitation is recorded where the jump is implemented.

The command's description, which claimed "in a raw terminal view this scrolls
the TUI viewport to the bottom", was false for OpenCode and is corrected. The
system test's alternate-screen case was vacuous — on the alt screen viewportY
and baseY are both 0, so its bottom assertion was `0 === 0` — and now proves
both mechanisms.

**Not done, deliberately:** no new chord was added. `End` stays feed-only. The
palette command now works on every provider, which is what was actually broken,
and the keybinding router's exclusion of raw terminal surfaces is a separate
pre-existing design choice that `reservations.ts` documents on purpose. Note
for anyone revisiting it: `Alt+End` is NOT free — it is reserved for
directional split resize, because macOS turns Fn+Option+Arrow into it. `Alt+G`
was verified free across defaults, reservations, the blocked-chord sets, the
three provider TUIs, and macOS.

### D2. WebGL — RESOLVED by turning it off

Upgrading is not available: the fix ships only in
`@xterm/addon-webgl@0.20.0-beta.219+`, there is still no stable 0.20.0, and
that beta's peer dependency is `@xterm/xterm: ^6.1.0-beta.304`. Taking it would
drag the CORE terminal — the heart of every pane — onto a beta to fix one
renderer bug. That trade is clearly wrong, so the renderer is disabled behind a
single constant with the exact upgrade condition written next to it.

The DOM renderer is xterm's default, is correct, and was already the tested
fallback every failure path in that file lands on. The two structural halves of
the perf work that introduced WebGL — routing raw PTY channels once per
renderer, and coalescing inline grid resizes — are untouched. VS Code ships the
same escape hatch for the same symptom class.

The gate is a parameter defaulting to the constant rather than a hard-coded
read, so the fifteen existing cases keep proving the attach, fallback,
context-loss and atlas-repair machinery still works for the day it flips back.

## Confirmed findings — fixed, except where noted

Kept as the record of what each defect actually was, since the fixes are only
legible against it. Two carry a partial remainder, called out inline:

- **Finding 1** (return forcing arrival compaction) is fixed for the CONSENT
  half — the batch now records what the user agreed to and the return reuses
  it. The other half of the recommendation, capping the arrival wait far below
  300s, is NOT done: `COMPACTION_TIMEOUT_MS` is still 300_000 and the progress
  toasts still 305_000. Shortening it changes when a legitimately slow
  compaction is abandoned, which is a product decision about a destructive
  operation, not a cleanup.
- **Finding 4** (identity length bound) mirrors main's per-item limit through a
  shared constant, so one over-long identity can no longer reject the batch.
  Chunking the request is NOT done, and is not needed for the bug: the batch
  cap is 10,000 identities and nothing else can now fail validation.

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

---

## Deliberately deferred

**Attach replay is parsed at 80x24 before the first fit.** Pre-existing,
structural, and tracked as issue #766. `AgentTerminalOwnership` renders the
leaf inside a `hidden` div on its first commit, so `dimensionActive` is false
when the mount effect runs and the initial fit is skipped; `term.open` then
measures a hidden box and xterm stays at its default 80x24. `attachAgentPty`
resolves a few milliseconds later and up to 512 KiB of raw PTY history is
replayed immediately, while the first real `fit()` only runs from a later
animation frame — reflowing the buffer mid-parse, so absolute cursor-positioning
sequences in the replay land on the wrong cells.

NOT fixed here, on purpose. Every available shape of the fix has a real cost:

- Deferring the whole attach until the first fit means a pane that is never
  dimension-active never attaches, so a long-hidden pane can fall off the far
  end of main's bounded 512 KiB buffer and lose output it would have kept.
- Deferring only the replay leaves live PTY chunks writing to the terminal
  ahead of the buffered history, which produces the very interleaving the
  change is meant to remove, unless the forwarder's replay latch is also
  restructured.

This is the most delicate path in the application, it cannot be exercised
without running the app, and it is not one of the four reported symptoms nor
caused by any of the four merges. Issue #766 proposes replacing the raw replay
with a serialized screen, which removes the ordering problem entirely rather
than sequencing around it. That is the right place for it.

The two corruption causes that COULD be resolved safely — the WebGL atlas bug
and the agent-name row resizing every pane after mount — both were.

---

## Later additions (same branch)

Two more symptoms were reported while this branch was open, plus a two-agent
merge review. Recorded here because both turned out to share a root cause with
what was already being fixed.

### The mouse wheel does nothing in an OpenCode terminal pane — DIAGNOSED, NOT FIXED

Same family as the Jump to Latest bug and a different mechanism. **Nothing
swallows the wheel** — that was checked exhaustively: exactly one `wheel`
handler exists in the renderer and it belongs to the feed, there is no
capture-phase listener, no `attachCustomWheelEventHandler`, and the terminal
container's parent is `overflow-hidden` so nothing above can consume it.

The modes that make the wheel work are thrown away. `attachAgentPty` replays
the trailing bytes of a CAPPED buffer that evicts the OLDEST data, and a TUI
writes its mode preamble exactly once at startup: `1049` (alternate screen),
`1000`/`1002`/`1003` (mouse button, drag, any-event including wheel) and `1006`
(SGR encoding). A TUI repainting at 60fps blows through the 512 KiB cap
quickly, so on any session with real activity that preamble is long gone before
a renderer attaches, and nothing reconstructs it.

A freshly-constructed xterm therefore sits on the NORMAL buffer with no mouse
tracking while the application believes the opposite. xterm attaches its
wheel-to-mouse-report listener only when the application has asked for wheel
events, and its fallback path returns early on a normal buffer, so the wheel
reaches nobody. Meanwhile the TUI paints absolutely-addressed full frames that
never push a line into scrollback, so native viewport scrolling has nothing to
scroll either. The pane still LOOKS correct, because a full-screen repaint
renders identically on either buffer — which is why this was hard to see.

OpenCode enables mouse capture by default and Agent Code never disables it; the
installed binary's renderer setup block contains exactly those DECSETs. Claude
Code and Codex are unaffected because they render inline and push real
scrollback.

**A fix was written, reviewed, and reverted.** Tracking the five modes as
chunks pass and prepending the active ones ahead of the replay fails in two
ways that were reproduced against real xterm:

1. **Current modes cannot precede historical output.** If the retained replay
   contains bytes written on the normal buffer and only later switches to the
   alternate screen, prefixing the current `1049h` moves that earlier content
   onto the alternate buffer, where the following `1049l` discards it. The
   correct input is the mode state at the replay's STARTING boundary, which
   means feeding a tracker the bytes the cap EVICTS, not the bytes it keeps.
2. **A set of independent flags is not xterm's model.** Mouse protocols are
   mutually exclusive — `1000h`, `1003h`, `1003l` leaves reporting disabled,
   and `1003h` then `1000h` leaves VT200, not ANY. `ESC c` and the
   `1047`/`1048`/`1049` aliases matter too.

Doing it properly is a real terminal state machine and cannot be validated
without running the app. It belongs next to issue #766, which proposes
replacing the raw replay with a serialized screen and would remove the ordering
problem entirely rather than sequencing around it.

### Pane paths were truncated from the wrong end

Every pane in a workspace shares the leading path segments, so
`text-overflow: ellipsis` — which always clips the END — removed the only part
that identifies the agent. A narrow pane showed `…/Desktop/Developme…` for all
of them. `shortenCwd` was already producing the right string; only the clipping
end was wrong.

### Merge review

One Claude and one Codex reviewer, both read-only, both returned BLOCK, and
between them they found seven things worth fixing. The most valuable was one
both the author and the Claude reviewer reached independently: the wake's
no-op detection compared `builtInMcpDomains` by reference, and that array is
rebuilt on every wake, so the fix was inert for exactly the agent panes it
existed to protect and worked only for plain terminals.

The rest: the identity-carry reservation leaked when spawn itself threw and its
gate was narrower than the carry predicate; the bulk modal's double-run lock
covered the close paths but not the run paths; the widened `{{key:…}}` pattern
captured ordinary JSX and broke templates that had always worked; catching
every resolver throw re-prompted for authentication once per reference; the
vault's provider column could not be scrolled to in a narrow window; and three
comments described the code beside them inaccurately.

Both reviewers confirmed the OpenCode jump chord's default binding and byte
encoding are correct, and Codex reproduced the JSX and re-prompt regressions
against the real modules rather than reasoning about them.

The one objection NOT resolved by a code change is the rebinding hazard on the
injected chord, and the reasoning is recorded next to the constant in
`featureCapabilities.ts`: under stock config no byte we send can reach a
destructive action, reading the user's effective binding would mean
reimplementing OpenCode's config loader, and the rebinding-immune route needs a
served transport this runtime does not use yet.
