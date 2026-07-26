# PR608 destructive+MCP (Claude C) (claude)

sessionId: 01be91ed-0c5f-4919-af31-7a7b2efaf4a9

---

## Verification run

| Command | Exit |
|---|---|
| `npx tsc -p tsconfig.node.json --noEmit` | 0 |
| `npx tsc -p tsconfig.web.json --noEmit` | 0 |
| `npm run check:keybindings` | 0 (25 binding sets, 12 reservations, 5 approved overlaps) |
| `vitest run closeConfirmation{,Broker}.test.ts closeGrant.test.ts AgentManagementBridge.test.ts` | 0 (53 passed) |

Everything green. The defects below are all things the suite does not assert.

---

# Findings, most severe first

## 1. The keybinding router runs before every focus-ownership guard — ⌘W in the Global Editor now kills an agent session, and ⌥/End chords are stolen from text editing

`src/renderer/src/workspace/tile-tree/useKeybinds.ts:364`

`routedCommandForEvent` is placed at line 364, after only the app-modal (`hasAppInteractionOwner`, :310) and placement-overlay (:338) bailouts. Every remaining ownership guard is *below* it:

- `editorOwnsTarget` early return (:442) — protected `['s','w','[',']']` and **all** `alt && !cmd` chords while focus is in `[data-global-editor-input-owner]`
- `fullscreenEditorOwnsWorkspace` swallow (:461-480) — explicitly existed to eat "destructive pane grammar" while the workspace is hidden
- `!isTextEditingTarget(e.target)` on the `End` handler (:931)

`routedCommandForEvent` also ignores the `context` field it reads (`'grid' | 'editor' | 'feed'` in `defaults.ts`); it matches on chord alone.

**Failure A (destructive).** Global Editor open, focus in the file-tab strip or Explorer, one Claude pane behind it, idle. Press ⌘W. Before: `EditorWorkbench`'s bubble handler (`EditorWorkbench.tsx:241`) closed the file tab — its own comment says *"allowing the workspace's window-level Cmd+W handler through would terminate the underlying agent pane."* Now: line 364 matches `Cmd+W` → `close-pane` → `closeFocused()`. Target is idle and single, so `closeConfirmationFor` returns `{required:false}` — the session dies with a toast. In fullscreen editor the pane isn't even on screen.

