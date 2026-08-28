# Dispatch Focus Field Inventory (2026-07-06)

Exhaustive writer/reader inventory of the four dispatch focus-like fields, produced
for the future `focusDispatchTarget` helper module (the "stale focus" bug family:
#266 agents, #366 terminals, #421 dictation-adjacent). Source: full-code sweep on
main @ abf4b8c.

The four fields:
- `dispatchMode.focusedSessionId` (classic Dispatch focus)
- `dispatchMode.tiled.focusedLane`
- `dispatchMode.tiled.lanes[].selectedSessionId`
- `activeTabId` / `tab.focusedSessionId` (grid focus, fallback reader)

Existing partial-coherence helpers the future module should absorb:
`applyDispatchSpawnFocus` (pane.ts:81 — the ONLY writer that sets all three
dispatch fields atomically), `dispatchModeAfterSessionRemoval` (pane.ts:1721),
`remapTiledLanes` / `clearTiledLaneSessions` / `keepTiledLaneSessions` /
`dispatchFocusedSessionId` (tiledDispatchSelectors.ts:27/50/79/105).

## Table A — Writers

| file:line | fields written | gesture | coherent? |
|---|---|---|---|
| dispatch.ts:130-136 enterDispatchMode | classic focus carried | toggle on | n/a |
| dispatch.ts:150-155 exitDispatchMode | drops all dispatch fields | toggle off | yes |
| dispatch.ts:160-166 setDispatchScope | rebuilds WITHOUT tiled block | scope toggle | NO — silently drops focusedLane + lanes[] (D7) |
| dispatch.ts:175-196 focusDispatchSession | classic focus + activeTabId | classic list click / classic ⌥N / sync effect | PARTIAL — never tiled fields |
| dispatch.ts:212-227 enterTiledDispatch | lanes auto-fill + focusedLane=0 + classic carried | enter tiled | partial |
| dispatch.ts:235-241 exitTiledDispatch | drops tiled, keeps classic | exit tiled | PARTIAL — classic may be stale (D1/D9) |
| dispatch.ts:247-264 setTiledLaneSession | lanes[i].selectedSessionId ONLY | heal / tiled ⌥N / tiled arrows / mini-list / index | NO — #421 class |
| dispatch.ts:271-293 setTiledLaneCount | lanes slice + focusedLane clamp + ratios | tile count | partial |
| dispatch.ts:297-311 setTiledFocusedLane | focusedLane ONLY | ⌥←→/HL, lane click | PARTIAL — classic untouched |
| pane.ts:81-99 applyDispatchSpawnFocus | ALL THREE when tiled | (spawn paths) | YES — the model citizen |
| pane.ts:221 splitFocused dispatch-agent | via applyDispatchSpawnFocus | ⌥D/⌥C in Dispatch | yes |
| pane.ts:288 dispatch terminal split | applyDispatchSpawnFocus + grid focus | spawn dispatch terminal | yes |
| pane.ts:410 createDetachedDispatchAgent | applyDispatchSpawnFocus + activeTabId | new dispatch agent | yes |
| pane.ts:517 createLinkedAgent | applyDispatchSpawnFocus (lane captured pre-await :446-451) | linked agent | yes |
| pane.ts:524-650 createOrchestrationAgent | none (deliberate no-steal :640-648) | MCP spawn | intentional |
| pane.ts:756,765-768 attachDetachedToGrid | grid focus + clears classic if matched | attach | PARTIAL — tiled lane dangles (D8) |
| pane.ts:820,839-841 attachAllDetachedForTab | grid + classic = first attached | attach all | PARTIAL (D8) |
| pane.ts:901-931 detachFocusedToDispatch | grid repair + classic = detached | detach | PARTIAL (D8) |
| pane.ts:1127-1134 closeFocused grid path | grid focus successor | close grid pane | grid-only |
| pane.ts:1197,1276,1302 closeSession | dispatchModeAfterSessionRemoval + grid | close session | PARTIAL — never focusedLane (D6) |
| pane.ts:1418,1438 buryFocused | clearTiledLaneSessions + grid | bury | PARTIAL — classic not repaired (D5) |
| pane.ts:1501-1587 reviveBuried | grid + activeTabId | revive | grid-only |
| pane.ts:1651-1674 focusSession/focusSessionInTab | grid + spotlight | grid nav | grid-only |
| pane.ts:1721-1819 dispatchModeAfterSessionRemoval | lanes cleared + classic successor | (close paths) | PARTIAL — no focusedLane, successor not written to lane |
| reader.ts:95-97 setReaderModeSession | classic ONLY + activeTabId | Reader list click | NO (D4) |
| spotlight.ts:78-80 setSpotlightSession | classic ONLY + activeTabId | Spotlight click | NO (D4) |
| session.ts:547-551 killSession | lanes cleared + classic cleared if matched | kill | partial |
| session.ts:718-723 replaceSession | remapTiledLanes + classic remap | provider switch/resume/rewind/reload | YES |
| session.ts:907-919 reloadAgentSessions | remap + clear failed + classic | reload all | YES |
| tab.ts:149-158 closeTab | lanes cleared + classic cleared | close tab | partial |
| undoClose.ts:254 | remapTiledLanes | ⌘⇧T | lanes only |
| rehydrate.ts:329-339 | remap lanes + classic; focusedLane persisted | restart | YES |
| sessionOwnership.ts:156-167 autosave prune | keepTiledLaneSessions + classic scrub | autosave | YES |
| TiledDispatchLayout.tsx:131 heal effect | setTiledLaneSession ONLY | auto-heal | NO — #421 class |
| TiledDispatchLayout.tsx:176-177 index select | lane + focusedLane | index click | not classic |
| TiledDispatchLayout.tsx:224-225 mini-list | lane + focusedLane | chip click | not classic |
| TiledDispatchLayout.tsx:242,254 | focusedLane ONLY | lane click / focus request | (D3) |
| DispatchLayout.tsx:127,169,200,232 | focusDispatchSession → classic | classic clicks/sync | classic-only |
| useKeybinds.ts:531,537 moveTiledLaneSelection (→dispatch.ts:813) | lane selection ONLY | tiled ⌥↑↓/JK | NO — #421 class (D1) |
| useKeybinds.ts:532,538 moveDispatchSelection (→dispatch.ts:841) | classic ONLY | classic ⌥↑↓/JK | classic-mode guarded |
| useKeybinds.ts:543,548 | focusedLane ± 1 | ⌥←→/HL | focusedLane only |
| useKeybinds.ts:795 focusTiledRowByIndex | lane selection ONLY | tiled ⌥N | NO — #421 class |
| useKeybinds.ts:776,841 focusDispatchRowByIndex | classic | classic ⌥N | classic-only |

Note: composer submit is NOT a global focus read — each lane's composer is bound
to its rendered `lanes[].selectedSessionId` (TiledDispatchLayout.tsx:246), which
can differ from focusedLane/classic focus.

## Table B — Readers (target decisions)

| file:line | reads | decides | breaks when diverged |
|---|---|---|---|
| tiledDispatchSelectors.ts:105-114 dispatchFocusedSessionId | focusedLane → lane selection ?? classic | THE central dispatch-focus reader | silent classic fallback targets a different agent |
| dispatchTarget.ts:43-65 resolveDispatchVisualTarget | strict lane, else classic + grid | destructive/lifecycle command target | wrong agent or no-op |
| commandTargetSessionId.ts:35-60 | via above | ~60 commands (close/reload/switch/bury/copy/reader/paste/templates; consumers: App.tsx:454, useKeybinds 235/419/692, provider.ts 43/103/170/299, pane.ts 866/1008/1035/1334, session.ts 608/965, sessionCommands 30+, paneCommands 90-440, PromptSearchModal:101) | all hit wrong session |
| dispatchSelectors.ts:351-389 resolveDispatchSpawnTarget | lane strict, classic fallback | new-agent project/lane | #266 class |
| dispatchTarget.ts:74-83 resolveDispatchAttachTarget | strict | attach target (paneCommands 119/125) | wrong agent attached |
| paneCommands.ts:461-467 dispatchCommandTabId | + grid | attach-all tab | wrong tab |
| useKeybinds.ts:803-813 | focusedLane + lane selection | tiled nav cursor | steps from wrong agent |
| useKeybinds.ts:830-834 | classic + grid | classic nav cursor | wrong row |
| dispatchSelectors.ts:201-219 selectVisibleDispatchRow | both params | highlighted row | highlight ≠ target |
| TiledDispatchLayout.tsx:100-108,131,173,195,221 | lanes + focusedLane | lane render + AUTO-FILL input | stale lane → re-home to first agent |
| focusSurfaceTarget.ts:13-34 | commandTarget | Reader/Spotlight enter target | wrong agent opens |
| useFocusedAgentCwd.ts:35 | commandTarget | global editor root | wrong project |
| agentStatusModel.ts:114 | commandTarget | status highlight | wrong highlight |
| App.tsx:454 | commandTarget | paste/image/drag-drop routing | paste to wrong agent |
| dictationHotkeyRegistry.ts:87-97 | DOM focus only (none of the 4) | Fn dictation target | independent of lane focus (D10) |

> Removed 2026-08-27 (#671): `resolveDispatchTerminalSplitTarget` and
> `ensureDispatchTerminal` are gone. Dispatch terminal creation now shares
> `resolveDispatchSpawnTarget` with agents, so there is no separate terminal
> focus reader left to diverge.

## Divergence windows (concrete repro sequences)

- **D1** tiled ⌥↑/⌥↓ writes lane selection only; exit tiled → classic shows old agent.
- **D2** heal effect fills lane without classic; classic-fallback readers target unlaned session.
- **D3** lane click moves focusedLane only; classic points at old lane's agent.
- **D4** Reader/Spotlight click writes classic only; palette Close/Reload acts on the lane's agent (strict reader) — acts on a DIFFERENT agent than Reader shows.
- **D5** buryFocused never repairs classic focus → dangling id.
- **D6** close focused lane's agent: classic successor chosen, focusedLane left on empty lane, auto-fill re-homes to FIRST agent → target ≠ visible.
- **D7** setDispatchScope drops the whole tiled block silently.
- **D8** attach/detach paths never touch tiled fields → stale lanes.
- **D9** index/mini-list click: lane+focusedLane but not classic; drift surfaces on exit.
- **D10** dictation picks by DOM focus, ignoring all four fields — can diverge from every command target.

## Design consequence

The future `focusDispatchTarget(state, {sessionId, laneIndex?, reason})` must:
subsume every writer in Table A that is marked NO/PARTIAL; write all three
dispatch fields (+ activeTabId where applicable) atomically; infer laneIndex
(lane already showing the session → that lane; else focusedLane); log `reason`
to feed-debug. Removal repair (`dispatchModeAfterSessionRemoval`, bury, killSession,
closeTab) needs a sibling `repairDispatchFocusAfterRemoval` that ALSO moves
focusedLane to the successor's lane. `setDispatchScope` must preserve the tiled
block. Dictation (D10) is fixed separately by sessionId-aware target picking.
