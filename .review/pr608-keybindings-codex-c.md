# PR608 keybindings (Codex C) (codex)

sessionId: 953a8325-8e44-48c0-bdde-5112fc912713

---

## Ranked findings

1. **High — The generic router steals context-specific and editor-native keys before their owners can handle them.**  
   [useKeybinds.ts:354](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/useKeybinds.ts:354) invokes `routedCommandForEvent` before the editor/text-target guards at [useKeybinds.ts:440](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/useKeybinds.ts:440) and before Dispatch’s handlers. The resolver at [useKeybinds.ts:216](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/useKeybinds.ts:216) ignores `BindingContext`. Concrete outcomes:

   - In Dispatch, `Alt+K` resolves to global `nav-up`, gets prevented, and the gateway rejects it as unavailable; Dispatch selection never moves.
   - In Monaco, `Cmd+W` closes the workspace pane instead of the editor file.
   - In a composer, `End` invokes `jump-latest` instead of moving the caret.

2. **High — Running agents can still be killed without the new confirmation flow.**  
   Confirmation exists only in focused-pane/tab actions, while [pane.ts:1283](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/stores/actions/pane.ts:1283) exposes `closeSession` as an unconditional cascading kill. [AgentActivityModal.tsx:276](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/workspace/ui/AgentActivityModal.tsx:276) calls it directly. Select a running parent in Agent Activity and press Delete: the parent and linked children are terminated immediately, without the confirmation or affected-session preview introduced by this PR.

3. **High — “Dangerous Agents” is enabled with one click and persisted before reload succeeds.**  
   [settingsRegistry.ts:796](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/lib/settingsRegistry.ts:796) exposes the safety-critical flag as a normal toggle; [SettingsList.tsx:105](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/SettingsList.tsx:105) supplies no confirmation. The `onChange` at [settingsRegistry.ts:808](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/lib/settingsRegistry.ts:808) persists `true` before awaiting fleet reload, with no rollback. A single accidental click permanently enables the mode; a partial reload failure leaves persisted policy and live sessions inconsistent.

4. **High — Settings offers custom bindings for 74 command IDs that the router cannot dispatch.**  
   [CommandKeybindingsRow.tsx:97](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/CommandKeybindingsRow.tsx:97) renders all 98 catalog commands, but [useKeybinds.ts:181](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/useKeybinds.ts:181) accepts only 24 closed-set IDs. Bind `toggle-reader-mode` to free chord `Cmd+Shift+Y`: Settings persists it and the palette displays it, but pressing it does nothing because the router skips that ID.

   The shipped `save-editor-file` default is already affected: it is declared at [defaults.ts:121](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/command-keybindings/defaults.ts:121) but absent from the routed set; Monaco still hardcodes `Cmd+S` at [MonacoFileEditor.tsx:233](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/editor/ui/MonacoFileEditor.tsx:233). Rebinding save to `Cmd+Shift+S` changes the displayed chord, but that chord never saves.

   `check:keybindings` remains green because [check-command-keybindings.mts:76](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/scripts/check-command-keybindings.mts:76) checks defaults against catalog IDs, not catalog/default IDs against the runtime routed set.

5. **High — Explicit unbinds and rebinds do not disable legacy shortcuts.**  
   The effective resolver returns only when it finds a match; otherwise execution falls through to the old hardcoded blocks beginning at [useKeybinds.ts:648](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/useKeybinds.ts:648) and [useKeybinds.ts:843](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/useKeybinds.ts:843). Persist `{ "new-tab": [] }`: the palette correctly removes the shortcut, but `Cmd+T` still opens a tab. Close, navigation, split, resize, and `End` have the same bypass.

6. **High — Command execution discards asynchronous action lifetimes, defeating gateway error and single-flight guarantees.**  
   [executeCommand.ts:207](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/commands/executeCommand.ts:207) assumes `run()` remains pending until the action finishes. Several registrations explicitly discard promises, for example [paneCommands.ts:77](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/commands/registrations/paneCommands.ts:77). Invoke `close-pane` on a running agent: the gateway records completion and removes the single-flight entry immediately while confirmation is still open. Cancellation is recorded as a completed run, another invocation can start concurrently, and later rejection is outside gateway error handling.

