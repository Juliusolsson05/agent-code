# PR608 test quality (Claude D) (claude)

sessionId: d51d049c-7f39-4c76-b0d3-194a334f383c

---

Working tree verified clean (`git status --porcelain` empty), `tsc -b` exits 0, and the full unit + renderer suite is green (1302 tests). All temporary edits were reverted with `git checkout --`.

## Findings, most severe first

---

### 1. `agent_management_close_agent` is dead in production — nothing can ever issue the grant it now requires

`src/main/agentManagement/AgentManagementBridge.ts:265` refuses every close unless `closeGrants.consume(...)` succeeds. The only thing that populates that store is `issueCloseGrant` (`:240`), and it has **zero production callers** — verified by grep across `src/`. The sole production path into `closeAgent` is the MCP tool handler at `src/mcp/runtime/createBuiltInMcpServer.ts:311`, which never issues a grant. There is no IPC channel for it either (`src/main/ipc/agentManagement.ts` registers only `agent-management:response`).

So the tool now throws `close_agent refused: no user authorization for this agent` on **every** invocation, including the legitimate "close agent X" the plan wanted to preserve.

**Why the tests don't catch it:** every allow-path test calls the internal issuer itself — `AgentManagementBridge.test.ts:139` and `:280` were *edited* to add `bridge.issueCloseGrant(...)` so pre-existing tests would keep passing, and the three new tests (`:373`, `:382`, `:400`) all assert the *deny* path, which is the only path production can reach. `closeGrant.test.ts` (91 lines) exercises the store in isolation and proves nothing about wiring. The suite reads as "authorization implemented"; the product reads as "feature removed."

---

### 2. The keybinding router hijacks `Cmd+W`, `Cmd+[`, `Cmd+]` and `End` inside the Global Editor and text inputs

`useKeybinds.ts:364` runs `routedCommandForEvent` **before** the editor-ownership bail at `:441` and before the `isTextEditingTarget` guard at `:931`. The comment at `:359` claims the opposite ("Editor-owned targets are handled further down and never reach here") — it is 77 lines wrong.

Consequences, all confirmed against the default binding table:

| Chord | Before | After |
|---|---|---|
| `Cmd+W` in Monaco/editor chrome | `useKeybinds` returned early; EditorWorkbench/Monaco closed the **file** | routed → `close-pane` → `closeFocused()` **kills a workspace session** |
| `Cmd+[` / `Cmd+]` in Monaco | outdent / indent | routed → `prev-tab` / `next-tab` |
| bare `End` in the composer or Monaco | caret to end of line (`isTextEditingTarget` guard) | routed → `jump-latest-message`, and `e.preventDefault()` swallows the caret move regardless of whether admission passes |

I verified the `End` half directly with a throwaway probe (since deleted): `keybindingFromEvent({code:'End',key:'End'})` → `'End'`, and `'End'` is the effective binding of the routed command `jump-latest-message`.

**Why the tests don't catch it:** `reservations.test.ts:86-92` asserts `save-editor-file` has `context: 'editor'` and `jump-latest-message` has `context: 'feed'`, with the comment *"Bare End must not be global or it would collide with End in any composer."* The router at `useKeybinds.ts:222-225` never consults `context` — it matches on `bindings.includes(binding)` alone. The test pins a data label whose only consumer is the offline collision checker. Worse, `reservations.ts:220-225` records `End` as an **approved overlap** whose justification is *"Jump to Latest Message requires … a target that is not text-editing"* — the precondition this PR removed. `check:keybindings` rule 6 only verifies the reason string is >40 characters, so it passes.

---

### 3. Rebinding or unbinding any command leaves the old chord fully live

Every legacy hardcoded branch survives below the routed block: `Cmd+T` (`:648`), `Cmd+W` (`:675`), `Cmd+[`/`]` (`:680`,`:685`), `Cmd+Shift+W`, `Cmd+Shift+R`, `Cmd+P`, `Cmd+Shift+F`, `Cmd+Alt+E`, `Alt+D`/`Alt+Shift+D`, `Alt+T`, `Alt+W`, `Alt+H/J/K/L`. They are dead only while the effective binding still matches. Move `close-pane` off `Cmd+W`, or unbind it with `[]`, and `Cmd+W` still calls `workspace.closeFocused()` directly.

**Why the test doesn't catch it:** `routing.test.ts:30-38` is titled *"a user override replaces the chord the router will match"* and comments *"Before this phase, editing a binding changed a display string while useKeybinds kept running the hardcoded chord."* It then asserts `resolveEffectiveKeybindings({'new-tab':['Cmd+Shift+9']})` — a pure function over a constant table. It cannot observe the router. `useKeybinds` still runs the hardcoded chord. `resolve.test.ts:27-31` ("explicit unbind") has the same shape and the same blind spot.

`save-editor-file` is worse: it has a declared default (`defaults.ts:125`) but is **not** in `ROUTED_COMMAND_IDS`, so Monaco's `addAction` remains the only implementation. Rebinding Save changes nothing at all, and `keybindingBaseline.test.ts:302` explicitly `continue`s past it (`if (entry.owner !== 'useKeybinds') continue`), excluding the plan's flagship case from its own assertion.

