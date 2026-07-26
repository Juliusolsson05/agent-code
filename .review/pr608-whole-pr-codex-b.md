# PR608 whole-PR (Codex B) (codex)

sessionId: 818fa7fc-285c-4b15-994e-9733d3429f94

---

The plan is not fully implemented. Ranked findings:

1. **High — Built-in keybinding configuration is not the runtime authority.**  
   `src/renderer/src/workspace/tile-tree/useKeybinds.ts:181-226` restricts routing to 24 hard-coded IDs, although Settings offers all 98 commands. A custom binding for an unbound command such as Debug Panel or Tiled Dispatch is stored and displayed but never executes. Old handlers also remain at `:371-431`, `:648-688`, and `:843-916`, so explicitly unbinding or rebinding Close Pane, navigation, splits, Quick Open, etc. leaves the old chord operational outside the gateway. Editor Save is omitted from the routed set and remains hard-coded in `MonacoFileEditor.tsx:233-241` and `EditorWorkbench.tsx:229-241`. This directly breaks binding control, curated-default, invocation-parity, and “rebinding Save removes Cmd-S” acceptance rows.

2. **High — Destructive close confirmation is bypassable and grants are not target-bound.**  
   `src/renderer/src/workspace/hook/actions/pane.ts:1283-1295` exposes `closeSession` without confirmation, while `AgentActivityModal.tsx:281` calls it directly; a running parent and its linked descendants can therefore be killed with no running/cascade dialog. Close Old Agents previews only root rows at `CloseOldAgentsModal.tsx:295-322`, but `closeSession` subsequently cascades through descendants, allowing a live child omitted from the preview to be killed. Separately, `closeFocused` confirms at `pane.ts:1107-1113` and then `closeLinkedChildren` re-enumerates at `:746-753`, so a child created after confirmation is covered by no grant but still killed. `closeTab` similarly captures IDs before its modal at `tab.ts:89-113` and never revalidates them. This fails the “every source, freshly validated, exact cascade” safety requirement.

3. **High — Dangerous Agents still applies an unsafe, unobservable partial fleet change.**  
   `src/renderer/src/features/settings/lib/settingsRegistry.ts:796-812` persists the new value immediately and starts reload with no confirmation, affected-agent preview, single-flight guard, or loading/Mixed/error state. `workspace/hook/actions/session.ts:1010-1049` swallows kill failures and records spawn failures, while `:1087-1125` removes failed sessions from tabs, buried state, and detached state; the function still resolves successfully. The persisted setting can therefore say “enabled” after only part of the fleet applied it, with failed panes silently removed and no rollback/report.

4. **High — The Agent Management MCP close grant has no production issuance path.**  
   `src/main/agentManagement/AgentManagementBridge.ts:240-241` defines `issueCloseGrant`, but its only callers are tests; production issuance is **absent**. The MCP tool calls `closeAgent` directly at `src/mcp/runtime/createBuiltInMcpServer.ts:311-314`, which always consumes a nonexistent grant at `AgentManagementBridge.ts:265`. Thus every legitimate explicitly requested close is denied. The prose rule was replaced by a fail-closed but unusable mechanism, not a usable user-issued grant or renderer confirmation.

5. **Medium — Phase 2’s availability/target/safety implementation is scaffold-only.**  
   `src/renderer/src/features/command-palette/types.ts:423-455` leaves category, target, risk, and unavailable metadata optional. Production command declarations of `targetKind`, `risk`, and `unavailableReason` are **absent**. `resolveCommandInvocation`/`resolveCommandAvailability` have no production callers, while `registry.ts:162-184` still filters failed admission out rather than rendering disabled rows with reasons. Consequently unsupported capabilities, empty undo stacks, and unsupported Caffeinate appear hidden or executable rather than consistently disabled and explained; risk and target/scope also cannot feed Settings or confirmation policy.

