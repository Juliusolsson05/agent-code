# Agent Terminal Follow Implementation Plan

> **For agentic workers:** Execute inline with executing-plans. The initial plan is preserved in first commit `7471ee41`; this revision records the implemented contracts and review corrections rather than retaining incorrect copy-paste recipes.

**Goal:** Support Jump to Latest and per-agent/Tail All auto-follow on raw agent terminal surfaces, without affecting plain shell panes.

**Architecture:** Keep the existing runtime counter and follow flags as the source of truth. `AgentTerminalLeaf` owns the xterm lifetime; `useAgentTerminalFollow` translates intent into public viewport operations without reattaching the PTY. Tail All is masked by composed subtree visibility.

**Tech Stack:** React 18, xterm 6, Vitest renderer and real Electron system tests. Use Node 24 as specified by `.nvmrc`.

**Tracking:** Issue #837, branch `feat/agent-terminal-follow`, worktree `.worktrees/agent-terminal-follow`.

## Scope and Contracts

- Agent terminal surfaces only: OpenCode Terminal, Claude/Codex terminal views, and raw Hybrid fallback. No new provider and no shell-terminal follow.
- Commands remain agent-scoped but lose their rendered-feed-only gate. Never switch surfaces or acquire a rendered lease to jump/follow.
- A new jump counter scrolls to bottom; a mount/session change baselines the old counter rather than replaying it.
- Effective follow is `(runtime.tailMode || tailAllMode) && ownerVisible`. Hidden retained panes suspend forced scrolling and re-pin on reveal.
- Live writes and attach replay pin only after parsing completes. Each deferred callback checks current follow state and terminal lifetime.
- Re-pin after `onScroll` is deferred and coalesced: xterm's browser viewport suppresses reentrant scroll operations.
- Save the first visible normal-buffer line with `registerMarker(viewportY - baseY - cursorY)`. Markers track trimming; `baseY` is NOT a trim counter and stops growing when scrollback fills.
- Disengagement restores the retained marker via `scrollToLine`; an evicted marker falls back to the oldest surviving line. Do not apply a normal-buffer anchor to the alternate screen.
- Dispose markers and scroll listeners on session change/unmount. A new session cannot inherit the prior session's saved reading position.
- Alternate-screen TUIs often own their history internally. These commands control the xterm viewport, not provider-specific keybindings or internal transcript navigation.

## Implementation and Review

- [x] Create dedicated branch and worktree; commit plan first.
- [x] Add jump/follow hook and `AgentTerminalLeaf` wiring, without broadening the mount effect dependencies.
- [x] Remove rendered-only policies from `toggle-tail` and `jump-latest-message`; keep shell exclusion.
- [x] Add TAIL indicator and align command/control descriptions with both agent surfaces.
- [x] Add renderer integration tests through the real session-data dispatcher, including deferred write/replay callbacks, session swaps and hidden-pane behavior.
- [x] Obtain initial independent Claude and Codex reviews via Agent Code MCP orchestration.
- [x] Fix unconditional write callback, pre-parse replay pin, synchronous reentrant scrolling, session-state leakage and tautological command guard test.
- [x] Replace incorrect numeric/baseY restoration with public xterm markers.
- [x] Add a colocated Electron system test using the installed xterm and production hook. Confirm red before the marker fix: after 100 trimmed lines, restoration returned `line-1191` instead of `line-1091`. Confirm green afterward.

## Files and Responsibilities

- `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts`: session-local intent, marker lifetime and deferred viewport re-pin.
- `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`: effective follow, write/replay completion guards and header status.
- `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`: component/dispatcher/lifecycle regression tests; fake Terminal is not authoritative about trimming.
- `src/renderer/src/workspace/tile-tree/agentTerminalFollow.system.test.ts`: real Chromium/xterm re-pin, content restoration after trimming, eviction fallback, jump and alternate-buffer coverage; isolated temporary userData and no provider processes.
- `src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts`: actual kind-guard invocation using a focused-tab fixture, plus rendered-policy regression guard.
- `src/renderer/src/features/workspace/commands/paneCommands.ts`, `workspace/control/preferences.ts`, `app-state/uiShell/types.ts`: truthful user/operator help and ownership comments.
- Existing submit and dimension-ownership test mocks: add the real public scroll API consumed by the component, without weakening production behavior.

## Verification and Delivery

Run from this worktree with Node 24 on PATH. Do not pipe test commands through truncation filters that hide their exit status.

```bash
npm run typecheck
npm run test:renderer -- AgentTerminalLeaf paneCommands.follow
npm run test:system -- agentTerminalFollow
npm run test:contract
npm run check:keybindings
npm test -- --maxWorkers=4 --testTimeout=15000
git diff --check
```

Earlier Node 25 full-suite runs hit `localStorage.setItem` failures also seen in the other checkout; they are not evidence of a clean Node 24 baseline. A Node 24 renderer run passed 548 tests with one unrelated cold-transform timeout. Record fresh results on the final integrated revision, not inferred counts or test-name-only comparisons.

- [ ] Commit the review corrections and integrate current `main` without overwriting concurrent work.
- [ ] Re-run targeted and full checks under the project Node version; report any genuine baseline failures separately.
- [ ] Get both existing reviewers to recheck the final revision, including the real-xterm evidence.
- [ ] Open a fully described PR linked with `Fixes #837`; keep review findings and verification synchronized there.
- [ ] Wait for CI, resolve valid findings, then merge using the user's explicit review-then-merge authorization. Never bypass failing checks or merge an unreviewed revision.
