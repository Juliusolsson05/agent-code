# PR608 whole-PR (Claude A) (claude)

sessionId: d66d9e34-388d-4231-8754-e0d99f9c78ef

---

Review complete. `npx tsc -b` exits 0, `npm run check:keybindings` passes, and all 19 new/changed test files (307 tests) are green — every finding below is a latent defect that the suite does not catch.

---

## 1. `close_agent` MCP tool is dead in production — nothing ever issues a grant

`src/main/agentManagement/AgentManagementBridge.ts:265` refuses the close unless `this.closeGrants.consume(caller, target)` returns true. `issueCloseGrant` (`:240`) has **zero production call sites** — `grep` finds it only in `AgentManagementBridge.test.ts` (4 hits). There is no IPC handler (`src/main/ipc/agentManagement.ts` registers only `agent-management:response`), no renderer confirmation, no preload surface.

**Failure:** user enables Agent Management MCP on a Codex agent, says "close agent X", the model calls `agent_management_close_agent`. `consume` finds no grant → throws *"no user authorization for this agent"*. This happens 100% of the time, forever. The prose the plan called unenforceable (`createBuiltInMcpServer.ts:301`) is still shipped and now describes a tool that cannot run at all.

The tests are green because they call `bridge.issueCloseGrant('caller','agent-1')` directly (`AgentManagementBridge.test.ts:143,280,391,410`) — they prove the grant *mechanism* and cannot observe the missing *wiring*. The plan required "a short-lived user-issued caller/target authorization **or** renderer confirmation"; neither exists.

## 2. Configured-chord routing runs before the editor-ownership bailout — ⌘W in the Global Editor kills a workspace session

`useKeybinds.ts:364` evaluates `routedCommandForEvent` and returns at `:369`. The editor bailout is at `:442`. Neither `EditorWorkbench` nor `MonacoFileEditor` is an app-interaction owner (they carry `data-global-editor-input-owner`, not `data-agent-code-interaction-owner`), so `hasAppInteractionOwner()` at `:310` is false.

**Failure:** open the Global Editor, click into Monaco, press ⌘W to close the file tab. `keybindingFromEvent` → `Cmd+W` → matches `close-pane` (`defaults.ts:96`, in `ROUTED_COMMAND_IDS`) → `preventDefault` + gateway → `close-pane` has `surface:'session'`, no `when`, no render policy → admitted → `workspace.closeFocused()` kills the focused agent behind the editor. ⌘[ / ⌘] likewise now switch tabs instead of running Monaco outdent/indent.

This directly falsifies the approved-overlap justification recorded at `reservations.ts:197-201`: *"useKeybinds bails out for editor-owned targets, so the workspace's close-pane handler cannot fire while editor chrome has focus."* The static checker passes **because** it trusts that text.

## 3. The runtime router ignores `BindingContext` — Dispatch keyboard navigation is dead

`routedCommandForEvent` (`useKeybinds.ts:216-227`) matches `entry.bindings.includes(binding)` and never reads `entry.context`. The Dispatch row/lane block sits at `:746-790`, unreachable for those chords.

**Failure:** enter Dispatch Mode, press ⌥↓ (or ⌥J) to move the row selection. Binding resolves to `Alt+Down` → `nav-down` (`defaults.ts:112`, context `'grid'`) → routed → gateway → `surfaceAvailable('grid', ctx)` returns `!dispatchModeEnabled` = false → `{status:'unavailable'}` → **nothing happens**. Same for ⌥↑/⌥K, and ⌥←/⌥→/⌥H/⌥L (tiled lane switching). The reservation registry explicitly declares these as `'Dispatch row and lane selection'` in the `dispatch` context (`reservations.ts:59-62`) and the disjointness matrix exists precisely to allow this — but the router that would honour it doesn't consult contexts.

Same root cause silently removes ⌥D/⌥⇧D/⌥T/⌥⇧T/⌥C/⌥⇧C in Dispatch (all `context:'grid'`, `surface:'grid'`), which previously created detached agents through `splitFocused`'s heavily-documented Dispatch branch (`pane.ts:229-303`). `paneCommands.ts:50-51` still asserts *"Power-user keybinds (⌥D etc.) still fire in Dispatch"* — no longer true.

## 4. Unbinding or rebinding a command leaves the old chord fully live

Every legacy hard-coded branch survives below the routed lookup: ⌘T (`:648`), ⌘⇧R (`:658`), ⌘⇧W (`:670`), ⌘W (`:675`), ⌘[ / ⌘] (`:680`,`:685`), ⌘⌥E (`:378`), ⌘P (`:396`), ⌘⇧F (`:418`), ⌥D/⌥T/⌥W/⌥HJKL/⌥arrows (`:843-928`), `End` (`:931`). They are shadowed only while `routedCommandForEvent` returns non-null.

**Failure:** in Settings → Commands & Shortcuts, remove ⌘W from Close Focused Session (writes `commandKeybindingOverrides['close-pane'] = []`). Row now reads "Not assigned". Press ⌘W → routed lookup returns null → falls through to `:675` → `void workspace.closeFocused()` → the pane closes anyway. Identically, rebind `new-tab` to ⌘⌥N: ⌘⌥N works *and* ⌘T still opens a new tab via `:648`.