6. **Medium — Provider policy is only partially authoritative.**  
   `src/providers/shared/featureCapabilities.ts:20-50` omits the planned rendered-feed and launchability capabilities. Resume has no provider gate at `tabCommands.ts:51-58`; OpenCode focus is propagated into an empty listing at `CommandPalette.tsx:351-381`. Copy Resume still gates on generic agenthood at `sessionCommands.ts:759-765`, and Switch Provider does the same at `:889-897`, so both remain executable on OpenCode despite its declared capability table. Provider creation at `paneCommands.ts:22-35` and generated splits at `:298-321` perform no setup/binary-readiness admission. Rewind, Duplicate, Reload, and the built-in MCP matrix are correctly gated, but the full Phase 5/acceptance matrix is not.

7. **Medium — Required semantic and async states remain explicitly unimplemented.**  
   Tiled Dispatch has no state at `layoutCommands.ts:49-59`; Remote Control has none at `remoteCommands.ts:3-14`; Session Recording says its state is “future work” at `sessionCommands.ts:986-990`; Color Flag declines state at `dispatchColorFlagCommands.ts:14-16`. Caffeinate models unsupported but not loading/error at `layoutCommands.ts:122-126`. No persistent pending/error lifecycle exists for MCP replacement, reload, switch, or recording. The semantic union landed, but the Phase 6 state matrix did not.

8. **Medium — Successful-history and single-flight semantics are incorrect for fire-and-forget/caught failures.**  
   `executeCommand.ts:217-248` considers a command successful as soon as `run` resolves. Close Tab and Close Pane discard their promises at `tabCommands.ts:18-20` and `paneCommands.ts:77`, so declining a later confirmation still records a successful invocation and immediately clears single-flight. Other commands catch operational failures internally—for example MCP reload at `sessionCommands.ts:368-374`—and therefore also count as success. Canceled, failed, and still-running work consequently inflates history despite the explicit acceptance rule.

9. **Medium — Current-profile collision handling uses the wrong contexts and permits registration-order resolution.**  
   `CommandKeybindingsRow.tsx:81-94` calls `resolveEffectiveKeybindings` without the command-context resolver, then checks every newly captured binding as `context: 'global'` at `:179-185`. This falsely rejects legal grid/Dispatch reuse that the overlap matrix explicitly allows. Persisted overrides are only syntax-coerced in `resolve.ts:39-73`; cross-command collisions are not validated at load/runtime. If a conflicting profile exists, `useKeybinds.ts:222-225` simply returns the first catalog entry, making registration order the winner—the exact policy the plan forbids.

10. **Medium — Settings information architecture and nested command discoverability were not shipped.**  
    `settingsCategories.ts:1-51` still has seven old categories instead of the specified nine. Global Settings search filters only parent setting metadata at `SettingsPage.tsx:56-63` and `settingsRegistry.ts:858-872`, so searching for a nested command title cannot reveal Keyboard Shortcuts or Command Visibility. The visibility editor remains a flat title-only list at `SettingsList.tsx:187-209`; it does not group or expose/search description, effective bindings, tier, target/scope, and risk. This fails Phase 3, Phase 8, and the Discoverability acceptance row.

11. **Low — Project-terminal behavior is removed, but the promised end-to-end cleanup is incomplete.**  
    `layoutCommands.ts:13` still tells users Dispatch includes an “optional project terminal.” `DispatchLayout.tsx:73-77` still computes an unused terminal target, and `settings/types.ts:344-355` retains the removed setting’s historical comment. The actual auto-create/column/action/persistence behavior is gone and ordinary terminals remain intact, but the user-facing description and specifically requested stale-code cleanup were missed.

Fully covered areas: the exact final 98-command catalog and five retirements plus `open-command-palette`; native-menu lookup outside picker visibility; tier/category classification; the exact six-command Navigation group and persistence; retired-setting migrations; sparse keybinding override semantics and static default/reservation checker; Claude/Codex/OpenCode built-in MCP injection matrix, including Codex-only Workflow MCP; and behavioral removal of the Dispatch project-terminal feature.

Validation passed: TypeScript build, `npm run check:keybindings`, and 229 focused unit tests across 11 files.

Review references committed `HEAD`. After validation, an external working-tree edit appeared in `useKeybinds.ts` containing `return null // SABOTAGE`; it is not in the PR commit and was excluded from findings. I did not create or revert it.
