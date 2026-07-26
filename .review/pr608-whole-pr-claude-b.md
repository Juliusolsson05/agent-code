# PR608 whole-PR (Claude B) (claude)

sessionId: 6c2ff61d-59df-4972-80f3-86ffb3efebd2

---

I reviewed the whole branch: read the plan, all 20 commits, and the ~50 changed files; verified claims against implementations; ran `tsc -b` (exit 0), `npm run check:keybindings` (OK), and the 22 touched test files (335 tests pass at `--maxWorkers=4`).

The headline: the *structural* work (catalog split, gateway, picker-visibility separation, normalizer, persistence/coercion, native-menu fix, derived tone) is genuinely built and matches its comments. The *wiring* is where it breaks — three subsystems have authoritative-sounding gates with no caller, and the keybinding router was inserted above the gate that protected the editor.

---

## Ranked findings

### 1. CRITICAL — Agent Management MCP `close_agent` is dead: the grant has no issuer
`src/main/agentManagement/AgentManagementBridge.ts:265` refuses every close unless `closeGrants.consume(...)` returns true. `issueCloseGrant` (`:240`) has **zero product callers** — `grep -rn "issueCloseGrant" src/` returns only the bridge itself and three test call sites. There is no IPC handler, no renderer confirmation, no menu path. `revokeCloseGrantsForSession` (`:245`) is dead too. The tool is still registered in `src/mcp/runtime/createBuiltInMcpServer.ts`.

**Failure:** user enables Agent Management MCP on a Codex agent and says "close agent B". The model calls `close_agent`; it throws `close_agent refused: no user authorization for this agent`. There is no action the user can take to authorize it. The feature is permanently unusable, not gated.

The comment at `closeGrant.ts:12` ("A grant is issued by a USER ACTION") and commit `55e57322` ("make the … permission enforceable") both describe an issuance path that does not exist. Default-is-DENY is true; it is *only* deny.

### 2. HIGH — Two provider capability gates are attached to the wrong commands; the two commands Phase 5 exists to fix are still ungated
- `sessionCommands.ts:85` — `view-prompts.when` → `getProviderFeatures(kind).switchTargets.length > 0`, with a comment about switch edges ("*'Can switch' is meaningless without a destination*").
- `sessionCommands.ts:658` — `reload-agent.when` → `verifiedExternalResumeCommand`, with a comment about pasting a shell command into a terminal.
- `sessionCommands.ts:764` — `copy-resume-command.when` is still `isAgentProviderKind(kind)`.
- `sessionCommands.ts:895` — `switch-provider.when` is still `isAgentProviderKind(kind)`.
- `savedSessionListing` is consumed nowhere; `resume-session` (`tabCommands.ts:51`) has no `when` at all.

The two gates were transplanted onto their neighbours. **Failures:** (a) OpenCode pane → *Copy Resume Command* is enabled and copies `opencode --session <id>` (`opencode/identity.ts:13`) — the unverified guess `verifiedExternalResumeCommand: false` exists to suppress; the user pastes it into a terminal. (b) OpenCode pane → *Switch Provider* is enabled and toasts "OpenCode panes can't switch provider yet" (`provider.ts:71-77`) — verbatim the "appears enabled and gets nothing" defect. (c) An OpenCode agent dies → *Reload Agent* is **absent**, because OpenCode has no verified external CLI string, which has nothing to do with in-app reload. (d) *View Prompts* is absent on OpenCode because OpenCode has no switch edge; the plan's matrix says it should be available where a feed/history exists.

`featureCapabilities.ts:11-13` names all five commands as fixed. Two are, two are not, and two unrelated commands were broken. `providerFeatures.test.ts` only pins the capability *table* — it never asserts which command consumes which capability, which is why this passes.

### 3. HIGH — Routed chords run *before* the Global Editor ownership gate
`useKeybinds.ts:364-369` dispatches routed commands; `editorOwnsTarget` is computed at `:440`. The gate that previously stopped ⌘W/⌘[/⌘]/every Option chord from reaching the workspace while focus is inside `[data-global-editor-input-owner]` is now downstream of the router.