**Failure B (destructive).** Same, ⌥W (`close-pane`'s second default). Previously line 448 (`if (alt && !cmd) return`) kept it out of the editor entirely.

**Failure C (editing).** Type in Monaco, press ⌥D to insert `∂` → `split-vertical` spawns a new agent pane. ⌥T spawns a terminal, ⌥C spawns Codex, ⌥←/→ (word navigation) move pane focus.

**Failure D (editing, app-wide).** Type in the composer, press `End` to jump to end of line. `keybindingFromEvent` returns `"End"`, `jump-latest-message` is in `ROUTED_COMMAND_IDS`, so line 366 `preventDefault()`s unconditionally — the caret does not move. The `preventDefault` happens *before* admission, so it swallows the key even when the gateway then refuses the command.

This also invalidates four of the five entries in `reservations.ts:180-243` in the same PR. `APPROVED_OVERLAPS` justifies ⌘W, ⌘[, ⌘] and `End` on the grounds that *"useKeybinds returns early for cmd+s/w/[/] whenever the event target sits inside [data-global-editor-input-owner]"* and that jump-to-latest *"requires a target that is not text-editing"*. Neither is true any more, so `check:keybindings` passes on a promise the router broke.

**Severity: High.**

---

## 2. Close Focused Session confirms the wrong target set — it omits the tab's detached Dispatch sessions, which it then kills

`src/renderer/src/workspace/hook/actions/pane.ts:1103-1114` (gate) vs `:1175-1178` and `:1333-1336` (what actually dies)

The gate expands with `expandSessionCloseTargets`, which walks **only** `linkedParentId` (`closeConfirmation.ts:226-228`). The close itself, when the target is the last leaf in its tab, adds `detachedTabChildren(closeSnapshot, tab.id)` — selected by a completely different edge, `projectTabId` (`pane.ts:96-113`).

**Failure.** Tab "web" has one grid pane (Claude A, idle) and three detached Dispatch agents B/C/D with `projectTabId` = that tab, two of them mid-turn. Press ⌘W (or run Close Focused Session, or the native menu item).
- Gate: `expandSessionCloseTargets(...) → [A]`, `A.live === false` → `{required:false}` → **no dialog at all**.
- Execution: `parentInfo === null` → `closedSessionIds = [A, B, C, D]` → four sessions killed, two of them working.

This is verbatim the failure `closeConfirmation.ts:152-157` says the module exists to prevent (*"an unexpanded set silently downgrades a cascade to a single close"*). The correct expander already exists and is already used by `closeTab` — `expandTabCloseTargets(state, runtimes, gridIds, detachedIds)` — it just isn't reachable from the pane path, which cannot know at gate time whether `parentInfo` will be null. The same hole exists on the Dispatch arm (`:1132 → closeSession`) and in `closeSession` itself.

**Severity: High.**

---

## 3. `close_agent` (Agent Management MCP) is now permanently denied — nothing in production issues a grant

`src/main/agentManagement/AgentManagementBridge.ts:240` (`issueCloseGrant`), `:265` (`consume`)

```
$ grep -rn "issueCloseGrant" src/ scripts/
AgentManagementBridge.test.ts:143,280,391,410
AgentManagementBridge.ts:240,241            ← the definition
```

The only callers are four test cases. There is no IPC handler, no renderer confirmation, no menu item, no UI affordance that calls it. `revokeCloseGrantsForSession` has no production caller either.

**Failure.** User types "close the codex agent in this project" to an agent with Agent Management MCP enabled. The tool is still registered and still described as *"Call only when the current user explicitly asks to close this specific agent"* (`createBuiltInMcpServer.ts:297-311`), with no mention of a grant. `closeAgent` calls `consume(caller, target)` → `false` → throws *"close_agent refused: no user authorization for this agent."* The model has no way to obtain authorization; it will retry, apologise, or invent a workaround. Every invocation fails, forever.

The grant store itself is well built and correctly fails closed. The problem is that "fail closed" with no issuer is indistinguishable from deleting the feature — and the plan asked for *"a short-lived user-issued caller/target authorization **or** renderer confirmation"* (§Phase 7.7), i.e. something that can actually be issued.

**Severity: High.** Either wire an issuer (renderer confirmation on the close request is the natural one, and the confirmation dialog from this same PR already exists) or unregister the tool.

---

## 4. Close Old Agents' per-kill re-enumeration reads a frozen snapshot, so it can never observe a change

`src/renderer/src/features/workspace/ui/CloseOldAgentsModal.tsx:280` (`buildCloseTargets`), `:313` (call inside the loop)

```ts
const current = buildCloseTargets(workspace)   // ← `workspace` from the click-time closure
const stillGranted = narrowGrantToCurrent([target], current)
```

`workspace` is the prop captured when `closeMatchingAgents` was created. `useWorkspace` returns a fresh object literal per render whose `state`/`runtimes` are zustand snapshots (`hook/index.ts:95-98, 834-836`) — that is exactly why every action in `pane.ts` reads `refs.stateRef.current` / `refs.latestRuntimesRef.current` instead. The running async closure keeps the click-time object for the whole loop.

**Failure.** User previews 12 idle agents and clicks Close. The loop is sequential and each `closeSession` awaits a backend kill, so it spans seconds. During it, agent #7 receives a prompt and starts working. Iteration 7 calls `buildCloseTargets(workspace)` → returns the click-time snapshot where #7 was idle → `narrowGrantToCurrent` sees `now.live === false` → the guard at `closeConfirmation.ts:130` never fires → the now-working agent is killed on the strength of the stale preview. `outcome.skipped` stays empty in every realistic run, so `describePartialClose` reports success.

The comment at `:294-303` states precisely the invariant the code fails to hold. Fix: thread a getter (`workspace.latestScreenRef`-style ref, or a `() => useAppStore.getState()` read) instead of the captured object.

**Severity: High** for a feature whose entire justification in the plan is *"re-enumerate immediately after confirmation and before every kill."*

---

## 5. Provider capability gates are cross-wired onto the wrong commands, and the two commands they were minted for still use the old gate

`src/renderer/src/features/workspace/commands/sessionCommands.ts:85, 658, 765, 895`

All four consumers of `getProviderFeatures`:

| line | command | capability consumed | correct? |
|---|---|---|---|
| 85 | `view-prompts` | `switchTargets.length > 0` | **no** |
| 137 | `rewind-to-prompt` | `transcriptRewind` | yes |
| 658 | `reload-agent` | `verifiedExternalResumeCommand` | **no** |
| 806 | `duplicate-agent` | `transcriptDuplicate` | yes |

The rationale comments came along with the capability: `view-prompts` carries *"Driven by the explicit switch EDGE list… translation is directional"* and `reload-agent` carries *"Requires a VERIFIED external resume form… they paste it into a terminal and blame their setup."* Neither sentence is about the command it is attached to.

Meanwhile `switch-provider` (:895) still returns `isAgentProviderKind(kind)` and `copy-resume-command` (:765) still returns `isAgentProviderKind(kind) && Boolean(meta?.providerSessionId)` — the exact predicate `featureCapabilities.ts:6-18` says it replaces. And `savedSessionListing` has **zero** consumers, so `resume-session` (`tabCommands.ts:51`, no `when` at all) is unchanged.

**Failure now.** Focus an OpenCode pane. `Copy Resume Command` is offered and produces an unverified shell command; `Switch Provider` is offered and has no destination edge. Both are named explicitly in the audit's High-severity row and in the docstring of the module added to fix them.

**Failure later.** Someone verifies OpenCode's CLI resume string — a one-boolean documentation act — and silently enables **Reload Agent** for OpenCode. Someone adds an OpenCode↔Codex switch edge and silently enables **View Prompts**. Conversely, dropping the Claude→Codex edge would remove View Prompts from Claude.

`providerFeatures.test.ts` pins the table only; it never asserts which command reads which capability, so nothing catches this.

**Severity: Medium-High** (one live wrong-availability pair today, two latent silent couplings).

---

## 6. Settings offers bindings for all 98 commands; only 24 are routed

`src/renderer/src/features/settings/ui/CommandKeybindingsRow.tsx:102` vs `src/renderer/src/workspace/tile-tree/useKeybinds.ts:181`

`CommandKeybindingsRow` builds a row for every catalog command with a `category` (all of them). `routedCommandForEvent` (:223) skips anything not in the 24-member `ROUTED_COMMAND_IDS`. `buildCommandRegistry` (`registry.ts:157-160`) renders effective bindings in the palette regardless.

**Failure.** User assigns ⌘⌥K to `close-old-agents`. Settings accepts it, runs the collision check, shows the chip; the palette row shows ⌘⌥K. Pressing it does nothing, with no error and no disabled state. Same for `bury-pane`, `dispatch-mode`, `toggle-spotlight`, `reload-agent`, `undo-rewind`, every MCP toggle, every debug command.

Worst case is `save-editor-file`, which ships a **default** (`defaults.ts:125`) and is validated by `check:keybindings`, but is not routed: Monaco's `addAction` (`MonacoFileEditor.tsx:246`) and the workbench handler still own ⌘S. Rebind Save to ⌘⌥S → new chord dead, ⌘S still saves. `defaults.ts:121-125` admits this (*"removing those two hard-coded paths is what makes rebinding real"*), but nothing surfaces it to the user and the acceptance matrix claims *"every built-in command can be assigned, multiply bound, unbound, and reset."*

**Severity: Medium.**

---

## 7. Rebinding or unbinding a command leaves its legacy hard-coded chord live

`src/renderer/src/workspace/tile-tree/useKeybinds.ts:378, 396, 418, 648, 658, 670, 675, 680, 685, 843, 848, 863, 868, 884, 892, 898-917, 931`

Only three legacy branches were deleted (⌘⇧P, ⌘⇧E, ⌘⇧T). Every other routed command still has its hard-coded handler below line 364, unreachable **only while the default binding is intact**.

**Failure (safety-relevant).** A user deliberately unbinds `close-pane` (`overrides['close-pane'] = []`) because ⌘W keeps killing panes. `routedCommandForEvent` no longer matches → falls through to `:675` → `void workspace.closeFocused()` → the pane still dies. Settings says "Not assigned."

**Failure (ordinary).** Rebind `quick-open-file` to ⌘⌥O. New chord works; ⌘P *also* still opens quick-open via `:396`. Same for ⌘⇧F, ⌘⌥E, ⌘T, ⌘⇧R, ⌘⇧W, ⌘[/⌘], ⌥D/⌥⇧D, ⌥T/⌥⇧T, ⌥C, ⌥W, ⌥H/J/K/L, ⌥arrows, End.

The plan lists this exact case in the check-script contract and the manual matrix (item 15: *"without leaving the former chord active"*).

**Severity: Medium.**

---

## 8. `closeTab` and `closeFocused` mutate from a pre-await state snapshot

`src/renderer/src/workspace/hook/actions/tab.ts:89` (`state` from the render closure) with the new `await` at `:110`; `pane.ts:1087` with the new `await` at `:1111`

`ids`, `detachedRecords`, `allMetas`, `tabIdx` and the undo entry's `tab: {...tab}` are all computed from the snapshot taken *before* the dialog opened, then used after the user answers.

**Failure.** ⌘⇧W on a tab with a running agent → dialog opens. While it is open, an orchestration agent calls `orchestration_create_agent`, which creates a detached session with `projectTabId` = that tab. User confirms. `idsToKill` is stale → the new session is not killed, but `setState` removes the tab (`:159`) and only deletes `detachedSessions` for the stale `detachedIds` (`:163`) — leaving a session with a dangling `projectTabId`, a live backend PTY, and no owner. The ownership sanitizer then prunes the record at save time, per the warning in `detachedTabChildren`'s own comment.

The inverse holds in `closeFocused`: `closeLinkedChildren` (`:1159`) and `detachedTabChildren(closeSnapshot,…)` (`:1177`) read *fresh* state, so a linked child spawned during the dialog is killed without ever appearing in the confirmed list.

**Severity: Medium** (needs a state change during the dialog window, but agent-driven session creation makes that reachable).

---

## 9. Agent Activity's per-row close has no confirmation at all

`src/renderer/src/features/workspace/ui/AgentActivityModal.tsx:281`

`closeRow` calls `workspace.closeSession(row.sessionId)` directly. `closeSession` cascades linked children (`pane.ts:1294`) and takes the tab's detached sessions when the target is the last leaf (`:1333-1336`). No gate was added on this path.

**Failure.** Open Agent Activity, click Close on a row that happens to be the sole pane of a tab with five detached agents → six sessions die, no dialog, no count. Plan §Phase 7.4 requires the gate "from every source, including buttons."

**Severity: Medium.**

---

## 10. Every routed chord mounts and unmounts the entire command palette

`src/renderer/src/app-state/uiShell/slice.ts:60-64` → `CommandPalette.tsx:199-205` → `:940-962`

`requestCommandInvocation` sets `commandPaletteOpen: true` to force `OpenCommandPalette` to mount, which builds the whole registry — the cost `#494` deliberately avoided — then a layout effect dispatches and closes it. The comment justifies this with *"A keypress is equally rare and equally intentional."*

That is true of a menu click and false of ⌥H/⌥J/⌥K/⌥L, ⌘[, ⌘]. `routedCommandForEvent` does not filter `e.repeat`, so holding ⌥J to walk across panes rebuilds ~98 command definitions and mounts/unmounts a Radix `Dialog` (focus trap, `aria-hidden` on siblings, `body { pointer-events: none }`) per repeat.

I could not reproduce a stuck-overlay state without running the packaged app, so I'm **downgrading the focus/pointer-events half to unverified**. The registry rebuild per navigation keypress is directly readable from the code and is a real regression against the issue the gate was built for.

**Severity: Medium (perf), unverified (focus churn).**

---

## 11. Kill Buried reuses `reason: 'running'`, so an idle buried session is announced as working

`src/renderer/src/workspace/hook/actions/pane.ts:1773`

The request is hand-built with `reason: 'running'` unconditionally. `CloseConfirmationDialog.tsx:50` branches on exactly that value for its title.

**Failure.** Kill an idle buried session → dialog reads **"Close a working agent?"** with body *"Killing a buried session is permanent…"* and no "working" row marker. The title contradicts the body and the state. Cosmetic, but this is the one close with no undo, so the dialog's credibility is the whole mechanism.

Related dead distinction: `closeConfirmationFor` picks `'cascade'` vs `'bulk'` from `live.length > 0` (`closeConfirmation.ts:81`) rather than from origin, and nothing consumes the difference — the dialog only tests `=== 'running'`. Either wire it or drop it.

**Severity: Low.**

---

## Things I checked and could not break

- **Unresolved confirmation promise.** `CloseConfirmationSurface` is in `modalSurfaces` and `GlobalModals` is unconditionally rendered (`App.tsx:122`), so no unmount hang. Second request resolves the first as declined (`broker.ts:58`). Escape/overlay/close-button all route to `resolveCloseConfirmation(false)` (`Dialog.tsx:44`). Radix does not fire `onOpenChange` for a controlled prop change, and a second resolve is a no-op. `dispatchCommand`'s `inFlight` set holds `close-pane` for the whole dialog, so a repeated chord is dropped rather than queued.
  - One ordering nit with **no constructible failure**: `requestCloseConfirmation` calls `emit()` while `resolver` still points at the previous, already-resolved function, and installs the new resolver afterwards. A listener that resolved synchronously during `emit()` would null `pending` and hang the new promise. The only listener is a React `setState`, which cannot. Reordering (`resolver = null` before `emit`, or building the promise first) would make it structurally safe.
- **Native menu.** `dispatchCommand` resolves from `builtInCommandCatalog`, not the filtered registry, and skips picker visibility — the audit's High-severity menu defect is genuinely fixed. `NativeMenuCommandId` typing plus the catalog test closes the loop.
- **Tab close button** (`TabBar.tsx:119`) goes through `closeTab`, so it is gated.
- **Undo Close** is untouched and still recovers what it recovered before; the tab-level entry still captures `detachedEntries` in both `closeTab` and `closeFocused`. The policy's claim that undo covers only the idle-single case is honest — which is precisely why finding #2 matters.
- **`dispatchProjectTerminal` removal** is complete: no runtime references remain, `omitRetiredSettingsKeys` prevents re-serialization, store version bumped 8 → 10.
- **`coerceCommandKeybindingOverrides`** correctly distinguishes absent / `[]` / non-empty, and the "all entries unparseable → drop the key" reasoning in `resolve.ts:56-69` is sound.
- **Grant store semantics** (`closeGrant.ts`) — unconditional delete on consume, expiry checked after delete, bidirectional revoke — are correct. The defect is the absent issuer, not the store.