---

### 4. The entire keyboard router has no test — verified by sabotage

I patched `routedCommandForEvent` to `return null` (every configured chord dead: `Cmd+Shift+P`, `Cmd+T`, `Cmd+W`, all navigation). Result: **118 files / 861 tests passed.** Reverted.

Only `ownedShortcutPolicy.renderer.test.ts` imports anything from `useKeybinds`, and only the pure `shouldPreventOwnedApplicationShortcut` helper. `routing.test.ts:14-16` admits this ("exercising it end to end needs a mounted workspace") and then names itself after the behaviour it doesn't test.

---

### 5. The close-confirmation gate is never proven to be applied

I replaced both gates with `if (false && confirmation.required)` — `pane.ts:1110` (`closeFocused`) and `tab.ts:109` (`closeTab`), i.e. removed the whole Phase 7 destructive-safety wiring. Result: **861/861 passed.** Reverted.

`closeConfirmation.test.ts` (201 lines) tests only the pure policy function; `closeConfirmationBroker.test.ts` tests only the promise plumbing. Nothing connects them to a close path. No test mounts `CloseConfirmationDialog`.

Also genuinely ungated: `AgentActivityModal.tsx:281` (`closeRow` → `workspace.closeSession(...)`) kills a session — including a running one, including a linked-children cascade — with no confirmation at all. The plan requires confirmation "from every source, including buttons and shortcuts."

Secondary: `grantStillMatches` (`closeConfirmation.ts:103`) has three tests asserting stale grants are rejected, and **no production caller**. `closeFocused` computes `targetId` from the pre-`await` snapshot and never revalidates it after the dialog resolves; `targetStillValid` exists and is not called.

---

### 6. Close Old Agents' "re-enumerate before every kill" re-reads a frozen snapshot

`CloseOldAgentsModal.tsx:277-321`. The comment promises *"RE-ENUMERATE BEFORE EVERY KILL, not once after confirmation … agents finish, new ones spawn, and one of the idle agents in the list can wake up."*

But `buildCloseTargets(workspace)` reads `ws.state.sessions` and `ws.runtimes` off the `workspace` object captured in the `useCallback` closure at click time. `workspaceState` and `workspaceRuntimes` are replaced immutably by zustand (`app-state/workspace/slice.ts:43-46`) and surfaced as per-render values (`workspace/hook/index.ts:95-97`), so the closure's copy never changes during the `await` loop. `narrowGrantToCurrent([target], current)` is therefore comparing the grant against the same snapshot the grant came from: it can never drop a woken agent and can never skip an already-closed one. The hardening is inert. There is no test for this file.

The fix is a live read (`useAppStore.getState()`), not the captured prop.

---

### 7. All of Phase 2 (`resolveInvocation.ts`) is dead code with 230 lines of tests

`resolveCommandInvocation`, `resolveCommandTarget`, `resolveCommandAvailability` and `targetStillValid` have **zero production callers**. `CommandDef.targetKind` is declared on no command; `CommandDef.unavailableReason` is declared on no command; `CommandDef.risk` is declared on no command (0 matches in `features/*/commands/*.ts`). The palette still calls `command.getState(ctx)` directly from `registry.ts:182` and never renders a disabled row.

This is distinct from the documented `run`-threading deferral: the module isn't partially wired, it's entirely unreferenced. Every test uses a synthetic `base: CommandDef` fixture, so the suite would pass identically if every real command's metadata were wrong or absent. The plan's "Stable target" and "Unavailable presentation" (hide vs. disable) acceptance rows are unmet.

---

### 8. Rendering Debug Mode silently lost its danger badge, and the test was updated to bless the loss

`sessionCommands.renderer.test.ts:93-104`. The original assertion was `{label:'On', tone:'danger'}` with the comment *"The red On badge is a safety signal, not decoration: while active the mode captures clicks before ordinary controls."* The new assertion accepts a plain `toggle` and re-writes the comment to *"the warning moved from a danger colour into a detail string."*

`describeCommandState` (`commandState.ts:122-141`) can **never** return `danger` for a `kind: 'toggle'` — only `status('error', …)` is danger. The detail string surfaces solely as an HTML `title=` tooltip (`CommandPalette.tsx` `CommandStateBadge`). So a visible red safety signal became a hover tooltip. The plan's audit row for `toggle-rendering-debug-mode` says explicitly: *"retain danger semantic state."* This is a characterization snapshot updated to match what the code now does rather than what the plan requires.

---

### 9. `savedSessionListing` is declared, asserted, and consumed by nothing

`getProviderFeatures` is read at four sites in `sessionCommands.ts` (`switchTargets`, `transcriptRewind`, `verifiedExternalResumeCommand`, `transcriptDuplicate`). `savedSessionListing` has no consumer anywhere. `resume-session` (`tabCommands.ts`) has no `when` guard at all and still runs `ui.enterResumeMode()` unconditionally.