**Failures:**
- Focus in the Explorer/file-tab strip, press ⌘W → `close-pane` dispatches (killing the underlying agent session), and `EditorWorkbench.tsx:230` bails because `event.defaultPrevented` is already true, so the file is *not* closed. `EditorWorkbench.tsx:234-235` says letting this through "would terminate the underlying agent pane" — which is now the behaviour.
- In Monaco, ⌘[ / ⌘] switch tabs instead of outdent/indent.
- Typing ⌥D in Monaco to produce `∂` also splits a pane; ⌥W closes the focused session; ⌥H/J/K/L and ⌥arrows navigate the hidden grid. `useKeybinds.ts:445-448` states exactly this must not happen.
- The `fullscreenEditorOwnsWorkspace` swallow (`:461-480`) is bypassed the same way.

This falsifies four of the five `APPROVED_OVERLAPS` justifications (`reservations.ts:186-226`) — the ⌘W, ⌘[ and ⌘] entries all assert "useKeybinds returns early / bails out for editor-owned targets … Exactly one owner is live for a given focus." `check:keybindings` passes because rule 6 only checks the reason string is ≥40 characters, never that it's true.

### 4. HIGH — Rebinding or unbinding leaves the old hard-coded chord live and gateway-free
The diff removes only three legacy branches (⌘⇧P, ⌘⇧E, ⌘⇧T). Still hard-coded below the router: ⌘T, ⌘⇧R, ⌘⇧W, ⌘W, ⌘[, ⌘], ⌘P, ⌘⇧F, ⌘⌥E, ⌥D/⌥⇧D, ⌥T/⌥⇧T, ⌥C/⌥⇧C, ⌥W, ⌥H/J/K/L, ⌥arrows, bare `End` (`useKeybinds.ts:378-939`). They are unreachable *only while the shipped default still matches*.

**Failure:** Settings → Keyboard Shortcuts → remove ⌘W from "Close Focused Session" (writes `[]`, the documented "explicitly unbound"). `routedCommandForEvent` no longer matches, execution falls to `:675-679` `if (k.toLowerCase() === 'w' && !shift) { void workspace.closeFocused() }`. The pane still closes — on a chord the user deliberately deleted, bypassing admission, history and single-flight. Same for rebinding `split-vertical` off ⌥D, `next-tab` off ⌘], etc.

`ROUTED_COMMAND_IDS`' docstring says the router hands these to the gateway "**instead of** calling a workspace action directly." It is *in addition to*, with the direct path as a live fallback.

### 5. MEDIUM-HIGH — `save-editor-file` is advertised as rebindable and isn't routed at all
Declared at `defaults.ts:125` (⌘S, context `editor`) and given a Settings row with an editable/removable chip, but absent from `ROUTED_COMMAND_IDS`. Monaco's `addAction` (`MonacoFileEditor.tsx:243-246`) and EditorWorkbench's bubble handler still own ⌘S. **Failure:** user rebinds Save to ⌘⌥S — nothing happens on ⌘⌥S, and ⌘S still saves. `defaults.ts:121-125` is honest ("removing those two hard-coded paths is what makes rebinding real"); the UI is not.

