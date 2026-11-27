# Providers & Terminal: add Antigravity (ACP), default agent view to Terminal, and fix TUI scrolling

Fixes #1547, Fixes #1548, Fixes #1549. Refs #1545.
Branch `feat/antigravity-provider-and-terminal-defaults` · Worktree `.worktrees/antigravity-and-terminal-defaults` · Base `origin/main` @ `a5fd3bbac` (2026-11-27)
Status: approved 2026-11-27 (user approved all defaults + terminal scroll fix, full build)
Decomposition: `docs/decomposition/antigravity-acp.md` (landed by PR #1545 commits)

## Outcome

1. **Google Antigravity (`agy`) provider**: Users can spawn, stream, approve/deny tool permissions, resume (`session/load`), browse history/catalog (`session/list`), use built-in Agent Code MCP tools, and copy the TUI resume command (`agy --conversation <id>`) for Antigravity panes, built on community PR #1545 (`urs-antaia`).
2. **Default UI mode = Terminal**: Fresh installs and missing/invalid persisted settings boot with `agentViewMode: 'terminal'` instead of `'agent'` or `'hybrid'`. Claude/Codex/Grok/Pi panes open in their native provider TUI by default, while PTY-less providers (`antigravity`, `hermes`, structured `opencode`) continue to pin to their rendered surface. Existing users with an explicitly saved `agentViewMode` keep their saved choice.
3. **Working TUI scrolling in Agent Code terminal panes**: Running `agy` (or any scrollback/full-screen TUI) inside a plain Agent Code terminal pane (`TerminalLeaf`) scrolls tmux scrollback cleanly on wheel/trackpad instead of sending Up/Down arrow keys, and no longer corrupts TUI cursor positioning with `convertEol: true`.

## Evidence (verified, do not re-derive)

- **PR #1545 (`urs-antaia:feat/antigravity-provider`)**: Base `a5fd3bbac` (exact current `origin/main`), `MERGEABLE`, 5 commits (`2911446c9`, `4bb740623`, `d9303c9cb`, `8d0d20995`, `8dd591f11`), +4,662 / -46 lines across 67 files. Adds in-repo `packages/antigravity-acp-headless` + `src/providers/antigravity/{runtime,renderer}` + registry/setup/catalog/MCP/phone wiring + `STRUCTURED_ONLY_PROVIDER_KINDS`. Local `agy` binary verified at `/Users/juliusolsson/.local/bin/agy` (`1.5.18`).
- **Default `agentViewMode`**:
  - `src/renderer/src/app-state/settings/types.ts:757` sets `DEFAULT_SETTINGS.agentViewMode: 'agent'`.
  - `src/renderer/src/app-state/settings/persistence.ts:163-165` coerces missing/invalid values to `DEFAULT_SETTINGS.agentViewMode`.
  - `src/renderer/src/workspace/agentDisplayMode.ts:78-81,176-179` and `src/renderer/src/workspace/tile-tree/useKeybinds.ts:140` fall back to `'agent'` on unknown mode values.
  - `agentDisplayMode.ts` (`normalizeAgentViewModeForKind`) pins `STRUCTURED_ONLY_PROVIDER_KINDS` (`antigravity`), `CHAT_SURFACE_PROVIDER_KINDS` (`hermes`), and structured `opencode` to `'agent'` regardless of global mode.
- **Terminal TUI scrolling bug (probed live against real `tmux` and real `agy 1.5.18`)**:
  - **Cause 1**: `src/main/tmux/tmuxConfig.ts:16` sets `['mouse', 'off']`. Live `tmux attach` emits `\x1b[?1049h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l` — putting xterm.js on the alternate screen (`buffer.hasScrollback === false`) with mouse tracking off. When `agy` runs in inline mode (`InlineStrategy.CommitScrollback`, no `?1000h`/`?1006h`), xterm's `MouseService._handlePassiveWheel` sees `!buffer.hasScrollback` and converts wheel events into Up/Down arrow keys (`\x1b[A`/`\x1b[B`) instead of scrolling tmux scrollback. Probed live: `tmux set mouse on` enables tmux copy-mode wheel scrolling for scrollback while still forwarding `\x1b[<64;...M` / `\x1b[<65;...M` SGR wheel events to mouse-tracking inner TUIs.
  - **Cause 2**: `src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx:321` is the only xterm in the repo with `convertEol: true` (`AgentTerminalLeaf.tsx:297` and `AgentInlineTerminal.tsx:67` both set `convertEol: false`). In `xterm-256color`, `cud1` is bare `\n`; `tmux` and Bubble Tea/Ultraviolet (`agy`) emit bare `\n` to move down without resetting column 0, and `convertEol: true` turns `\n` into `\r\n`, corrupting cursor positioning and scroll repaints.

## Decisions

1. **PR structure** — *Default: one branch/PR* preserving `urs-antaia`'s 5 commits with original authorship, plus our plan, default-terminal-mode change, and terminal TUI scroll fix.
2. **Existing installs for `agentViewMode`** — *Default: fresh installs and missing/invalid values default to `'terminal'`; explicitly persisted `'agent'`/`'hybrid'` values are preserved* (matching `#973` public-defaults convention; no store version bump).
3. **Antigravity pane surface** — *Default: keep PR #1545's ACP feed-only design (`STRUCTURED_ONLY_PROVIDER_KINDS`)*.
4. **GitHub Issues** — *Default: created `#1547`, `#1548`, `#1549`*, linked with `Fixes` in the PR.
5. **Execution mode** — *Default: full build*, stopping before merge for explicit user confirmation.

Answered 2026-11-27: all defaults + include terminal TUI scroll fix.

## Design

### 1. Antigravity ACP provider (PR #1545)
- Cherry-pick all 5 commits from `refs/remotes/pr/1545` (`2911446c9..8dd591f11`), keeping `urs-antaia`'s commit messages and author metadata intact.
- Contract: `antigravity` is in `AGENT_PROVIDER_KINDS`, `LOCAL_PROVIDER_KINDS`, and `STRUCTURED_ONLY_PROVIDER_KINDS`. `antigravity-acp-headless` owns ACP JSON-RPC framing, turn assembly, catalog, and stdio MCP proxy; `src/providers/antigravity/` owns process spawn/lifecycle, history fallback, and renderer mapping.
- Invariant: `antigravity` always resolves to `'rendered'` in `getEffectiveAgentSurface`, even when `settings.agentViewMode === 'terminal'`.

### 2. Default `agentViewMode` to `'terminal'`
- `DEFAULT_SETTINGS.agentViewMode` in `src/renderer/src/app-state/settings/types.ts` becomes `'terminal'`, with a WHY comment explaining the default and why existing persisted choices are preserved.
- `coerceSettings` in `src/renderer/src/app-state/settings/persistence.ts` already falls back to `DEFAULT_SETTINGS.agentViewMode`; update its comment to match.
- Defensive fallback literals in `src/renderer/src/workspace/agentDisplayMode.ts` (`getEffectiveAgentSurface`, `commandAllowedByRenderedViewPolicy`) and `src/renderer/src/workspace/tile-tree/useKeybinds.ts` (`renderedAgentSurfaceIsVisible`) align from `'agent'` to `'terminal'` so unrecognized runtime values never silently mount the rendered feed.
- Invariant: `coerceSettings({}).agentViewMode === 'terminal'`, `coerceSettings({ agentViewMode: 'invalid' }).agentViewMode === 'terminal'`, and `coerceSettings({ agentViewMode: 'agent' }).agentViewMode === 'agent'`.

### 3. Terminal TUI scrolling fix (`TerminalLeaf` + `tmuxConfig`)
- `src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx`: set `convertEol: false` (matching `AgentTerminalLeaf.tsx` and `AgentInlineTerminal.tsx`), with a WHY comment explaining `cud1` (`\n`) vs PTY `ONLCR`.
- `src/main/tmux/tmuxConfig.ts`: change `['mouse', 'off']` → `['mouse', 'on']` and add `['set-clipboard', 'on']` (so tmux copy-mode selection can still reach the clipboard via OSC 52 when supported, while wheel scrolling enters copy-mode for scrollback and forwards SGR mouse wheel events to mouse-tracking inner TUIs).
- Invariant: `TMUX_SESSION_FLAGS` enables mouse handling on every managed tmux session, and `TerminalLeaf` never enables `convertEol`.

## Files

- Create `docs/plans/2026-11-27-antigravity-provider-and-terminal-defaults.md` — this plan (first commit).
- Cherry-pick PR #1545 (67 files) — Antigravity ACP provider + package + docs + tests.
- Modify `src/renderer/src/app-state/settings/types.ts` — `DEFAULT_SETTINGS.agentViewMode = 'terminal'`.
- Modify `src/renderer/src/app-state/settings/persistence.ts` — update comment for terminal fallback.
- Modify `src/renderer/src/workspace/agentDisplayMode.ts` — align unrecognized-mode fallback to `'terminal'`.
- Modify `src/renderer/src/workspace/tile-tree/useKeybinds.ts` — align unrecognized-mode fallback to `'terminal'`.
- Modify `src/renderer/src/app-state/settings/persistence.test.ts` — update default/fallback assertions to `'terminal'` and verify explicit `'agent'`/`'hybrid'` preservation.
- Modify `src/renderer/src/workspace/agentDisplayMode.test.ts` — verify `antigravity` stays `'rendered'` under global `'terminal'` mode and unrecognized mode falls back to `'terminal'`.
- Modify `src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx` — set `convertEol: false`.
- Modify `src/main/tmux/tmuxConfig.ts` — set `['mouse', 'on']` and `['set-clipboard', 'on']`.
- Modify `src/renderer/src/workspace/tile-tree/TerminalLeaf.retention.renderer.test.tsx` — regression test asserting `TerminalLeaf` constructs xterm with `convertEol: false` (proven fail-first).
- Modify `src/main/tmux/TmuxRegistry.test.ts` — regression test asserting `TMUX_SESSION_FLAGS` sets `mouse` to `'on'` (proven fail-first).

## Tests

- **Antigravity package & app tests** (from PR #1545): `packages/antigravity-acp-headless` assembler + scripted ACP session tests; `src/providers/antigravity/` mapper, session, promptDelivery, history tests; `src/main/conversations/sources/antigravity.system.test.ts`; provider inventory tests.
- **Default `agentViewMode` tests**:
  - `src/renderer/src/app-state/settings/persistence.test.ts`: asserts `coerceSettings({}).agentViewMode === 'terminal'`, invalid value falls back to `'terminal'`, explicit `'agent'` and `'hybrid'` are preserved. Before fix: fails returning `'agent'`.
  - `src/renderer/src/workspace/agentDisplayMode.test.ts`: asserts `antigravity` resolves to `'rendered'` even under `globalMode: 'terminal'`.
- **Terminal TUI scroll regression tests (fail-first, proven by reverting)**:
  - `src/renderer/src/workspace/tile-tree/TerminalLeaf.retention.renderer.test.tsx`: captures `new Terminal(options)` constructor options and asserts `options.convertEol === false`. Before fix: fails (`true`).
  - `src/main/tmux/TmuxRegistry.test.ts`: asserts `TMUX_SESSION_FLAGS` sets `mouse` to `'on'`. Before fix: fails (`'off'`).

## Verification

- Scoped checks while iterating: `npx vitest run` on Antigravity tests, `persistence.test.ts`, `agentDisplayMode.test.ts`, `TerminalLeaf.retention.renderer.test.tsx`, `TmuxRegistry.test.ts`, and `store.test.ts`.
- Full verification before PR: `npm run typecheck`, `npm run build` + `node scripts/verify-build-output.mjs`, and targeted/full test suite.
- Verification boundary: live Electron GUI mouse-wheel scrolling inside a rendered `TerminalLeaf` running `agy` in the desktop app cannot be driven from headless tests (we verified the underlying `tmux` escape/SGR forwarding and `agy` binary behavior in real PTY probes; manual smoke test in `npm run dev` will be listed in the PR). Live `ANTIGRAVITY_LIVE=1` test requires a signed-in `agy` session (`agy` returned "You are currently not signed in" in the headless PTY probe, so we will note its status honestly).

## Out of scope

- Splitting `packages/antigravity-acp-headless` into its own git submodule repo (kept in-repo as in PR #1545; can be extracted later).
- Adding a separate PTY/TUI runtime for `agy` (Antigravity's private SQLite store has no observable transcript/status contract; `agy --conversation <id>` is the escape hatch).
- Migrating existing users' persisted `agentViewMode` via a store version bump.