7. **High — `close_agent` has no production path that can issue its required authorization grant.**  
   [AgentManagementBridge.ts:240](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/main/agentManagement/AgentManagementBridge.ts:240) defines `issueCloseGrant`, but repository search finds calls only in tests. Production `closeAgent` consumes the nonexistent grant and rejects. Even when a user explicitly asks an agent to close another agent, every `close_agent` call returns “no user authorization.” Tests hide this by manually issuing the grant.

8. **Medium — Settings accepts bare printable, dead-key, and active-IME bindings, which then hijack text entry.**  
   [normalize.ts:198](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/command-keybindings/normalize.ts:198) accepts unmodified physical codes and does not inspect `isComposing`; [CommandKeybindingsRow.tsx:161](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/CommandKeybindingsRow.tsx:161) persists any non-null result. Probes produced:

   - `{key:"Dead", code:"Quote"}` → `'`
   - `{key:"Process", code:"KeyA", isComposing:true}` → `A`

   Bind `A` to `new-tab`, then type `A` in the composer, search field, or Monaco: a tab opens and the character is lost.

9. **Medium — “Replace” is offered even when a chord also has nonreplaceable reserved owners.**  
   [CommandKeybindingsRow.tsx:187](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/CommandKeybindingsRow.tsx:187) separates command owners from reservations, but [CommandKeybindingsRow.tsx:253](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/CommandKeybindingsRow.tsx:253) offers Replace whenever any command owner exists. Assign `Cmd+W` to `open-settings`: owners include `close-pane`, the native application menu, and editor-native close. Replace removes only `close-pane` and then persists a binding still claimed by two reservations.

10. **Medium — Provider capabilities are not actually controlling two provider-sensitive commands.**  

   - `resume-session` has no saved-session-listing availability condition at [tabCommands.ts:51](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/commands/registrations/tabCommands.ts:51). With an OpenCode session focused, the command is offered and opens an empty picker because OpenCode’s main provider returns no saved sessions.
   - `reload-agent` is gated on the unrelated `verifiedExternalResumeCommand` capability at [sessionCommands.ts:649](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/commands/registrations/sessionCommands.ts:649). A resumable OpenCode session is therefore denied the command even though [provider.ts:101](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/stores/actions/provider.ts:101) can reload it.

11. **Medium — The reservation registry omits real composer ownership.**  
   [reservations.ts:39](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/command-keybindings/reservations.ts:39) does not reserve `Ctrl+C`, `Ctrl+D`, or `Cmd+Enter`, although [useComposerKeybinds.ts:427](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts:427) consumes them. Owner probing reports `Ctrl+C` as free. Bind it to `open-settings`; pressing it in the composer opens Settings instead of cancelling/clearing the PTY or draft.

12. **Medium — Letter normalization makes displayed chords incorrect on Dvorak and other non-US layouts.**  
   [normalize.ts:194](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/command-keybindings/normalize.ts:194) always derives letters from physical `event.code`, not just macOS Option glyph cases. A Dvorak event `{metaKey:true, key:"t", code:"KeyK"}` normalizes to `Cmd+K`. The palette displays New Tab as `Cmd+T`, but pressing the key producing “T” does not invoke it; users must press the physical QWERTY-T position instead.

13. **Medium — “Close Old Agents” revalidates liveness but not whether agents are still old or inactive.**  
   [CloseOldAgentsModal.tsx:276](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/CloseOldAgentsModal.tsx:276) rebuilds targets from IDs and live state only; [closeConfirmation.ts:120](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/workspace/lib/closeConfirmation.ts:120) does not recheck age or recent activity. An agent that was five hours idle at preview time but subsequently performed work and returned idle is still closed as “old.”

14. **Low/Medium — Settings treats every requested binding as global, falsely blocking disjoint contextual reuse.**  
   [CommandKeybindingsRow.tsx:179](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/settings/ui/CommandKeybindingsRow.tsx:179) hardcodes the requested context to `global`, despite [resolve.ts:97](/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/command-governance/src/renderer/src/features/command-keybindings/resolve.ts:97) supporting context-aware conflicts. After clearing `nav-up`, try adding `Alt+K` to grid-only `resize-up`: grid and Dispatch are disjoint, but Settings reports the Dispatch reservation as a conflict and refuses the binding.

## Verification

All of these completed with exit code 0:

- `npm run check:keybindings`
- Targeted normalization/editor/routing tests: 54 tests
- Targeted provider, execution, close, broker, bridge, and grant tests: 85 tests
- `npm run typecheck`

The worktree remained clean; I modified no tracked files.