This is exactly acceptance item 15 ("…without leaving the former chord active"). `routing.test.ts` cannot catch it — it asserts only on `resolveEffectiveKeybindings` output and says so in its own docstring.

## 5. Phase 5 capability gates landed on the wrong commands; OpenCode keeps two of the five unsupported operations

| Command | Plan-required gate | Shipped gate | Effect |
|---|---|---|---|
| `switch-provider` (`sessionCommands.ts:871`, `when` at `:895`) | `switchTargets` | `isAgentProviderKind(kind)` | **OpenCode still gets Switch Provider** |
| `copy-resume-command` (`:741`, `when` at `:764`) | `verifiedExternalResumeCommand` | `isAgentProviderKind(kind) && providerSessionId` | **OpenCode still gets Copy Resume Command** |
| `view-prompts` (`:71`, `when` at `:85`) | transcript/history | `getProviderFeatures(kind).switchTargets.length > 0` | OpenCode loses View Prompts; feature now depends on switch edges |
| `reload-agent` (`:632`, `when` at `:658`) | resumability | `verifiedExternalResumeCommand` | in-app restart depends on an external CLI template being verified |
| `resume-session` (`tabCommands.ts:51`) | `savedSessionListing` + focused cwd | **no `when` at all** | Resume on an OpenCode pane still opens the empty modal the audit named |

The comments prove the shuffle: the *switch-edge* rationale is pasted verbatim into `view-prompts` (`:82-84`) and the *"hands the user a shell command"* rationale into `reload-agent` (`:654-656`). Only `rewind-to-prompt` and `duplicate-agent` got their correct predicates.

**Failure:** focus an OpenCode pane, open the palette with reveal-all, type "switch" → *Switch Provider* is an ordinary enabled row → `workspace.switchFocusedProvider()` with `switchTargets: []`. Type "resume" → *Copy Resume Command* copies an unverified CLI string. Meanwhile "prompts" shows nothing.

`providerFeatures.test.ts` asserts only the `FEATURES_BY_KIND` table. No test anywhere evaluates a command's `when` against an OpenCode context (`grep opencode` across the command-palette tests hits only the two generated split ids). The acceptance criterion "OpenCode Resume/Rewind/Duplicate/Switch/Copy Resume are unavailable" is **tested vacuously**.

## 6. `closeFocused` confirms the wrong target set when the pane is the tab root

The gate at `pane.ts:1106-1114` expands via `expandSessionCloseTargets` — target + linked descendants only. But when `parentInfo` is null (root pane), `:1176-1178` builds `detachedTabChildren(closeSnapshot, tab.id)` and `:1217` kills all of them.

**Failure:** a tab with one visible pane (idle) and six detached Dispatch agents parked against it. Press ⌘W. Expansion returns `[thatOnePane]`, `targets.length === 1 && !live` → `{required:false}` → no dialog → the tab collapses and **all seven** sessions are killed. `expandTabCloseTargets` — which exists for exactly this and is used correctly in `tab.ts:106-108` — is not called here. Same gap when `closeFocused` delegates to `closeSession` for a Dispatch/related-child target whose leaf is a tab root.

## 7. Plain `End` is hijacked from text editing

`jump-latest-message` ships bare `End` with `context:'feed'` (`defaults.ts:130`) and is in `ROUTED_COMMAND_IDS`. The routed lookup at `:364` precedes the legacy handler at `:931`, which was the only place `!isTextEditingTarget(e.target)` was checked.

**Failure:** type a multi-line prompt in the composer of a Claude pane, press `End` to jump to end of line. Binding `End` → `jump-latest-message` → `preventDefault()` → gateway admits (session is non-terminal with a rendered feed) → `scrollFocusedToLatest()`. The caret does not move and the feed scrolls to the bottom.

## 8. Close Old Agents' "re-enumerate before every kill" is a no-op

`CloseOldAgentsModal.tsx:315` calls `buildCloseTargets(workspace)` inside the sequential loop, where `workspace` is the object captured by the `useCallback` closure at click time. `useWorkspace` builds `{state, runtimes, …}` fresh each render from zustand selectors (`hook/index.ts:95-98, 834-836`) — that is precisely why `pane.ts` reads `refs.stateRef.current` instead. The closure's `workspace.state` / `workspace.runtimes` never change during the loop.

**Failure:** approve closing 12 idle agents; agent #9 starts streaming during kill #3. `narrowGrantToCurrent([target], current)` compares the grant against the click-time snapshot, where #9 is still idle → not skipped → killed mid-turn. `outcome.skipped` can never be non-empty from state change. `closeConfirmation.test.ts` tests `narrowGrantToCurrent` as a pure function, so the integration bug is invisible.

## 9. `closeSession` has no confirmation gate — the Agent Activity modal closes running/cascading sessions silently