`providerFeatures.test.ts:37-43` and `:68` assert `opencode.savedSessionListing === false` under the heading *"leaves OpenCode unavailable for every unsupported operation"* — for Resume, that is asserted, not true. Plan Phase 5 item 2 lists Resume first.

---

### 10. `keybindingBaseline.test.ts` calls itself load-bearing while comparing two hand-authored tables

- `:280-311` — *"THE LOAD-BEARING ASSERTION … A chord that silently stopped working would fail here."* It compares the literal `BINDING_BASELINE` array (same file) against `resolveEffectiveKeybindings({})`, which is `buildDefaultKeybindings()` — another hand-authored literal. Two constants agreeing. Given finding #3, chords *have* silently changed behaviour and this passes.
- `:339-389` — the whole "recorded authority drift" block asserts properties **of `BINDING_BASELINE` itself** (filter it, compare to a hardcoded list). Unfalsifiable except by editing the table.
- `:340` — titled *"lists exactly the six commands…"*, expects an array of **five**. Nobody read it.

---

### 11. The Settings conflict checker hardcodes `context: 'global'`, defeating the mechanism `resolve.ts` documents

`CommandKeybindingsRow.tsx:181` always passes `context: 'global'` to `findBindingOwners`, and calls `resolveEffectiveKeybindings(overrides, defaults)` without the `contextForCommand` resolver. `resolve.ts:96-131` writes 35 lines explaining why that resolver exists and gives the exact failing example — *"unbind nav-up, then assign Alt+K to the grid-only rotate-layout … a 'global' context reports it as overlapping Dispatch and rejects the binding."* That is precisely what the UI does. The parameter has no caller that supplies it.

`editor.test.ts:24-82` mirrors the bug (every case passes `context: 'global'`) rather than catching it. Also unexercised: the `applyReplace` path is hand-modelled in the test (`editor.test.ts:90-94`) rather than invoked, so a divergence in the component wouldn't fail; `syntaxError` state is only ever set to `null`, so that error surface is dead.

---

### 12. Per-keystroke cost and auto-repeat coalescing on the new routed path

- `routedCommandForEvent` calls `buildDefaultKeybindings()` on **every keydown** (`useKeybinds.ts:222`) — 25 entries constructed and `normalizeKeybinding`-parsed per keystroke, including every character typed into a composer, since `keybindingFromEvent` returns non-null for bare letters.
- Every routed chord goes through `requestCommandInvocation` → `commandPaletteOpen: true` (`uiShell/slice.ts:60`) → mounts `OpenCommandPalette`, which assembles the ~76-callback `commandContext` and runs `buildCommandRegistry` over all 98 commands (`CommandPalette.tsx:718`), dispatches, then unmounts. This now happens on `Alt+H/J/K/L` pane navigation and `Cmd+[`/`Cmd+]` — the exact cost #494 restructured the palette to avoid. The store comment calls a keypress "equally rare and equally intentional" as a menu click; navigation chords are neither.
- The store holds a single `pendingCommandInvocation`. Two keydowns landing before React flushes coalesce to one dispatch, so held-down navigation drops repeats. `e.repeat` is not filtered.

No test covers any of this.

---

### 13. The retired-feature comment lost its terminator and now mis-documents a live setting

`app-state/settings/types.ts:344-355`: removing `dispatchProjectTerminal` deleted the field *and* its closing `*/`. The stale block describing the removed Dispatch project terminal now swallows the opening `/**` of the next doc comment and terminates on `autoSendPromptSuggestion`'s `*/`. It compiles, so nothing catches it — but the commit is titled "remove Attach Project Terminal to Dispatch end to end" and the plan lists "stale migration comments" as in scope.

---

### 14. Tautologies and coverage gaps worth cleaning up

- `scripts/check-command-keybindings.mts:146-152` — "Context sanity" checks `!contextsOverlap(entry.context, entry.context)`; `contextsOverlap` returns `true` immediately on `a === b` (`defaults.ts:49`). The rule can never fire. `reservations.test.ts:31-33` asserts the same identity.
- `catalog.test.ts:214` (`98 - 4 === 94`) and `:315` (`98 + 5 - 1 === 102`) are arithmetic on a value asserted three lines earlier.
- `editor.test.ts:145-150` — *"offers a row for every categorized built-in command"* compares `catalog.filter(c => c.category).length` to `catalog.length`. It duplicates `taxonomy.test.ts:35` and says nothing about `CommandKeybindingsRow` producing rows.
- `commandState.test.ts:94-102` regex-matches `getState.toString()` for `tone: '…'`. `CommandState` no longer has a `tone` field, so `tsc` already forbids it; the regex would miss `tone:"accent"`, a variable, or a helper.
- `routing.test.ts:63-68` — *"keeps palette-self commands out of the close-after-run rule"* asserts `PALETTE_SELF_EXCLUDED_COMMAND_IDS.has('open-command-palette')`, a Set literal containing that exact string. Deleting the guard from `CommandPalette.tsx` (which is the rule) breaks nothing.
- **No test mounts** `CommandPalette`, `CommandKeybindingsRow`, `CloseConfirmationDialog`, or `CloseOldAgentsModal` — every new UI surface in the PR.
