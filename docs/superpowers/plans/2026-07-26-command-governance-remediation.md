# Command Governance — Remediation Plan

Status: **Awaiting user review. No remediation has started.**

Date: 2026-07-26

Branch: `feat/command-governance` (PR #608)

Implements the fixes for: `docs/superpowers/plans/2026-07-23-command-surface-audit.md`

Review provenance: nine parallel Agent Code orchestration reviewers (five Claude,
four Codex) over run `pr608-final` — four unscoped whole-PR passes, four with a
starting emphasis (destructive paths, keybindings, persistence, test quality), and
one on overengineering and unscalable practice. Every finding below was
independently reproduced against the working tree before being written down.

## Why this document exists

The governance implementation was reported complete. It is not. The PR comment
saying "Plan fully implemented — ready for review" was wrong, and this plan is
the correction.

The reviews found **32 distinct defects**, of which six are blocking. Three
patterns explain nearly all of them, and each is more useful than the individual
bugs:

1. **New code was added in front of old code instead of replacing it.** The
   keybinding router was inserted at the top of `useKeybinds`, above the
   focus-ownership guards and above every legacy chord branch. Nothing was
   removed. So the new path wins when it matches and the old path wins when it
   does not — which is precisely the "two authorities" condition the original
   audit existed to eliminate.

2. **Decision layers were built and then not consulted.** `resolveInvocation.ts`,
   `grantStillMatches`, `contextForCommand`, `issueCloseGrant`,
   `savedSessionListing` and `CommandState.truth` are all written, tested, and
   called by nothing in production. Each one reads as a guarantee the code does
   not provide.

3. **Scripted edits were trusted because the build stayed green.** The Phase 5
   capability gates landed on the wrong commands because `s.replace(pattern, 1)`
   matched the first generic occurrence rather than the intended block. `tsc`
   and the suite passed, and the commit message asserted the change had been
   made correctly.

The common thread is that **the test suite grew by ~3,300 lines and caught none
of it**, because the new tests exercise the new modules in isolation and nothing
tests the wiring between them.

## Blocking defects

Ordered by severity. "Found by" counts independent reviewers who reproduced it.

### B1 — `agent_management_close_agent` is permanently dead (7/9 reviewers)

`AgentManagementBridge.closeAgent` refuses unless `closeGrants.consume()`
succeeds. `issueCloseGrant` has **zero production callers** — no IPC handler, no
preload surface, no renderer confirmation. Every close request therefore returns
*"no user authorization for this agent"*, including ones the user explicitly
asked for.

`revokeCloseGrantsForSession` has zero callers anywhere including tests, so the
commit's claim that "grants are revoked in BOTH directions when a session goes
away" describes code that never runs.

This is worse than the prose gate it replaced: the tool went from
occasionally-too-permissive to always-broken. The plan permitted either a
short-lived user-issued grant **or** a renderer confirmation; neither shipped.

### B2 — The router runs before every focus-ownership guard (6/9)

`routedCommandForEvent` is evaluated at `useKeybinds.ts:364`; the Global Editor
bailout is at `:441` and the text-editing check at `:931`. Neither
`EditorWorkbench` nor Monaco is an app-interaction owner, so `hasAppInteractionOwner()`
does not cover them.

Concrete regressions, all present today:
- ⌘W in Monaco kills the agent pane behind the editor instead of closing the file.
- ⌘[ / ⌘] switch tabs instead of running Monaco outdent/indent.
- Bare `End` in any composer scrolls the feed instead of moving the caret.

This falsifies the approved-overlap justification recorded in
`reservations.ts` — the static checker passes *because* it trusts that text.

### B3 — The router ignores `BindingContext`; Dispatch navigation is dead (3/9)

`routedCommandForEvent` matches `entry.bindings.includes(binding)` and never
reads `entry.context`. In Dispatch, ⌥J/⌥K/⌥arrows resolve to the `grid`-context
`nav-*` commands, get `preventDefault`ed, and are then rejected by admission as
inapplicable — so the Dispatch row/lane handler below is never reached and the
selection does not move. ⌥D/⌥T/⌥C splits are silently dead in Dispatch too.

The whole disjoint-context matrix exists to make this legal. The router that
would honour it does not consult it.

### B4 — Unbinding or rebinding leaves the legacy chord live (6/9)

Every hard-coded branch survives below the routed lookup and fires whenever the
routed lookup misses. Remove ⌘W from Close Focused Session in Settings: the row
reads "Not assigned", and ⌘W still closes the pane. Rebind New Tab to ⌘⌥N: both
⌘⌥N and ⌘T open tabs.

This is the plan's acceptance item 15 verbatim — "without leaving the former
chord active" — and it is the single clearest proof that the migration added a
layer instead of replacing one.

### B5 — Phase 5 capability gates are cross-wired (6/9)

| Command | Required gate | Shipped gate | Consequence |
|---|---|---|---|
| `switch-provider` | `switchTargets` | `isAgentProviderKind` | OpenCode still offered Switch Provider |
| `copy-resume-command` | `verifiedExternalResumeCommand` | `isAgentProviderKind` | OpenCode copies an unverified CLI string |
| `view-prompts` | transcript/history | `switchTargets.length > 0` | OpenCode loses a read-only modal it supports |
| `reload-agent` | resumability | `verifiedExternalResumeCommand` | in-app restart gated on an external CLI template |
| `resume-session` | `savedSessionListing` | *(no `when` at all)* | Resume on OpenCode still opens the empty modal |

Only `rewind-to-prompt` and `duplicate-agent` received their correct predicates.
The misplaced *comments* travelled with the misplaced code, so each wrong gate
carries a confident rationale for a different command. `savedSessionListing` is
declared, tested, and read by nothing.

### B6 — Settings sells 74 bindings the router cannot fire (4/9)

`CommandKeybindingsRow` renders a binding row for all 98 catalog commands;
`ROUTED_COMMAND_IDS` is a hand-written set of 24. Bind Reader Mode to a free
chord: Settings persists it, the palette displays it, `check:keybindings`
reserves it against every other command — and pressing it does nothing.

This is exactly the defect class `normalize.ts` rejects `Cmd++` to prevent. The
guard was built and the bug shipped at larger scale. `save-editor-file` is
already affected: it has a shipped default, is absent from the routed set, and
Monaco still hard-codes ⌘S.

## Non-blocking defects

### Close-path correctness

- **C1** `closeFocused` expands only linked descendants, but a root-pane close
  also kills the tab's detached Dispatch sessions. A tab with one idle pane and
  six parked agents closes all seven with no dialog. `expandTabCloseTargets`
  exists for this and is not called here. (2/9)
- **C2** The confirmation is never bound to the approved id set.
  `grantStillMatches` has no production caller, and `closeLinkedChildren`
  re-reads live state after the dialog — so a child spawned while the dialog was
  open is killed without ever appearing in it. (1/9)
- **C3** Close Old Agents' per-kill re-enumeration reads the `useCallback`
  closure's `workspace`, which zustand rebuilds per render and therefore never
  changes during the loop. `outcome.skipped` can never be non-empty. (5/9)
- **C4** Even with C3 fixed, `buildCloseTargets` carries only id + liveness, not
  the age/threshold/project/cascade eligibility the user actually approved. An
  agent that worked and went idle again is still killed as "old". (2/9)
- **C5** `closeSession` has no gate at all. Agent Activity's per-row close
  cascades linked children with no confirmation, which the plan required "from
  every source, including buttons". (4/9)
- **C6** Commands whose `run` is `() => void workspace.closeFocused()` discard
  the promise, so the gateway's `await` returns immediately: single-flight
  releases while the confirmation dialog is still open, cancellation is recorded
  as a completed run, and a later rejection lands outside the gateway's catch.
  (1/9)
- **C7** Kill Buried passes `reason: 'running'`, so killing an idle buried
  session is announced as "Close a working agent?". (2/9)

### Safety posture

- **S1** Dangerous Agents is still a one-click toggle that persists `true` before
  the fleet reload, with no confirmation, no affected-agent preview, no rollback,
  no Mixed state, and no guard against a second toggle during an in-flight
  reload. The plan required all of these. Retiring the *command* did not deliver
  the *Settings confirmation flow* that was its justification. (2/9)

### Keybinding subsystem

- **K1** Settings hard-codes `context: 'global'` for every capture, so
  `contextForCommand` is dead and legal disjoint reuse is refused. (6/9)
- **K2** Replace is offered whenever any *command* owner exists, even when
  reserved owners also claim the chord — it removes the command binding and
  installs one still claimed by a reservation. (2/9)
- **K3** Bare printable keys, dead keys (`{key:'Dead'}`) and active-IME events
  (`{key:'Process', isComposing:true}`) are all accepted as bindings. Bind `A` to
  New Tab and typing "A" in any input opens a tab. (2/9)
- **K4** `RESERVED_INTERACTIONS` omits composer ownership — `Ctrl+C`, `Ctrl+D`,
  `Cmd+Enter` are reported free. (1/9)
- **K5** Deriving letters from `event.code` universally (not only for the macOS
  Option case it was designed for) mislabels chords on Dvorak and other non-US
  layouts. Needs an explicit decision, not a silent one. (1/9)

### Persistence

- **P1** Zustand's `migrate` fires on any version mismatch including a
  **downgrade**, then writes the current version. A blob from a future build
  containing a multi-step binding is coerced to `{}` and the version rewritten,
  so re-upgrading cannot recover it. (1/9)

### Documentation and state

- **D1** Deleting `dispatchProjectTerminal` took its closing `*/`, so a 12-line
  comment about the removed Dispatch terminal now documents
  `autoSendPromptSuggestion`. (3/9)
- **D2** `src/mcp/shared/closeGrant.ts` contains a literal NUL byte and is
  classified as binary. `git diff`, `git blame` and GitHub's diff view all refuse
  to render it — **the file is unreviewable in the PR**. (2/9)
- **D3** Rendering Debug Mode lost its danger styling in the Phase 6 migration.
  This was deliberate — tone became derived, and the warning moved into a detail
  string — but the reviewer's objection stands: an invasive mode that intercepts
  every feed click now renders identically to an ordinary toggle, and the test
  was updated to match the new behaviour rather than to question it. Needs a
  decision, not an automatic revert. (1/9)

### Overengineering and dead code

- **O1** `resolveInvocation.ts` (205 lines) plus `CommandTarget`,
  `CommandAvailability`, `ResolvedCommandInvocation` and the `targetKind` /
  `risk` / `unavailableReason` fields have **zero product consumers**, and 230
  lines of tests. Keeping an unused pinning authority alongside 98 commands that
  ignore it is worse than either extreme, because the next reader will assume
  targets are pinned. (4/9)
- **O2** `CommandState.truth` is required, authored at four call sites, and read
  by nothing. (1/9)
- **O3** Dead exports and parameters: `contextForCommand`, `grantStillMatches`,
  `effectiveBindingsFor`, `NO_PROVIDER_FEATURES`, `setCommandKeybindings`'s
  `defaults` param, `isSessionLiveForClose` (a one-line wrapper over a private
  function in the same file), `syntaxError` state that is only ever `null`, and
  `label: openClosed ? 'Mixed' : 'Mixed'`. (1/9)
- **O4** Guards that cannot fire: `check:keybindings` check 8
  (`contextsOverlap(a, a)` is always true), the `'shortcut' in command` runtime
  check duplicating a compile-time guarantee, `VALID_SURFACES`/`VALID_TIERS`
  duplicating TS unions, and the taxonomy test's `known` category set. The
  40-character prose-length threshold on approved-overlap reasons is a CI
  grep-lock of the kind this repo's conventions forbid. (1/9)
- **O5** `keybindingBaseline.test.ts`'s history block tests its own hand-authored
  table against itself; no product code is exercised. Its heading says "six
  commands" and asserts five. (2/9)
- **O6** `CloseConfirmationSurface.tsx` is an 8-line wrapper whose body is
  `<CloseConfirmationDialog />` — the `ui/README.md` guardrail verbatim. (1/9)
- **O7** `CATEGORY_ORDER` is a plain array while `CATEGORY_LABELS` is exhaustive,
  so a new category silently vanishes from Settings. `CommandDef.category` is
  still optional with a runtime test enforcing totality; the "independently
  revertable commits" argument does not survive a branch that merges as one unit.
  (1/9)

### Performance

- **F1** `routedCommandForEvent` calls `buildDefaultKeybindings()` and
  `resolveEffectiveKeybindings()` on **every keydown**, including ordinary
  typing. Hoist to a `useMemo` keyed on the override map, and match through a
  `Map<Keybinding, commandId>` rather than a linear scan. (5/9)
- **F2** `requestCommandInvocation` sets `commandPaletteOpen: true` for every
  routed chord, so ⌥H/⌥J pane navigation now mounts `OpenCommandPalette`,
  assembles ~76 workspace dependencies, builds the 98-command registry, and
  unmounts — per keypress. Issue #494 existed specifically to stop paying that
  cost. The native-menu justification ("rare and intentional") does not transfer
  to the most-repeated gesture in the app. (5/9)

## Remediation phases

Each phase is a separately reviewable commit with its own rollback boundary. R1
and R2 are the ones that make the branch honest; everything after is cleanup.

### R1 — Make the router replace, not shadow

The root cause of B2, B3, B4, B6 and F1/F2. One coherent change:

1. Move the routed lookup **below** the app-modal, placement-overlay, editor
   ownership and text-editing guards, and below the Dispatch handler block.
2. Make `routedCommandForEvent` context-aware: resolve the caller's live context
   (grid / dispatch / editor / feed / global) and match only bindings whose
   context overlaps it.
3. **Delete `ROUTED_COMMAND_IDS`.** Route any command with a matching effective
   binding, with a small explicit deny-list for editor-owned chords. Derived,
   not enumerated — the set is unmaintainable against a growing catalog and is
   already inconsistent with the generated provider commands.
4. **Delete the legacy chord branches** the router now owns, and remove Monaco's
   hard-coded ⌘S/⌘W `addAction` registrations in favour of the routed command.
   This is the step that was skipped; without it nothing else in R1 holds.
5. Hoist binding resolution into a `useMemo` over the override map and match via
   a `Map`.
6. Route chords that do not need the palette's context directly, so ⌥H/⌥J stop
   mounting the palette.

Rollback: revert to the current shadowing router; behaviour returns to today's.

### R2 — Bind confirmation to the approved set, and make every path use it

Fixes C1–C7 and S1.

1. `closeFocused` uses `expandTabCloseTargets` when the target is a tab root.
2. The dialog's approved id set is carried into execution; `grantStillMatches`
   is checked before mutation and the close is refused (not silently narrowed)
   if the set changed. `closeLinkedChildren` closes exactly the approved ids.
3. `closeSession` gains the gate, so Agent Activity and orchestration callers
   are covered. Internal already-confirmed callers pass an explicit
   "already granted" token rather than re-prompting.
4. Close Old Agents reads live state from a ref, not the closure, and
   re-evaluates the full eligibility predicate (age, threshold, project,
   ownership, cascade) per iteration — not id and liveness alone.
5. Destructive command `run`s return their promise instead of `void`-discarding
   it, so the gateway's await, single-flight and error handling become real.
6. Kill Buried gets its own reason variant instead of borrowing `'running'`.
7. Dangerous Agents gains the confirmation, affected-agent preview,
   single-flight, and Mixed/rollback reporting the plan required.

Rollback: each numbered item is independently revertable.

### R3 — Repair the capability gates

Fixes B5. Put each predicate on the command it was written for, move the
comments with them, add `savedSessionListing` to `resume-session`, and make
`duplicate-agent`'s `run` re-check the same predicate its `when` uses. Add the
missing test: evaluate every provider-sensitive command's `when` against an
OpenCode context, which is the assertion that would have caught this.

### R4 — Wire or remove the MCP grant

Fixes B1. Two acceptable outcomes; pick one and do it fully:

- **Wire it**: a renderer confirmation at close time (reusing the R2 dialog),
  with the bridge issuing the grant on the user's answer. This is the plan's
  "renderer confirmation" option and needs no new UX vocabulary.
- **Revert it**: restore the prose gate and record honestly that the plan's
  requirement is unmet.

Shipping the current state — enforcement with no issuer — is not an option.
Also wire `revokeCloseGrantsForSession` to session teardown or delete it.

### R5 — Delete what nothing uses

Fixes O1–O7. `resolveInvocation.ts` and its types either get a product consumer
or leave with their tests. Same question for `CommandState.truth`, the dead
exports and parameters, the guards that cannot fire, the CI prose-length
threshold, the self-referential history tests, and the surface wrapper. Make
`category` required and delete the runtime totality test.

### R6 — Correctness details

K1–K5, P1, D1–D3. Notably: reject modifier-less, dead-key and composing captures
in the Settings editor; withhold Replace when a reserved owner remains; add the
composer chords to the reservation registry; make the non-US-layout behaviour an
explicit recorded decision; guard `migrate` against downgrades; rewrite
`closeGrant.ts` without the NUL byte; restore the orphaned docstring; restore
Rendering Debug Mode's danger state.

## Required tests

The suite's failure here was structural, so the additions are specific:

- **Router precedence**: a mounted-workspace test asserting ⌘W in an
  editor-owned target does not reach `closeFocused`, and that `End` in a
  composer does not scroll the feed.
- **Unbind is real**: persist `{'new-tab': []}` and assert ⌘T does nothing.
- **Rebind is real**: rebind and assert the old chord is inert and the new one
  fires.
- **Context routing**: ⌥K in Dispatch moves the row selection; in Grid it moves
  pane focus.
- **Every Settings row is routable**: no catalog command may offer a binding the
  router cannot dispatch.
- **Provider gates by command**: each provider-sensitive command's `when`
  evaluated against Claude / Codex / OpenCode / terminal contexts.
- **Confirmation is applied**: each close entry point, asserting no mutation
  before the answer and refusal when the approved set changed.
- **MCP close**: a production-path test that a user-authorized close succeeds —
  the test that would have caught B1.

## Acceptance

| Requirement | Evidence |
|---|---|
| Router replaces rather than shadows | No legacy chord branch remains for a routed command; unbind and rebind tests pass |
| Focus ownership wins | Editor and composer keys reach their owners; ⌘W in Monaco closes a file |
| Contexts are honoured at runtime | Dispatch navigation works; disjoint reuse is accepted in Settings |
| Every advertised binding fires | No catalog command offers an unroutable binding |
| Capability gates are on the right commands | OpenCode is denied Resume, Rewind, Duplicate, Switch and Copy Resume, each asserted per command |
| Confirmation is bound to what was approved | Every close path gated; a changed target set refuses rather than proceeds |
| MCP close is usable or absent | A user-authorized close succeeds end to end, or the grant is gone |
| No decision layer without a consumer | Nothing exported is called only by its own tests |

## Non-goals

- Do not add multi-step key sequences; still out of scope.
- Do not extend keybinding control to extension-contributed commands.
- Do not re-litigate the four product decisions already recorded in the original
  plan; they stand.
- Do not fix the intermittent 5s suite timeouts here. What is actually known:
  the failing file DIFFERS between runs, every one passes in isolation and when
  its own project runs alone, none is touched by this branch, and
  `--maxWorkers=4` is reliably green. That points at machine contention rather
  than a defect in this work, but it has NOT been reproduced on `main` and so
  is not proven pre-existing. Worth a separate investigation.


---

## Outcome (2026-07-26)

All six batches landed. Commits `9e826490`, `23c3ba48`, `ed6f5781`,
`350bb785`, `be8be812`, on top of R1's `50686573`.

Verification: `tsc -b` clean on both projects (after `rm -rf .tsc-out`),
`check:keybindings` OK (25 binding sets, 13 reserved, 5 approved overlaps),
246/246 vitest files passing.

### Findings that did NOT survive investigation

Recorded so a later reader does not re-open them:

- **"`migrate` on downgrade destroys keybindings."** No mechanism. `partialize`
  persists only `settings`, `merge` reconstructs everything else from current
  defaults regardless of version, and `coerceSettings` preserves unknown keys
  through `...omitRetiredSettingsKeys(parsed)`. A downgrade re-coerces; it does
  not prune.
- **"`effectiveBindingsFor` is a dead export."** It has two consumers
  (`MonacoFileEditor`, `EditorWorkbench`) — wired in R1, so the report was
  reading a pre-R1 tree.
- **"`VALID_SURFACES` / `VALID_TIERS` are guards that cannot fire."** True
  against the current catalog and deliberate anyway: the catalog is the
  boundary an extension-contributed command crosses, and those arrive as
  strings TypeScript cannot check at construction. The existing comment already
  says so.

### The pattern worth remembering

Every blocking defect in this round had the same shape: **a mechanism that
computes a correct answer, and nothing that consults it.**

- The close gate expanded the wrong set and re-read a stale snapshot.
- Four capability guards read each other's flags; a fifth capability had no
  reader at all.
- The MCP close grant had no issuer, so the tool was refused 100% of the time.
- `status('unavailable')` greyed a row that still executed.
- Target pinning pinned a target that `run` never received.
- `CommandState.truth` was written onto every state and read by nothing.

None of it was catchable by the build, and most of it was not catchable by the
tests either — because the tests exercised the mechanism, which worked, rather
than the path from a real caller, which did not. Where a test was added this
round it drives the consumer, not the helper: the capability test flips one
flag and asserts exactly one command turns on; the close-gate test answers a
dialog from a real close.