Confirmation was added to `closeFocused` and `closeTab` only. `AgentActivityModal.tsx:281` (`closeRow`, reachable from the row button at `:449` and Enter at `:347`) calls `workspace.closeSession(row.sessionId)` directly, and `closeSession` (`pane.ts:1283`) cascades linked children (`:1294`) and tab-detached children (`:1333-1336`) with no prompt. Phase 7 item 4 required confirmation "from every source, including buttons".

**Failure:** open Agent Activity, click × on a mid-stream agent that has two linked review children → three sessions die immediately, no dialog, no count.

## 10. Settings binding capture hardcodes `context: 'global'`; `contextForCommand` is dead code

`CommandKeybindingsRow.tsx:181` passes `context: 'global'` for every command, and `resolveEffectiveKeybindings` is called at `:83`/`:93` without the third argument. `grep contextForCommand` finds only its own declaration and use inside `resolve.ts:107,137` — no caller ever supplies it.

**Failure:** the scenario `resolve.ts:126-131` documents as the reason the parameter exists. Unbind `nav-up`, then assign ⌥K to the grid-only `rotate-layout`. `findBindingOwners` with `context:'global'` matches the `dispatch`-context reserved entry (`contextsOverlap('dispatch','global')` is true), the save is blocked, and because the owner is `kind:'reserved'` the UI offers no Replace — only *"Reserved by the app — pick a different chord."* The whole context system is inert for user edits.

## 11. Save Editor File cannot actually be rebound

`defaults.ts:125` declares `save-editor-file` → `Cmd+S` and the comment promises *"removing those two hard-coded paths is what makes rebinding real."* They were not removed: `MonacoFileEditor.tsx:239` still registers `KeyMod.CtrlCmd | KeyCode.KeyS`, and `save-editor-file` is absent from `ROUTED_COMMAND_IDS`.

**Failure:** rebind Save Editor File to ⌘⌥S. Settings and the palette show ⌘⌥S; pressing it does nothing; ⌘S still saves. `keybindingBaseline.test.ts` explicitly `continue`s past `owner !== 'useKeybinds'`, so this is partially disclosed — but it contradicts a stated acceptance criterion and the file's own comment, and the same is true of the ⌘W editor action at `MonacoFileEditor.tsx:246`.

## 12. Every keystroke rebuilds the default binding table; every routed chord mounts the whole palette

`routedCommandForEvent` calls `buildDefaultKeybindings()` (~35 `parseKeybinding` calls plus provider-registry reads) on **every** keydown, including plain typing — `keybindingFromEvent` returns non-null for bare letters. And `requestCommandInvocation` (`uiShell/slice.ts:60-64`) sets `commandPaletteOpen: true`, so ⌥H/⌥J pane navigation now mounts `OpenCommandPalette`, assembles the ~76-dependency `commandContext`, runs `buildCommandRegistry` over 98 definitions, mounts a Radix `DialogContent`, and unmounts — per keypress. The `#494` comment in `CommandPalette.tsx:194-198` argues this cost is acceptable *"a menu click is rare and intentional"*; that premise no longer holds. I could not measure the frame impact without running the app, so treat the magnitude as unverified — the per-keystroke work itself is confirmed by reading.

## 13. Nothing rejects a modifier-less binding in the capture UI

`CommandKeybindingsRow.tsx:171-206` accepts any `keybindingFromEvent` result; `parseKeybinding` allows zero modifiers (`jump-latest-message` relies on it). Bare letters have no reservation owner, so binding `A` to `close-pane` saves cleanly. Combined with #3/#7 (the router applies neither context nor a text-editing guard), typing "a" into a composer would then close the pane. Requires deliberate user action, hence low — but it is the same missing guard.

---

## Clean

- **Picker visibility never gates execution.** `isVisibleInPicker` has exactly two consumers — `commandVisible` in `registry.ts:132` and `listPickerCommandMeta`. `executeCommand.ts` and `canDispatchCommand` resolve from `builtInCommandCatalog` and call only `commandApplicable`; the native-menu path in `CommandPalette.tsx:940` goes through the gateway. The plan's highest-severity original defect is genuinely fixed, including the `assertNever` fallthrough.
- **Persistence coercion.** Retired-key omission (`persistence.ts:56,250`), the absent/`[]`/non-empty tri-state, the "non-empty-but-all-unparseable → drop the key" rule, retired-ID pruning with unknown IDs preserved, and the `8 → 10` version bump all hold. I could not construct a data-loss or resurrection scenario.
- **The normalizer.** Numpad exclusion, trailing-`+` rejection, multi-step rejection, `event.code` for Option-letters/punctuation, and display-form purity are all correct, and `displayKeybinding` failing soft on a malformed value is right.
- **`closeConfirmation.ts` as a module.** Transitive expansion with a cycle guard, ID-set (not count) grant comparison, and the started-working drop in `narrowGrantToCurrent` are sound. The defects are at the two call sites (#6, #8), not in the policy.
- **Kill Buried** (`pane.ts:1763-1783`) — unconditional second confirmation before any mutation, using the shared liveness rule. Correct.
- **Catalog integrity** — the 98-ID ordered snapshot, generated-provider parity, the six-member navigation group, and the group-before-override precedence are all asserted non-vacuously.