### 6. MEDIUM-HIGH — `src/mcp/shared/closeGrant.ts` is a binary file to git
Line 55 embeds a **literal NUL byte** (offset 2697) as the map-key separator instead of `\u0000`:
```
const key = (caller, target) => `${caller}<U+0000>${target}`
```
`git diff --stat` reports `Bin 0 -> 4312 bytes`; `file` reports `data`. **Failure:** the module is unreviewable in the PR diff on GitHub — which is how a security-relevant authorization file (finding #1) shipped with no diff review at all; `git merge`/`rebase` cannot 3-way-merge it and will raise a binary conflict; `git log -p`/`blame` are useless on it. Fix is one character class: write `\u0000` in the template literal, behaviour identical.

### 7. MEDIUM — Close Old Agents does not re-enumerate; it re-reads a frozen snapshot
`CloseOldAgentsModal.tsx:315` calls `buildCloseTargets(workspace)` per iteration, but `workspace` is closed over from the render that created `closeMatchingAgents`. `WorkspaceContext.tsx:12-17` documents that the workspace object is a fresh per-render value and "a stale snapshot is a correctness bug, not a perf win". Every iteration therefore returns an identical result; the loop is blind to everything that changes while it runs.

**Failure:** preview lists 12 idle agents; during the 12 sequential `closeSession` round-trips one of them starts streaming; `narrowGrantToCurrent` reads the frozen `live: false`, does not skip it, and it is killed mid-turn. The comment at `:305-314` claims precisely this is prevented ("one of the idle agents in the list can wake up and start working. A grant checked once at the top would authorize killing it"). Fix: read through a live ref / `getState()`, not the captured object.

### 8. MEDIUM — Single and tab closes never bind the grant to the approved id set
`pane.ts:1086-1114` and `tab.ts:95-111` compute the confirmation from a snapshot taken *before* the await, then commit against that same pre-await snapshot. `grantStillMatches` (`closeConfirmation.ts:103`) is documented as "what stops a stale grant authorizing work the user never saw" and has **no product caller** (tests only). Meanwhile `closeLinkedChildren` (`pane.ts:746-754`) re-reads `refs.stateRef.current.sessions` at commit time.

**Failure:** ⌘W on a linked parent; dialog says "This closes 2 sessions"; while it is open the parent's orchestration MCP spawns a third linked child; user clicks "Close 2"; three sessions die. The plan requires "bind confirmation to exact expanded IDs" and "a stale preview must not authorize a later changed target set."

### 9. MEDIUM — Phase 2's typed target/availability/safety layer has no product consumers
`resolveInvocation.ts` is imported only by its own test (`grep` for `resolveCommandInvocation|resolveCommandTarget|resolveCommandAvailability|targetStillValid` outside the module and its test returns nothing). No catalog command declares `targetKind`, `risk`, or `unavailableReason`. `buildCommandRegistry` still calls `command.getState(ctx)` directly (`registry.ts:182`).

Consequences: no command can ever render as "disabled with a reason" (the plan's product decision #1 and the whole `presentation: 'hide' | 'disable'` axis); no target is pinned anywhere in the running app; no mutation boundary calls `targetStillValid`. Beyond the acknowledged run-threading gap, `resolveInvocation.ts:141-146` claims the pinned identity "is currently useful for DISPLAY (the badge and the row describe a known session)" — the palette does not use it for the badge either.

### 10. MEDIUM — The binding-context matrix is unreachable from the only UI that uses it
`CommandKeybindingsRow.tsx:181` hardcodes `context: 'global'` for every command being edited, and no caller anywhere passes `resolveEffectiveKeybindings`' `contextForCommand` resolver (`:83`, `:93`; `useKeybinds.ts:222`; `registry.ts:158` — all 1–2 args). `resolve.ts:99-107` states "Callers that already hold the catalog (Settings, the runtime router) pass a resolver" — neither does. `resolve.ts:126-131` spells out the exact case that should work and doesn't: unbind `nav-up`, assign ⌥K to the grid-only `rotate-layout` → rejected as overlapping Dispatch, because 'global' overlaps everything. Direction is safe (over-blocking), but the documented promise is not delivered.

### 11. MEDIUM — Every routed chord mounts and destroys the entire command palette
`uiShell/slice.ts:60-63` sets `commandPaletteOpen: true` for **every** keybinding invocation; `CommandPalette.tsx:199` then mounts `OpenCommandPalette`, which subscribes ~76 selectors, builds the full registry over 98 commands, resolves effective bindings, reads recent history from localStorage and mounts a Radix Dialog — then unmounts in `useLayoutEffect`, plus a localStorage write from `recordCommandUse`.

`uiShell/types.ts` justifies this with "A keypress is equally rare and equally intentional [as a menu click]." That is false for the routed set: ⌥H/J/K/L pane navigation, ⌘[/⌘] tab switching and `End` are held/repeated chords, and the handler never checks `e.repeat`. **Failure:** holding ⌥J to walk a grid performs one full palette mount/unmount + localStorage read+write per key repeat, where the pre-PR path was a direct `workspace.navigate('down')`.

### 12. LOW-MEDIUM — Phase 6/7 items the commits present as complete
- No `getState` for `tiled-dispatch`, `toggle-remote-panel` (`remoteCommands.ts`), `toggle-session-recording` (`sessionCommands.ts:994`), `dispatch.color-flag.set` — the plan's Phase 6 item 3 names exactly these four.
- No pending/error lifecycle for MCP toggles, reload, switch, duplicate, recording (Phase 6 item 5). `status()` is used once, for Caffeinate (`layoutCommands.ts:125`); `sessionCommands.ts:4` imports `status` and never uses it. `commandState.ts:20-21` lists "MCP toggles and reload had no pending state at all" among the defects the module addresses.
- Dangerous Agents got a metadata badge and a copy fix only; the plan's required enable confirmation with the exact live reload set, single-flight, and Mixed/rollback (Phase 7 item 1, High in the plan's own destructive table) is absent.

### 13. LOW — `dispatchProjectTerminal`'s docstring survived its field and swallowed the next one
`settings/types.ts:344-361`: the field was deleted but the comment's closing `*/` went with it, so the block now runs to line 361 and absorbs the `/**` intended for `autoSendPromptSuggestion` (`:362`). A removed feature is still documented as present ("Dispatch Mode mounts a project terminal pane beside the agent list"), and `autoSendPromptSuggestion` lost its JSDoc entirely. Contradicts `dcf8d721` ("remove … end to end") and the plan's stale-comment requirement. (The `workspace/types.ts:322` and `layoutCommands.ts:60` notes *are* correctly updated as historical — not findings.)

### 14. LOW — assorted
- `Kill Buried Session` passes `reason: 'running'` (`pane.ts:1772`), so `CloseConfirmationDialog.tsx:47` titles it "Close a working agent?" even for an idle buried session.
- `closeConfirmationFor` (`closeConfirmation.ts:81`) derives `reason` from liveness (`live.length > 0 ? 'cascade' : 'bulk'`), not from cascade-vs-bulk as the field's own docs state. Not user-visible today — only `'running'` is branched on.
- `setCommandKeybindings` (`resolve.ts:174-183`) takes a `defaults` parameter it never reads; all three call sites pass it.
- `useKeybinds`' `onCommandPalette` parameter is now unused while `App.tsx:90` still passes `toggleCommandPalette`; ⌘⇧P no longer closes an open palette (the interaction-owner gate bails first). Escape still works.
- `CommandKeybindingsRow`'s `syntaxError` is only ever set to `null` — the "rejected with an actionable message" path is unreachable.
- The three provider `identity.ts` files are changed by a stray blank line each and nothing else.

---

## Clean, explicitly
- **Normalizer/grammar** (`normalize.ts`) — physical-code matching, numpad rejection, multi-step and trailing-`+` rejection, display-as-pure-projection: all match their comments, all genuinely tested.
- **Persistence/coercion** — retired-key omission, retired-id pruning, unknown-id preservation, `=== true` strictness, sparse absent/`[]`/non-empty semantics, version 8→10: implemented as documented, covered by `retiredKeys.test.ts` and `taxonomy.test.ts`.
- **Catalog extraction and validation** — `catalog.ts`, `findCatalogDefects`, the exhaustive `surfaceAvailable` switch with `assertNever`, frozen ordered array: as described.
- **`pickerVisibility.ts`** — group > per-command override > declared tier precedence, defensive `overrides?.[]`, and genuinely shared with Settings (the old duplicate rule was deleted, not left beside it).
- **Gateway history policy** (`executeCommand.ts`) — records only successful, admitted, user-sourced runs; excludes transient rows; single-flight; no unhandled rejections. Matches every claim.
- **`commandState.ts`** — tone is genuinely derived; no authored tone survives anywhere in the catalog; `describeCommandState` is the single render path for both row and preview.
- **Native-menu resolution** — the plan's headline defect is really fixed: the menu resolves from the full catalog with admission only, and `nativeMenuCommandIds.ts` makes the cross-process contract typed and testable.
- **Verification** — `tsc -b` exit 0; `npm run check:keybindings` OK (25 sets / 12 reservations / 5 overlaps); 22 test files, 335 tests pass.

The two fixes I'd want before merge regardless of the rest: wire an issuer for the close grant (#1) or don't land the deny, and move the routed lookup below the editor-ownership gate (#3). #2 is a small, mechanical correction with a large behavioural blast radius.
