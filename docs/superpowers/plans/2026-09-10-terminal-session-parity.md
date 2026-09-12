# Terminal Session Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session feature that is really about *the session* (title, spoken name, pin, header, activity status, label jump, follow, status panel, operator navigation) works for terminals exactly as it does for agents. Only transcript and provider features stay agent-only.

**Architecture:** Most exclusions are single `isAgentProviderKind` checks standing in for "is this a session the user manages". They get deleted, not generalized: every `SessionKind` qualifies, so no new capability table is needed. There are three structural pieces. Plain terminals render the shared `PaneHeader` that #853 introduced for agents in terminal view. A new main-process `TerminalForegroundMonitor` gives shells an activity signal: the foreground command, read from tmux or node-pty, arriving on a dedicated desktop-only channel. One `sessionDisplayTitle` resolver replaces the copies that disagree about untitled sessions.

**Tech Stack:** TypeScript, Electron (main / preload / renderer), React 18, zustand, xterm.js, node-pty, bundled tmux, Vitest 4 (`unit`, `system` and `renderer` projects).

**Spec:** The Design section of this document, plus issues **#865** (feature) and **#866** (remote leak, fixed in the same PR). Research sources: #830/#831/#840 (templates and vault already in terminals), #853 (shared header), #858 (terminal-view related agent), #857 (OpenCode Terminal running signal, out of scope), #660 and #836 (the scope decisions reversed here).

## Global Constraints

- Branch `feat/terminal-session-parity`, worktree `.worktrees/terminal-session-parity`, based on `origin/main` `ad9ddc46`. This plan is the first commit.
- **Node 24 for every test run:** `source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24`. The machine default v25.5.0 breaks happy-dom `localStorage` in the renderer project.
- **The type gate is raw tsc.** `npm run typecheck` (or `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false` for speed). Neither electron-vite nor vitest type-checks.
- **Run tests per task by path only.** Unit: `NODE_ENV=test npx vitest run --project unit <path>`. Renderer (`*.renderer.test.ts(x)`): `NODE_ENV=test npx vitest run --project renderer <path>`. Run the full `npm test` once, in Task 14, not after every step.
- **Never launch the app** (`npm run dev`, `npx electron`). Anything that needs the live app goes to the user as a request.
- **Thick WHY comments** on every non-obvious line, per CLAUDE.md. When a check is removed, replace the old WHY comment with the reason it is gone. Do not leave a stale comment behind.
- **Commits:** Conventional Commits with a subsystem scope, imperative mood, no trailing period, one coherent change each. Identity comes from global git config; never pass `-c user.email`. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F
  ```
- **Command titles follow `docs/command-style.md`:** stable noun phrases, `…` only when more input follows, explicit `surface`. Command **ids never change**, because they key saved visibility and keybinding settings.
- **No CI grep locks, no YAGNI guards, no multi-PR split.** This is one coupled feature; the phone fix rides along because it touches the same terminal boundary.
- **No new bug issues for defects found while implementing.** Only #866 was filed, from research.
- **Do not merge.** Open the PR with `Fixes #865`, `Fixes #866`, `Fixes #858`, then stop.

---

## Design

### D1. "Session" features are for every session kind

A title, a spoken name, a pin, a pane label and a color flag describe a *session the user manages*. None of them needs a transcript or a provider. The checks that exclude terminals from them are deleted. No replacement predicate is added, because after this change the answer is "every session" and a predicate that always returns true is a YAGNI guard.

This deliberately reverses three recorded decisions:
- #660: "plain shell terminals are intentionally out of scope"
- #836: "Terminals are never named"
- the #152 v1 deferral of pins

Each reason is superseded:
- A shell running a dev server needs a glance label as much as an agent does.
- The external operator can already create, read and write terminals (`terminals.*`, #793), so a named shell is routable. The routing rule is documented in D5.
- Terminals have been full Dispatch rows since #671.

### D2. What stays agent-only

These keep their guards, and their WHY comments stay accurate:
- **Prompt delivery:** `SessionManager.deliverPromptToAgent`, `agents.prompt`, remote `send-prompt`. Refusing terminals here protects the readiness gate and the confirmation (#394 §4.2).
- **Transcript features:** rewind, resume, View Prompts, Reader, Copy Last Response, duplicate, provider switch, session preview, session recording.
- **Composer features:** Clear/Send Composer, Save Composer as Template, prompt suggestions, the queue strip, conditions.
- **The remote phone client.** Terminal bytes never go to a phone. #866 closes the leak in that boundary rather than widening it.
- **Mouse Mode buttons on plain shells.** The user's own call in #819 ("Shells keep zero controls") stands.

### D3. One header implementation

`TerminalLeaf` stops hand-drawing `terminal $` and renders `PaneHeader`, exactly as `AgentTerminalLeaf` has done since #853. Its comment says "Don't fork this markup again. Add a slot instead."

| Header part | What a plain terminal shows |
|---|---|
| `badge` | the foreground command while one runs (e.g. `npm`), otherwise `terminal` |
| `projectDir` | the live cwd when tmux reports one, otherwise the spawn cwd (`runtime.projectDir` is always undefined for shells) |
| `trailing` | the TAIL pill |
| title / name row | shared (`AgentTitleHeader`) |
| color flag, Status Mode fill | shared |

The root element gains `data-pane-id`, which `agents.show`, the HTML debug capture and the debug bundle all look up.

`TerminalLeaf` keeps its performance contract: it never takes the runtime as a prop, and every new value is a primitive store selector. That way a PTY chunk never re-renders it.

**Accepted cost.** Header height is taken out of the PTY. A title being set, or Status Mode being toggled, resizes the shell once. That is the same trade #853 accepted for agents.

### D4. Shell activity is the foreground process

A shell is `running` while its foreground process is anything other than the shell itself.

**Sources:**
- **tmux-backed terminals:** one `tmux list-panes -a -F …` per poll covers every managed session (`pane_current_command`, `pane_current_path`).
- **Direct PTYs:** node-pty's `pty.process`, the foreground process of the PTY. In tmux mode that getter names the tmux client, so it is not used there.

**Polling:**
- 1000 ms interval.
- The poll only runs while at least one terminal is tracked.
- It has an **in-flight guard**. The 2026-07-07 OOM came from a poll without one: `claude-code-headless` `proxyServer.startPollingEvents`.
- It emits **only on change**.

**Transport:** a dedicated `session:terminal-foreground` channel, not `process-state`. The remote tap (`SessionFeedSource`) and the session recorder both subscribe to `process-state`, and neither may learn about terminals. A new channel is invisible to both by construction.

**Renderer:** the event sets `processActive`, `activityStatus` (the command) and `terminalForeground` on the runtime. The existing `deriveSessionStatus` then drives, with no further renderer changes:
- the Status Mode fill
- tab running counts
- the "still working" close confirmation
- the Dispatch subtitle

A busy→idle transition marks the session unread (`output`), the same way an agent finishing a turn does. `terminalForeground.changedAt` is the terminal's "last active" time for Close Old Agents and the Activity modal.

**Reload:** after the workspace restores, the renderer pulls a per-window snapshot (`session:terminal-foregrounds`). Without it, a busy dev server would read idle after a renderer reload until its foreground changed again.

**Known and accepted behavior:**
- A long-running dev server or `vim` keeps its pane lit. That is literally true ("a job is running here"), and it is what makes the close confirmation useful.
- Commands shorter than one poll interval are never observed as busy.

### D5. Operator routing for terminals

These capabilities accept terminals: `agents.locate`, `show`, `close`, `restore`, `titleSet`, `pinSet`, `list`, plus `agents.search`. `workspace.observe` already lists terminals with `provider: 'terminal'`.

`agents.prompt` refuses a terminal with an actionable message: "send text with `terminals.input`". The operator guide and the `agent-code-computer-execution` skill say the same, so a spoken name that resolves to a shell is driven with `terminals.input`, which sends exact bytes and never adds an Enter.

### D6. One display-title rule

`sessionDisplayTitle(meta, liveCwd?)` = explicit title → live folder name → spawn folder name → raw cwd.

It replaces the copies this change touches:
- the pin modal
- the label jump
- the Agent Status model
- the close confirmation, which today falls back to the raw session **UUID**
- the buried-kill confirmation
- the buried picker
- `workspace.observe`'s fallback

Dispatch keeps its extra latest-prompt fallback for agents. For terminals, Dispatch uses the live folder, so a shell row follows `cd`.

### D7. Terminal view shows which related agent it displays (#858)

Adding a chip row would resize the TUI whenever a child spawns. Instead, the one-line status row carries the answer:
- the badge reads `raw codex · orchestration worker-2` while a related child is displayed;
- a `parent` button in `trailing` returns to the owner.

No row is added, so the PTY is never resized by this.

### D8. Out of scope, with reasons

| Item | Why not here |
|---|---|
| OpenCode Terminal running signal (#857) | Needs spinner detection in `opencode-headless`. The foreground process is always `opencode`, so D4 cannot see its turns. |
| Restart Terminal / Retry on wake failure | A new lifecycle operation, not a parity gate. |
| Type-to-focus / paste-to-focus into terminals | Changes keyboard ownership. Separate UX decision. |
| Linked terminals, Duplicate Terminal, Copy `tmux attach` | New features with their own semantics. |
| Operator `templates.insert` into terminals | The paste target requires a focused, visible xterm, and the control contract says "never current focus". `templates.read` + `terminals.input` already composes. |
| Save template from a terminal selection | Needs a selection-source registry that does not exist. |
| Workflow selector in terminal view; rewind on OpenCode Terminal | Separate surface work. |

### Inventory → task map

| Gap | Task |
|---|---|
| Title blocked in 4 layers | 1 (UI/reducer), 10 (operator) |
| Spoken names blocked in 3 checks + copy | 2, 10 |
| Shell has no activity signal (main) | 3 |
| Shell activity in renderer: status, NEW, last-active, reload snapshot | 4 |
| Plain terminal header, `data-pane-id`, Status Mode, TAIL, auto-follow, jump | 5 |
| Title fallbacks disagree; UUID in close dialog; Dispatch shell row title/subtitle/NEW/ERROR | 6 |
| Pins blocked in 7 places | 7 |
| Jump by label refuses terminals | 8 |
| Close Old Agents, Activity modal (+ Bury), Agent Status panel, Worktrees panel | 9 |
| Operator `agents.*` refuse terminals; docs | 10 |
| Terminal view hides the related agent (#858) | 11 |
| Dispatch picker Terminal option, Undo Clear Composer on shells, OpenCode Terminal transcript commands, template insert-mode copy, stale comments | 12 |
| Remote leak (#866) | 13 |
| Verification and PR | 14 |

---

## File map

**Created**
- `src/shared/types/terminalForeground.ts`: sample, state and event types, shared by main, preload and renderer.
- `src/main/sessions/terminalForeground.ts` (+ `.test.ts`): classifier and `TerminalForegroundMonitor`.
- `src/main/tmux/TmuxRegistry.test.ts`: tests `parsePaneForegroundListing`.
- `src/renderer/src/session-runtime/unread.ts`: `withUnread`, moved out of `useIpcSubscriptions`.
- `src/renderer/src/session-runtime/terminalForeground.ts` (+ `.test.ts`): `applyTerminalForeground`.
- `src/renderer/src/workspace/hook/ipc/useTerminalForeground.ts` (+ `.renderer.test.tsx`): live events and the post-restore snapshot.
- `src/renderer/src/workspace/sessionDisplayTitle.ts` (+ `.test.ts`).
- `src/renderer/src/workspace/transcriptAvailability.ts` (+ `.test.ts`).
- `src/renderer/src/workspace/tile-tree/TerminalLeaf.header.renderer.test.tsx`
- `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.related.renderer.test.tsx`
- `src/renderer/src/features/workspace/ui/CloseOldAgentsModal.rows.renderer.test.ts`
- `src/renderer/src/features/agent-status/model/agentStatusModel.renderer.test.ts`
- `src/renderer/src/features/prompt-templates/ui/PromptTemplateFillPane.renderer.test.tsx`
- `src/renderer/src/workspace/dispatch/rowTitle.test.ts`

**Renamed**
- `tile-tree/agentTerminalFollow.ts` → `tile-tree/terminalFollow.ts` (`useAgentTerminalFollow` → `useTerminalFollow`), plus its `.system.test.ts`.

**Modified** (by task): listed in each task's **Files** block.

---

### Task 1: Titles for every session

**Files:**
- Modify: `src/renderer/src/workspace/agentTitle.ts` (the guard in `setAgentTitleInWorkspace` and its WHY comment)
- Modify: `src/renderer/src/workspace/hook/index.ts:233-244` (`setAgentTitle`)
- Modify: `src/renderer/src/features/workspace/commands/agentTitleCommands.ts`
- Modify: `src/renderer/src/features/workspace/ui/AgentTitlePrompt.tsx:46` (dialog title copy)
- Modify: `src/renderer/src/workspace/tile-tree/AgentTitleHeader.tsx:7-12` (comment only)
- Test: `src/renderer/src/workspace/agentTitle.test.ts`
- Test: `src/renderer/src/features/workspace/commands/agentTitleCommands.test.ts`

**Interfaces:**
- Produces: `setAgentTitleInWorkspace(state, sessionId, value)`. Same signature; it now titles any existing session.
- Produces: `workspace.setAgentTitle(sessionId, title): boolean` returns `true` for any existing session.
- Command id `agent.title.set` is unchanged. Its title becomes `Set Title…`.

- [ ] **Step 1: Write the failing tests**

In `agentTitle.test.ts`, replace the whole `it('preserves identity for unchanged, missing, and terminal targets', …)` block with:

```ts
  it('preserves identity for unchanged and missing targets', () => {
    const titled = stateWithSessions({
      agent: { cwd: '/work/project', kind: 'codex', title: 'Review' },
    })
    expect(setAgentTitleInWorkspace(titled, 'agent', 'Review')).toBe(titled)
    expect(setAgentTitleInWorkspace(titled, 'missing', 'Nope')).toBe(titled)
  })

  it('titles a plain terminal with the same normalization as an agent (#865)', () => {
    // WHY terminals are titled now: a title is session metadata the user
    // authors to scan a busy grid, and a shell running a dev server needs a
    // label as much as an agent does. #660 scoped shells out; #865 reverses it.
    const terminal = stateWithSessions({ shell: { cwd: '/work/project', kind: 'terminal' } })
    const titled = setAgentTitleInWorkspace(terminal, 'shell', '  dev server  ')
    expect(titled.sessions.shell?.title).toBe('dev server')
    expect(buildVisibleDispatchRows(titled)[0]).toMatchObject({ agentTitle: 'dev server' })
  })
```

In `agentTitleCommands.test.ts`, replace `it('does not advertise agent titles for a plain terminal target', …)` with:

```ts
  it('offers titles for a plain terminal target too (#865)', () => {
    const state = baseState()
    state.sessions.a = { cwd: '/work/a', kind: 'terminal' }
    const harness = context(state)

    expect(command.when?.(harness.value)).toBe(true)
    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('a')
  })

  it('uses a session-neutral title while keeping the stable command id', () => {
    // The id keys saved visibility/keybinding settings; only the label moves.
    expect(command.id).toBe('agent.title.set')
    expect(command.title).toBe('Set Title…')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/agentTitle.test.ts src/renderer/src/features/workspace/commands/agentTitleCommands.test.ts`
Expected: three FAIL cases:
- the terminal title is `undefined`;
- `when` returns `false`;
- the title is `Set Agent Title…`.

- [ ] **Step 3: Implement**

In `agentTitle.ts`, rewrite the second sentence of the "WHY this returns the original object" paragraph, and replace the guard:

```ts
 * WHY this returns the original object for an invalid/no-op edit: workspace
 * autosave keys off state identity. Opening the prompt and saving an unchanged
 * value should not schedule a disk write, and a session that closed while its
 * prompt was open must not be recreated through a stale captured modal.
 *
 * WHY every session kind is accepted (#865): titles used to be agent-only
 * (#660). A title is session metadata the user writes for scanning, and every
 * reader of `SessionMeta.title` (Dispatch, observe, close confirmation)
 * already handles terminals. The kind check was the only thing in the way.
```

```ts
  const meta = state.sessions[sessionId]
  if (!meta) return state
```

Then remove the `DEFAULT_PROVIDER` / `isAgentProviderKind` import from `agentTitle.ts` if nothing else in the file uses it.

In `hook/index.ts`, change the first two lines of `setAgentTitle`:

```ts
  const setAgentTitle = useCallback((sessionId: SessionId, title: string): boolean => {
    // Any existing session can carry a title (#865); only a vanished one is refused.
    if (!refs.stateRef.current.sessions[sessionId]) return false
```

Keep the rest of the function. If `npx tsc -p tsconfig.web.json` then reports `isAgentProviderKind` or `DEFAULT_PROVIDER` unused in `hook/index.ts`, remove that import. Otherwise leave it.

Replace `agentTitleCommands.ts` with:

```ts
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// WHY every session kind qualifies (#865): the title is session metadata, not a
// transcript feature. Plain shells were refused here (#660) until the product
// decided a terminal running a dev server deserves a glance label as much as an
// agent does. The reducer and the operator capability accept terminals too.
function titleTarget(ctx: CommandContext): string | null {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return null
  return ctx.workspace.state.sessions[sessionId] ? sessionId : null
}

// `surface: 'session'` is the product contract here, not just catalog
// organization. The Dispatch-aware target resolver follows the focused Grid
// pane, classic Dispatch row, or focused Tiled Dispatch lane. Re-deriving focus
// inside the modal would make the same command edit different sessions
// depending on layout; capture the one resolved id when the command runs.
//
// WHY the id still says `agent`: command ids key saved visibility and keybinding
// settings, so renaming it would silently drop user customizations. Only the
// label became session-neutral.
export const agentTitleCommands: CommandDef[] = [
  {
    id: 'agent.title.set',
    category: 'session',
    surface: 'session',
    title: 'Set Title…',
    description:
      '**What it does:** Sets or clears a persistent title for the focused agent or terminal. ' +
      'The title appears directly below its pane header and in Dispatch.\n\n' +
      '**Use when:** You have several agents and terminals open and want a short glance label for ' +
      'what each one is doing.',
    keywords: ['agent', 'terminal', 'shell', 'title', 'name', 'label', 'rename', 'dispatch', 'pane'],
    when: ctx => titleTarget(ctx) !== null,
    run: ctx => {
      const sessionId = titleTarget(ctx)
      if (sessionId) ctx.ui.openAgentTitlePrompt(sessionId)
    },
  },
]
```

In `AgentTitlePrompt.tsx:46`, change `<DialogTitle>Set Agent Title</DialogTitle>` to `<DialogTitle>Set Title</DialogTitle>`.

In `AgentTitleHeader.tsx`, replace the first paragraph of the header comment (lines 7-12) with:

```ts
// One visual contract for explicit titles and spoken names across every pane
// surface: the structured Agent view, the raw agent terminal, and (since #865)
// plain shell terminals, which render PaneHeader and therefore this row too.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command as Step 2.
Expected: PASS, all cases in both files.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/agentTitle.ts src/renderer/src/workspace/agentTitle.test.ts \
  src/renderer/src/workspace/hook/index.ts \
  src/renderer/src/features/workspace/commands/agentTitleCommands.ts \
  src/renderer/src/features/workspace/commands/agentTitleCommands.test.ts \
  src/renderer/src/features/workspace/ui/AgentTitlePrompt.tsx \
  src/renderer/src/workspace/tile-tree/AgentTitleHeader.tsx
git commit -m "feat(workspace): let terminals carry a title like agents

A title is session metadata the user writes to scan a busy grid, and every
reader of SessionMeta.title already handled terminals. Only the command guard,
the action and the reducer refused them, a scope decision from #660 that #865
reverses. The command id stays agent.title.set so saved keybindings survive.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 2: Spoken names for every session

**Files:**
- Modify: `src/renderer/src/workspace/agentNames/reconcile.ts` (`isNameable` and its two uses)
- Modify: `src/renderer/src/workspace/agentNames/selectors.ts` (`resolveAgentName`, `agentNameRowIsReserved`)
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts:478` (description)
- Modify: `src/control-sdk/catalog/workspace.ts` (`agentName` description)
- Modify: `src/renderer/src/app/controlGuide.ts:52` (names paragraph)
- Test: `src/renderer/src/workspace/agentNames/selectors.test.ts`
- Test: `src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx`
- Test: `src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx`

**Interfaces:**
- Produces: `resolveAgentName({ enabled, meta, names })`. Same signature; it resolves for any `kind`.
- Produces: `agentNameRowIsReserved(state, sessionId)` is `true` for any existing session while names are on.
- Produces: `claimMissingIdentities(state)` and `agentNameIdentities(state)` include terminal sessions.
- Consumed by Task 5, where `TerminalLeaf` renders `AgentTitleHeader` through `PaneHeader` and therefore picks up the name row and its reservation.

- [ ] **Step 1: Write the failing tests**

In `selectors.test.ts`, replace `it('never names a shell terminal', …)` with:

```ts
  it('names a shell terminal from the same pool (#865)', () => {
    // A named shell is routable since the operator gained terminals.input
    // (#793): the guide sends a spoken shell name to terminals.input, never
    // agents.prompt. The old "unroutable target" reason no longer holds.
    expect(resolveAgentName({ enabled: true, meta: { kind: 'terminal', agentNameId: 'identity-one' }, names }))
      .toBe('Apollo')
  })
```

In `reconciler.renderer.test.tsx`, in `it('claims identities for agents only, resolves them once, and stores the names', …)`, make these edits:
- Rename the test to `'claims identities for every session, resolves them once, and stores the names'`.
- Replace the comment `// A shell has no conversation to address; …` and the two lines below it with:

  ```ts
      // Shells are named too (#865): the claim covers every session kind.
      expect(mounted.seen.current.sessions['shell-one'].agentNameId).toBe('shell-one')
  ```
- Replace the later `expect(mounted.seen.current.sessions['shell-one'].agentNameId).toBeUndefined()` with `.toBe('shell-one')`.
- Replace `expect([...resolveAgentNames.mock.calls[0][0]].sort()).toEqual(['agent-one', 'identity-buried'])` with:

  ```ts
      expect([...resolveAgentNames.mock.calls[0][0]].sort()).toEqual(['agent-one', 'identity-buried', 'shell-one'])
  ```
- In the same test, change the `useAppStore.getState().workspaceAgentNames` expectation to:

  ```ts
      await waitFor(() => expect(useAppStore.getState().workspaceAgentNames)
        .toEqual({ 'agent-one': 'Apollo', 'identity-buried': 'Jasper', 'shell-one': 'Jasper' }))
  ```

  The mock names every non-`agent-one` identity `Jasper`. The assertion checks that the shell was requested and stored, not that the fixture's names are unique.

In `presentation.renderer.test.tsx`, make three changes:

1. Replace `it('renders nothing for an untitled shell, even one with a stale identity', …)` with:

```ts
  it('names a shell in the shared header (#865)', () => {
    seed()
    const { container } = render(<AgentTitleHeader sessionId={SHELL} />)
    expect(container.querySelector('[data-agent-name-badge="true"]')).toHaveTextContent('Jasper')
  })
```

2. Replace `it('reserves nothing for a shell, which never receives a name', …)` with:

```ts
  it('holds the row open for a shell whose name has not arrived yet', () => {
    // Same SIGWINCH hazard as agents: a row appearing mid-life would resize the
    // live shell and garble a TUI running in it (vim, htop).
    seed()
    appState.workspaceAgentNames = {}
    const { container } = render(<AgentTitleHeader sessionId={SHELL} />)
    expect(container.querySelector('[data-agent-name-placeholder="true"]')).not.toBeNull()
  })
```

3. In `it('chips the name on the agent row of the Dispatch index and leaves shells bare', …)`:
   - rename it to `'chips the name on every Dispatch row, shells included'`;
   - replace `expect(rows[1].querySelector('[data-dispatch-agent-name="true"]')).toBeNull()` with `expect(rows[1].querySelector('[data-dispatch-agent-name="true"]')).toHaveTextContent('Jasper')`;
   - replace `expect(rows[1].getAttribute('title')).toBe('A2 workflow')` with `expect(rows[1].getAttribute('title')).toBe('Jasper — A2 workflow')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/agentNames/selectors.test.ts
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx
```
Expected: the new and edited terminal cases FAIL (null name, undefined identity, no badge, no placeholder).

- [ ] **Step 3: Implement**

`reconcile.ts`:
- Delete `isNameable`.
- In `claimMissingIdentities`, replace `if (!isNameable(meta) || identityOf(meta)) continue` with `if (identityOf(meta)) continue`.
- In `agentNameIdentities`, replace `const identity = isNameable(meta) ? identityOf(meta) : null` with `const identity = identityOf(meta)`, and do the same for `record.sessionMeta`.
- Remove the now-unused `DEFAULT_PROVIDER, isAgentProviderKind` import.
- Add this comment above `claimMissingIdentities`'s loop:

```ts
    // Every session kind is claimed (#865). Terminals used to be skipped because
    // a spoken shell name "would advertise an unroutable target"; the operator
    // routes shell names to terminals.input now, so the reason no longer holds.
```

`selectors.ts`:
- In `resolveAgentName`, delete the line `if (!isAgentProviderKind(input.meta.kind ?? DEFAULT_PROVIDER)) return null`.
- Replace the tail of `agentNameRowIsReserved` with:

```ts
  const meta = state.workspaceState?.sessions?.[sessionId]
  // Any existing session reserves the row while names are on (#865): a shell
  // now receives a name, so the same late-arrival resize hazard applies to it.
  return meta !== undefined
```

- Remove the now-unused provider-kind import.
- Update the JSDoc of `resolveAgentName`. Where it explains null returns, drop any mention of terminals.

`settingsRegistry.ts:478`: in the description string, replace `Terminals are never named.` with `Terminals are named too, from the same list.`.

`control-sdk/catalog/workspace.ts`: in the `agentName` `.describe(...)`, replace `Null when the Agent names setting is off, when the agent is a terminal, or before a name has been allocated.` with `Null when the Agent names setting is off or before a name has been allocated. Terminals are named too.`.

`controlGuide.ts:52`:
- Replace `each provider agent gets one stable name` with `each agent and terminal gets one stable name`.
- Replace `Terminals never get names.` with `A name can belong to a terminal (provider "terminal"): drive it with terminals.read/terminals.input, never agents.prompt, which refuses terminals.`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same two commands as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/agentNames src/renderer/src/features/settings/lib/settingsRegistry.ts \
  src/control-sdk/catalog/workspace.ts src/renderer/src/app/controlGuide.ts
git commit -m "feat(workspace): give terminals spoken names from the same pool

Names were withheld from shells because a spoken shell name looked like an
unroutable target. Since the operator gained terminals.input that reason is
gone, and a shell running a server is exactly what a voice user wants to say
out loud. Shells also reserve the name row, because the same late-arrival
resize would otherwise SIGWINCH a TUI running in the shell.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 3: Terminal foreground monitor (main process)

**Files:**
- Create: `src/shared/types/terminalForeground.ts`
- Create: `src/main/sessions/terminalForeground.ts`
- Create: `src/main/sessions/terminalForeground.test.ts`
- Create: `src/main/tmux/TmuxRegistry.test.ts`
- Modify: `src/main/tmux/TmuxRegistry.ts` (add `parsePaneForegroundListing` and `listPaneForeground`)
- Modify: `src/shared/runtime/terminalSession.ts` (add `getForegroundProcessName`)
- Modify: `src/main/sessionManager.ts`:
  - event map near `:168`;
  - new field;
  - track after terminal start (`~:3101`);
  - untrack in `cleanupSessionState` (`~:878`);
  - dispose in `killAll` (`~:4677`);
  - `getTerminalForegrounds()`.
- Modify: `src/main/sessions/forwarder.ts` (new channel)
- Modify: `src/main/ipc/session.ts` (snapshot handler)
- Modify: `src/preload/api/session.ts` (`onTerminalForeground`, `getTerminalForegrounds`)

**Interfaces:**
- Produces, in `@shared/types/terminalForeground`:
  ```ts
  export type TerminalForegroundSample = { command: string | null; cwd: string | null }
  export type TerminalForegroundState = { busy: boolean; command: string | null; cwd: string | null }
  export type TerminalForegroundEvent = { sessionId: string } & TerminalForegroundState
  ```
- Produces: SessionManager event `'terminal-foreground': [TerminalForegroundEvent]`, plus `getTerminalForegrounds(): Record<string, TerminalForegroundState>`.
- Produces, IPC:
  - `'session:terminal-foreground'` (event, main → owning window)
  - `'session:terminal-foregrounds'` (invoke → snapshot of the calling window's terminals)
- Produces, preload: `window.api.onTerminalForeground(cb): Unsub` and `window.api.getTerminalForegrounds(): Promise<Record<string, TerminalForegroundState>>`.

- [ ] **Step 1: Create the shared types**

`src/shared/types/terminalForeground.ts`:

```ts
// Foreground-process observation for plain shell sessions (#865).
//
// WHY this is its own boundary-neutral module rather than a field on
// AgentProcessState: agent `process-state` is consumed by the remote phone tap
// and the session recorder, and neither may learn anything about terminals
// (#866). Terminal activity therefore travels on its own channel. Its types live
// where main, preload and renderer can all import them without importing each
// other.

/** One raw observation from a backend. */
export type TerminalForegroundSample = {
  /** Process name as the OS reports it: tmux `pane_current_command`, or
   *  node-pty's `process` for a direct PTY. Null when the backend cannot say. */
  command: string | null
  /** Live working directory when the backend can report one (tmux only). */
  cwd: string | null
}

/** A classified observation: `busy` means something other than the shell owns
 *  the terminal's foreground. */
export type TerminalForegroundState = {
  busy: boolean
  command: string | null
  cwd: string | null
}

export type TerminalForegroundEvent = { sessionId: string } & TerminalForegroundState
```

- [ ] **Step 2: Write the failing monitor tests**

`src/main/sessions/terminalForeground.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { TerminalForegroundSample, TerminalForegroundState } from '@shared/types/terminalForeground.js'
import {
  TerminalForegroundMonitor,
  classifyForeground,
  normalizeForegroundCommand,
} from './terminalForeground.js'

// The monitor is the only producer of shell activity (#865). These tests pin
// the three properties that make a 1 s poll safe to run for the app's whole
// life: it only exists while terminals do, it never overlaps itself (the
// 2026-07-07 OOM was a poll without that guard), and it only speaks on change.

function harness(options: {
  panes?: () => Promise<ReadonlyMap<string, TerminalForegroundSample>>
  direct?: Record<string, string | null>
} = {}) {
  const changes: Array<[string, TerminalForegroundState]> = []
  const timers: Array<() => void> = []
  const cleared: unknown[] = []
  const listTmuxPanes = vi.fn(options.panes ?? (async () => new Map()))
  const direct = options.direct ?? {}
  const monitor = new TerminalForegroundMonitor({
    listTmuxPanes,
    sampleDirect: sessionId => (sessionId in direct ? { command: direct[sessionId], cwd: null } : null),
    onChange: (sessionId, state) => changes.push([sessionId, state]),
    setTimer: fn => { timers.push(fn); return timers.length },
    clearTimer: handle => { cleared.push(handle) },
  })
  return { monitor, changes, timers, cleared, listTmuxPanes, direct }
}

describe('classifyForeground', () => {
  it('reads a shell at its prompt as idle and anything else as busy', () => {
    expect(classifyForeground({ command: 'zsh', cwd: '/w' })).toEqual({ busy: false, command: 'zsh', cwd: '/w' })
    expect(classifyForeground({ command: '-zsh', cwd: null })).toEqual({ busy: false, command: 'zsh', cwd: null })
    expect(classifyForeground({ command: 'npm', cwd: '/w' })).toEqual({ busy: true, command: 'npm', cwd: '/w' })
    expect(classifyForeground({ command: '/usr/bin/vim', cwd: '' })).toEqual({ busy: true, command: 'vim', cwd: null })
  })

  it('treats an unknown foreground as idle rather than busy', () => {
    // A lit header must be a claim we can back; "no idea" is not "working".
    expect(classifyForeground({ command: null, cwd: null }).busy).toBe(false)
    expect(normalizeForegroundCommand('   ')).toBeNull()
  })
})

describe('TerminalForegroundMonitor', () => {
  it('does not poll until a terminal is tracked, and stops with the last one', () => {
    const { monitor, timers, cleared } = harness()
    expect(timers).toHaveLength(0)
    monitor.track('a', { kind: 'direct' })
    monitor.track('b', { kind: 'direct' })
    expect(timers).toHaveLength(1)
    monitor.untrack('a')
    expect(cleared).toHaveLength(0)
    monitor.untrack('b')
    expect(cleared).toHaveLength(1)
  })

  it('emits only when the classified state changes', async () => {
    const { monitor, changes, direct } = harness({ direct: { a: 'zsh' } })
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    await monitor.tick()
    direct.a = 'npm'
    await monitor.tick()
    await monitor.tick()
    expect(changes).toEqual([
      ['a', { busy: false, command: 'zsh', cwd: null }],
      ['a', { busy: true, command: 'npm', cwd: null }],
    ])
  })

  it('never runs two ticks at once', async () => {
    let release!: () => void
    const pending = new Promise<ReadonlyMap<string, TerminalForegroundSample>>(resolve => {
      release = () => resolve(new Map([['agentcode-1', { command: 'vim', cwd: '/w' }]]))
    })
    const { monitor, listTmuxPanes, changes } = harness({ panes: () => pending })
    monitor.track('a', { kind: 'tmux', tmuxName: 'agentcode-1' })
    const first = monitor.tick()
    await monitor.tick()
    expect(listTmuxPanes).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(changes).toEqual([['a', { busy: true, command: 'vim', cwd: '/w' }]])
  })

  it('keeps the last state when tmux cannot be read instead of flapping to idle', async () => {
    let fail = false
    const { monitor, changes } = harness({
      panes: async () => {
        if (fail) throw new Error('server exited')
        return new Map([['agentcode-1', { command: 'node', cwd: '/w' }]])
      },
    })
    monitor.track('a', { kind: 'tmux', tmuxName: 'agentcode-1' })
    await monitor.tick()
    fail = true
    await monitor.tick()
    expect(changes).toHaveLength(1)
    expect(monitor.snapshot()).toEqual({ a: { busy: true, command: 'node', cwd: '/w' } })
  })

  it('does not spawn tmux when only direct terminals are tracked', async () => {
    const { monitor, listTmuxPanes } = harness({ direct: { a: 'zsh' } })
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    expect(listTmuxPanes).not.toHaveBeenCalled()
  })

  it('forgets state on untrack so a re-tracked session reports again', async () => {
    const { monitor, changes } = harness({ direct: { a: 'zsh' } })
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    monitor.untrack('a')
    expect(monitor.snapshot()).toEqual({})
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    expect(changes).toHaveLength(2)
  })
})
```

`src/main/tmux/TmuxRegistry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { parsePaneForegroundListing } from './TmuxRegistry.js'

// The listing is parsed from ONE `tmux list-panes -a` per poll across every
// managed session, and the user's own tmux sessions share the default server,
// so the parser is where "only ours" and "one answer per session" are enforced.
describe('parsePaneForegroundListing', () => {
  it('keeps managed sessions, prefers the active pane, and preserves tabs in paths', () => {
    const output = [
      'agentcode-1\t0\tzsh\t/work/a',
      'agentcode-1\t1\tnpm\t/work/a',
      'agentcode-2\t1\tzsh\t/work/with\ttab',
      'personal\t1\tvim\t/home/me',
      'malformed',
      '',
    ].join('\n')
    expect(parsePaneForegroundListing(output, 'agentcode-')).toEqual(new Map([
      ['agentcode-1', { command: 'npm', cwd: '/work/a' }],
      ['agentcode-2', { command: 'zsh', cwd: '/work/with\ttab' }],
    ]))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `NODE_ENV=test npx vitest run --project unit src/main/sessions/terminalForeground.test.ts src/main/tmux/TmuxRegistry.test.ts`
Expected: FAIL. Neither module exports these names yet.

- [ ] **Step 4: Implement the monitor**

`src/main/sessions/terminalForeground.ts`:

```ts
import type {
  TerminalForegroundSample,
  TerminalForegroundState,
} from '@shared/types/terminalForeground.js'

// TerminalForegroundMonitor — the one producer of plain-shell activity (#865).
//
// WHY the foreground process and not PTY output recency: a shell prompt redraw,
// a clock in the prompt or a TUI's cursor blink all produce output without any
// work happening, and a silent `sleep 600` produces none while very much
// running. The OS already answers the question we mean ("does something other
// than the shell own this terminal?"): tmux reports it as
// `pane_current_command`, and node-pty reports it as `pty.process`.
//
// WHY one poller for all terminals: tmux answers for every managed session in a
// single `list-panes -a` spawn, so the cost is one short-lived process per second
// however many shells are open, and zero when none are.

/** Login shells appear as `-zsh`; the leading dash is stripped before lookup. */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'pwsh', 'login',
])

const DEFAULT_INTERVAL_MS = 1000

export type TerminalForegroundSource =
  | { kind: 'tmux'; tmuxName: string }
  | { kind: 'direct' }

export function normalizeForegroundCommand(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const base = trimmed.split('/').pop() ?? trimmed
  const bare = base.startsWith('-') ? base.slice(1) : base
  return bare || null
}

export function classifyForeground(sample: TerminalForegroundSample): TerminalForegroundState {
  const command = normalizeForegroundCommand(sample.command)
  const cwd = typeof sample.cwd === 'string' && sample.cwd.length > 0 ? sample.cwd : null
  // Unknown (null) is idle on purpose: a lit header is a claim, and "the
  // backend could not tell us" is not evidence of work.
  return { busy: command !== null && !SHELL_COMMANDS.has(command), command, cwd }
}

function sameForeground(a: TerminalForegroundState | undefined, b: TerminalForegroundState): boolean {
  return a !== undefined && a.busy === b.busy && a.command === b.command && a.cwd === b.cwd
}

export type TerminalForegroundMonitorDeps = {
  /** Every managed tmux session's foreground, keyed by tmux session name. */
  listTmuxPanes: () => Promise<ReadonlyMap<string, TerminalForegroundSample>>
  /** Direct-PTY foreground for one session, or null when it cannot be read. */
  sampleDirect: (sessionId: string) => TerminalForegroundSample | null
  onChange: (sessionId: string, state: TerminalForegroundState) => void
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class TerminalForegroundMonitor {
  private readonly sources = new Map<string, TerminalForegroundSource>()
  private readonly last = new Map<string, TerminalForegroundState>()
  private readonly intervalMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private timer: unknown = null
  private inFlight = false
  private disposed = false

  constructor(private readonly deps: TerminalForegroundMonitorDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setInterval(fn, ms)
      // The poller must never be the thing keeping main alive at quit.
      handle.unref?.()
      return handle
    })
    this.clearTimer = deps.clearTimer ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  track(sessionId: string, source: TerminalForegroundSource): void {
    if (this.disposed) return
    this.sources.set(sessionId, source)
    if (this.timer === null) this.timer = this.setTimer(() => { void this.tick() }, this.intervalMs)
  }

  untrack(sessionId: string): void {
    this.sources.delete(sessionId)
    // Forgetting is what lets a recovered session under the same id report its
    // first sample again instead of being deduped against a dead predecessor.
    this.last.delete(sessionId)
    if (this.sources.size === 0) this.stopTimer()
  }

  snapshot(): Record<string, TerminalForegroundState> {
    return Object.fromEntries(this.last)
  }

  /** One poll. Public for tests; production calls it from the interval. */
  async tick(): Promise<void> {
    // WHY the in-flight guard is load-bearing: the 2026-07-07 OOM was a 200 ms
    // poll with no guard whose reads piled up behind a slow filesystem. A tmux
    // server that stalls must cost one pending tick, not one per second forever.
    if (this.inFlight || this.disposed || this.sources.size === 0) return
    this.inFlight = true
    try {
      const needsTmux = [...this.sources.values()].some(source => source.kind === 'tmux')
      const panes = needsTmux ? await this.deps.listTmuxPanes().catch(() => null) : null
      if (this.disposed) return
      // Iterates the live map after the await, so a session untracked while
      // tmux answered is simply absent here and never resurrected.
      for (const [sessionId, source] of this.sources) {
        const sample = source.kind === 'tmux'
          ? panes?.get(source.tmuxName) ?? null
          : this.deps.sampleDirect(sessionId)
        // No sample means "unknown this tick" (tmux hiccup, PTY mid-exit). Keep
        // the last answer rather than flapping the header idle and back.
        if (!sample) continue
        const next = classifyForeground(sample)
        if (sameForeground(this.last.get(sessionId), next)) continue
        this.last.set(sessionId, next)
        this.deps.onChange(sessionId, next)
      }
    } finally {
      this.inFlight = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer()
    this.sources.clear()
    this.last.clear()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }
}
```

In `TmuxRegistry.ts`, add `import type { TerminalForegroundSample } from '@shared/types/terminalForeground.js'` beside the existing imports. Add these module-level declarations above `export class TmuxRegistry`:

```ts
// One `list-panes -a` answers for every session on the server. Tab-separated
// because none of the first three fields can contain a tab (session names are
// prefix + UUID, pane_active is 0/1, command names are process names), so a
// path containing tabs is recovered by joining whatever follows the third tab.
const PANE_FOREGROUND_FORMAT = '#{session_name}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}'

export function parsePaneForegroundListing(
  output: string,
  namePrefix: string,
): Map<string, TerminalForegroundSample> {
  const panes = new Map<string, TerminalForegroundSample & { active: boolean }>()
  for (const line of output.split('\n')) {
    if (!line) continue
    const [name, active, command, ...pathParts] = line.split('\t')
    // The default tmux server is shared with the user's own sessions; only
    // prefixed names are ours to report.
    if (!name?.startsWith(namePrefix) || command === undefined) continue
    const isActive = active === '1'
    // Agent Code sessions have one pane, but a user can split one with the
    // prefix key. The active pane is the one the attached client shows.
    if (panes.get(name)?.active && !isActive) continue
    panes.set(name, { command: command || null, cwd: pathParts.join('\t') || null, active: isActive })
  }
  return new Map([...panes].map(([name, { command, cwd }]) => [name, { command, cwd }]))
}
```

Inside the class, after `listManagedSessions()`:

```ts
  /** Foreground command + cwd for every managed session, from ONE tmux spawn
   *  (#865). Empty when tmux is unavailable or the server has no sessions. */
  async listPaneForeground(): Promise<Map<string, TerminalForegroundSample>> {
    if (!this.isAvailable()) return new Map()
    const out = await this.runTmuxCapture(['list-panes', '-a', '-F', PANE_FOREGROUND_FORMAT]).catch(() => '')
    return parsePaneForegroundListing(out, this.namePrefix)
  }
```

In `terminalSession.ts`, after `getProcessPid()`:

```ts
  /**
   * Name of the PTY's foreground process, for DIRECT PTYs only (#865).
   *
   * WHY null in tmux mode: there the PTY's child is the `tmux attach` client,
   * so node-pty would name `tmux` forever. The tmux server reports the real
   * foreground through TmuxRegistry.listPaneForeground instead.
   */
  getForegroundProcessName(): string | null {
    if (this.runtime !== 'direct' || !this.pty) return null
    try {
      return this.pty.process || null
    } catch {
      // The getter reads the tty's process group; a PTY mid-exit can throw.
      return null
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: the same command as Step 3.
Expected: PASS.

- [ ] **Step 6: Wire the monitor into SessionManager, the forwarder, IPC and preload**

`sessionManager.ts`. Add these imports:

```ts
import { TerminalForegroundMonitor } from '@main/sessions/terminalForeground.js'
import type { TerminalForegroundEvent, TerminalForegroundState } from '@shared/types/terminalForeground.js'
```

In the manager's event map, beside `'process-state': [...]` at `~:168`, add:

```ts
  'terminal-foreground': [TerminalForegroundEvent]
```

Add this field next to `terminalBuffers`. Initializers only capture `this` in closures that run later, so field order does not matter:

```ts
  // Shell activity producer (#865). Emits on a channel of its own, NOT
  // 'process-state': the remote tap and the recorder subscribe to
  // process-state and must never learn about terminals (#866).
  private readonly terminalForeground = new TerminalForegroundMonitor({
    listTmuxPanes: async () => this.tmuxRegistry?.listPaneForeground() ?? new Map(),
    sampleDirect: sessionId => {
      const entry = this.sessions.get(sessionId)
      if (entry?.kind !== 'terminal') return null
      const command = entry.session.getForegroundProcessName()
      return command === null ? null : { command, cwd: null }
    },
    onChange: (sessionId, state) => {
      this.markActivity(sessionId)
      this.emit('terminal-foreground', { sessionId, ...state })
    },
  })
```

In the terminal spawn branch, right after `this.setInputReadiness(sessionId, { ready: true, reason: 'ready' })`:

```ts
      // Start observing only once the shell is really up, so a failed start
      // never leaves a tracked id behind (cleanupSessionState untracks).
      this.terminalForeground.track(
        sessionId,
        tmuxSessionName ? { kind: 'tmux', tmuxName: tmuxSessionName } : { kind: 'direct' },
      )
```

In `cleanupSessionState`, inside `if (kind === 'terminal') {`, add `this.terminalForeground.untrack(sessionId)` beside the two buffer deletes.

In `killAll()`, right after `this.shuttingDown = true`, add `this.terminalForeground.dispose()`.

Add this public method near `getLastActivityAt`:

```ts
  /** Current foreground state of every tracked terminal (#865). */
  getTerminalForegrounds(): Record<string, TerminalForegroundState> {
    return this.terminalForeground.snapshot()
  }
```

`forwarder.ts`. After the `terminal-data` forward, add:

```ts
  // Shell activity (#865) crosses directly: the monitor already emits only on
  // change (at most once per terminal per second), so there is no burst for a
  // coalescer to absorb.
  manager.on('terminal-foreground', payload =>
    sendToSessionWindow(payload.sessionId, 'session:terminal-foreground', payload),
  )
```

`ipc/session.ts`. Import `sessionsOwnedBy, windowIdFor` from `'@main/window/windowRegistry.js'` if they are not already imported. After the `session:terminal-attach` handler, add:

```ts
  // Snapshot for a renderer that restored after the last change event. The
  // monitor emits on change only, so without this a reload would show every
  // busy shell idle until its foreground moved again. Filtered to the caller's
  // own sessions: every window invokes this, and another window's terminals must
  // not grow runtimes here.
  ipcMain.handle('session:terminal-foregrounds', evt => {
    const windowId = windowIdFor(evt.sender)
    const owned = new Set(windowId === null ? [] : sessionsOwnedBy(windowId))
    return Object.fromEntries(
      Object.entries(manager.getTerminalForegrounds()).filter(([sessionId]) => owned.has(sessionId)),
    )
  })
```

`preload/api/session.ts`. Import `TerminalForegroundEvent, TerminalForegroundState` as types from `'@shared/types/terminalForeground.js'`. In the `sessionApi` object, next to `onSessionAgentPtyData`, add:

```ts
  /** Foreground-process changes for plain terminals (#865). Desktop-only:
   *  deliberately not on SessionFeed, because the phone never shows terminals. */
  onTerminalForeground: (cb: (e: TerminalForegroundEvent) => void): Unsub =>
    subscribe('session:terminal-foreground', cb),

  getTerminalForegrounds: (): Promise<Record<string, TerminalForegroundState>> =>
    ipcRenderer.invoke('session:terminal-foregrounds'),
```

- [ ] **Step 7: Type-check**

Run: `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`
Expected: exit 0.
- If tsc reports that `emit('terminal-foreground', …)` does not match the event map, the entry from above is missing or misspelled.
- If `window.api` is typed from a hand-written `index.d.ts` rather than inferred from `sessionApi`, add the two methods there with the same signatures.

No SessionManager-level test is added: wiring it would need a real node-pty spawn, which this suite does not do. The monitor, the classifier and the tmux parser carry the behavior. The renderer side of the channel is tested in Task 4.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types/terminalForeground.ts src/main/sessions/terminalForeground.ts \
  src/main/sessions/terminalForeground.test.ts src/main/tmux/TmuxRegistry.ts src/main/tmux/TmuxRegistry.test.ts \
  src/shared/runtime/terminalSession.ts src/main/sessionManager.ts src/main/sessions/forwarder.ts \
  src/main/ipc/session.ts src/preload/api/session.ts
git commit -m "feat(sessions): report plain terminal activity from the foreground process

Shells emitted only started/data/exit, so nothing could say a terminal was
busy: Status Mode, tab counts and the Dispatch shell subtitle never lit. A
single poller asks tmux (one list-panes for every managed session) or node-pty
which process owns each terminal's foreground, and emits only on change on a
dedicated channel, so the remote tap and the recorder never see terminal state.
The poll exists only while terminals do and cannot overlap itself.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 4: Terminal activity in the renderer runtime

**Files:**
- Modify: `src/renderer/src/session-runtime/state.ts`: add the `terminalForeground` field to `SessionRuntime` near `activityStatus` (`~:466`) and to `emptyRuntime()` (`~:803`).
- Create: `src/renderer/src/session-runtime/unread.ts`
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`: delete the local `withUnread` (`~:682-705`) and import it from `unread.ts`.
- Create: `src/renderer/src/session-runtime/terminalForeground.ts`
- Create: `src/renderer/src/session-runtime/terminalForeground.test.ts`
- Create: `src/renderer/src/workspace/hook/ipc/useTerminalForeground.ts`
- Create: `src/renderer/src/workspace/hook/ipc/useTerminalForeground.renderer.test.tsx`
- Modify: `src/renderer/src/workspace/hook/index.ts`: call the hook right after `useIpcSubscriptions(...)` (`~:872`).

**Interfaces:**
- Consumes (Task 3): `TerminalForegroundState`, `TerminalForegroundEvent`, `window.api.onTerminalForeground`, `window.api.getTerminalForegrounds`.
- Produces: `SessionRuntime.terminalForeground: TerminalForegroundRuntime | null`, where `export type TerminalForegroundRuntime = TerminalForegroundState & { changedAt: number }` is exported from `session-runtime/state.ts`.
- Produces: `withUnread(runtime, kind: 'output' | 'attention', now = Date.now()): SessionRuntime`.
- Produces: `applyTerminalForeground(runtime, state, now): SessionRuntime`. It returns the same object when nothing changed.
- Produces: `useTerminalForeground(restoreStatus: WorkspaceRestoreStatus, setRuntimes: AppStore['setWorkspaceRuntimes']): void`.
- Consumed by Tasks 5, 6 and 9, which read `runtime.terminalForeground` and `runtime.sessionStatus`.

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/session-runtime/terminalForeground.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { emptyRuntime } from './state'
import { applyTerminalForeground } from './terminalForeground'

// The renderer half of #865: one observation from main becomes the same
// runtime fields an agent's spinner produces, so Status Mode, tab counts, the
// close confirmation and Dispatch need no terminal-specific code at all.

const idle = { busy: false, command: 'zsh', cwd: '/work/api' }
const busy = { busy: true, command: 'npm', cwd: '/work/api' }

describe('applyTerminalForeground', () => {
  it('reads a busy foreground as running, with the command as the activity', () => {
    const next = applyTerminalForeground(emptyRuntime(), busy, 1_000)
    expect(next).toMatchObject({
      sessionStatus: 'running',
      processActive: true,
      activityStatus: 'npm',
      terminalForeground: { ...busy, changedAt: 1_000 },
    })
  })

  it('returns the same object for a repeated observation', () => {
    const once = applyTerminalForeground(emptyRuntime(), busy, 1_000)
    expect(applyTerminalForeground(once, busy, 2_000)).toBe(once)
  })

  it('marks the session unread when a command finishes, not when one starts', () => {
    const started = applyTerminalForeground(emptyRuntime(), busy, 1_000)
    expect(started.unreadKind).toBeNull()
    const finished = applyTerminalForeground(started, idle, 5_000)
    expect(finished).toMatchObject({ sessionStatus: 'idle', unreadKind: 'output', unreadSince: 5_000 })
  })

  it('never downgrades an attention marker to plain output', () => {
    const started = { ...applyTerminalForeground(emptyRuntime(), busy, 1_000), unreadKind: 'attention' as const, unreadSince: 500 }
    expect(applyTerminalForeground(started, idle, 5_000)).toMatchObject({ unreadKind: 'attention', unreadSince: 500 })
  })

  it('records a cd as activity without marking anything unread', () => {
    const atPrompt = applyTerminalForeground(emptyRuntime(), idle, 1_000)
    const moved = applyTerminalForeground(atPrompt, { ...idle, cwd: '/work/web' }, 3_000)
    expect(moved.terminalForeground).toEqual({ ...idle, cwd: '/work/web', changedAt: 3_000 })
    expect(moved.unreadKind).toBeNull()
  })

  it('keeps an exited terminal exited', () => {
    const exited = { ...emptyRuntime(), exited: 0, sessionStatus: 'exited' as const }
    expect(applyTerminalForeground(exited, busy, 1_000).sessionStatus).toBe('exited')
  })
})
```

`src/renderer/src/workspace/hook/ipc/useTerminalForeground.renderer.test.tsx`:

```tsx
import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { TerminalForegroundEvent, TerminalForegroundState } from '@shared/types/terminalForeground'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import { useTerminalForeground } from './useTerminalForeground'

const initialStore = useAppStore.getState()
const originalApi = window.api
afterEach(() => {
  useAppStore.setState(initialStore, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

function Harness({ status }: { status: WorkspaceRestoreStatus }) {
  useTerminalForeground(status, useAppStore(state => state.setWorkspaceRuntimes))
  return null
}

it('applies live events, and adopts the snapshot only once the workspace has restored', async () => {
  let live!: (event: TerminalForegroundEvent) => void
  const snapshot: Record<string, TerminalForegroundState> = { shell: { busy: true, command: 'npm', cwd: '/w' } }
  const getTerminalForegrounds = vi.fn(async () => snapshot)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onTerminalForeground: (cb: typeof live) => { live = cb; return () => {} },
      getTerminalForegrounds,
    },
  })

  const { rerender } = render(<Harness status="pending" />)
  // Before restore the runtimes are about to be replaced by rehydrate, so a
  // snapshot applied now would be thrown away. It must wait.
  expect(getTerminalForegrounds).not.toHaveBeenCalled()

  rerender(<Harness status="complete-restore" />)
  await act(async () => { await Promise.resolve() })
  expect(useAppStore.getState().workspaceRuntimes.shell?.sessionStatus).toBe('running')

  act(() => live({ sessionId: 'shell', busy: false, command: 'zsh', cwd: '/w' }))
  expect(useAppStore.getState().workspaceRuntimes.shell).toMatchObject({ sessionStatus: 'idle', unreadKind: 'output' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/session-runtime/terminalForeground.test.ts
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/hook/ipc/useTerminalForeground.renderer.test.tsx
```
Expected: FAIL, because the modules do not exist yet.

- [ ] **Step 3: Implement**

In `session-runtime/state.ts`, add the import `import type { TerminalForegroundState } from '@shared/types/terminalForeground'` and export:

```ts
/** One classified foreground observation for a plain terminal (#865), plus
 *  when it last changed. `changedAt` doubles as the terminal's "last active"
 *  time: shells have no transcript timestamps to age them by. */
export type TerminalForegroundRuntime = TerminalForegroundState & { changedAt: number }
```

In `SessionRuntime`, directly after `activityStatus: string | null`, add:

```ts
  /** Plain terminals only (#865): what owns the shell's foreground right now.
   *  Null for agents and for terminals main has not sampled yet. Written only
   *  by applyTerminalForeground, which also keeps processActive/activityStatus
   *  in step so every status consumer lights for shells unchanged. */
  terminalForeground: TerminalForegroundRuntime | null
```

In `emptyRuntime()`, add `terminalForeground: null,` next to `activityStatus: null,`. Then run `npx tsc -p tsconfig.web.json --pretty false`. Anywhere tsc reports a `SessionRuntime` literal missing `terminalForeground`, add `terminalForeground: null`.

`src/renderer/src/session-runtime/unread.ts`: move the body of `withUnread` here, including its full existing WHY comment, verbatim from `useIpcSubscriptions.ts`:

```ts
import type { SessionRuntime } from './state'

/**
 * Mark a runtime unread.
 *
 * (Paste the existing WHY comment from useIpcSubscriptions' withUnread here
 * unchanged: "Unread is an acknowledgement marker, not a focus marker. …".)
 *
 * WHY this is a module now (#865): terminal foreground changes arrive through
 * their own subscription hook and must mark "command finished" exactly the way
 * an agent's turn completion does. Two copies of "attention outranks output"
 * is how a list badge and a pane come to disagree.
 */
export function withUnread(
  runtime: SessionRuntime,
  kind: 'output' | 'attention',
  now: number = Date.now(),
): SessionRuntime {
  const unreadKind =
    runtime.unreadKind === 'attention' || kind === 'attention'
      ? 'attention'
      : 'output'
  return {
    ...runtime,
    unreadSince: runtime.unreadSince ?? now,
    unreadKind,
  }
}
```

In `useIpcSubscriptions.ts`, delete the local `const withUnread = (…) => {…}` and add `import { withUnread } from '@renderer/session-runtime/unread'`. The two call sites (`withUnread(nextCurrent, 'output')` and `withUnread(logged, 'attention')`) keep working unchanged, because `now` defaults to `Date.now()`.

`src/renderer/src/session-runtime/terminalForeground.ts`:

```ts
import type { TerminalForegroundState } from '@shared/types/terminalForeground'
import { withDerivedSessionStatus } from '@renderer/session-runtime/semantic/helpers'
import type { SessionRuntime } from './state'
import { withUnread } from './unread'

/**
 * Fold one terminal foreground observation into a runtime (#865).
 *
 * WHY it drives processActive/activityStatus instead of a terminal-only status
 * field: deriveSessionStatus already turns processActive into `running`, and
 * every consumer (Status Mode, tab counts, the close confirmation, Dispatch)
 * reads sessionStatus. Feeding the existing input lights all of them for shells
 * with zero terminal branches downstream.
 *
 * WHY busy→idle marks unread: that transition is "your command finished", the
 * shell equivalent of an agent turn completing. Terminal clicks/keys already
 * acknowledge through TerminalLeaf, so a user watching the pane clears it by
 * typing the next command.
 */
export function applyTerminalForeground(
  runtime: SessionRuntime,
  state: TerminalForegroundState,
  now: number,
): SessionRuntime {
  const previous = runtime.terminalForeground
  if (
    previous &&
    previous.busy === state.busy &&
    previous.command === state.command &&
    previous.cwd === state.cwd
  ) {
    // Identity-preserving: the store would otherwise re-render every
    // subscriber for an observation that changes nothing.
    return runtime
  }
  const next = withDerivedSessionStatus({
    ...runtime,
    terminalForeground: { ...state, changedAt: now },
    processActive: state.busy,
    activityStatus: state.busy ? state.command : null,
  })
  return previous?.busy === true && !state.busy ? withUnread(next, 'output', now) : next
}
```

`src/renderer/src/workspace/hook/ipc/useTerminalForeground.ts`:

```ts
import { useCallback, useEffect } from 'react'

import type { AppStore } from '@renderer/app-state/types'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { applyTerminalForeground } from '@renderer/session-runtime/terminalForeground'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import type { TerminalForegroundState } from '@shared/types/terminalForeground'

// Shell activity subscription (#865).
//
// WHY this is its own hook and not a listener inside useIpcSubscriptions: that
// hub consumes the injected SessionFeed so the phone can drive it, and its
// header forbids widening the feed for desktop-only channels. Terminal activity
// is desktop-only by design (#866): the phone never shows terminals. So it
// subscribes to window.api directly, the documented home for side channels.
//
// WHY the bridge is typeof-guarded: renderer tests and non-Electron hosts
// install only the bridge methods they need, and a missing side channel must
// degrade to "no shell activity", never crash the workspace.
export function useTerminalForeground(
  restoreStatus: WorkspaceRestoreStatus,
  setRuntimes: AppStore['setWorkspaceRuntimes'],
): void {
  const apply = useCallback((sessionId: string, state: TerminalForegroundState) => {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      // Same ownership fence every SessionFeed channel honors: a runtime
      // quarantined after a failed recovery must not accept foreign state.
      if (current.recoveryFailureCode === 'ownership-conflict') return prev
      const next = applyTerminalForeground(current, state, Date.now())
      return next === current ? prev : { ...prev, [sessionId]: next }
    })
  }, [setRuntimes])

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (typeof bridge?.onTerminalForeground !== 'function') return
    return bridge.onTerminalForeground(({ sessionId, ...state }) => apply(sessionId, state))
  }, [apply])

  // WHY the snapshot waits for restore: rehydrate replaces the runtime map,
  // so a snapshot applied while restore is pending would be overwritten. Main
  // emits on change only, so without this one pull a busy dev server would read
  // idle after a renderer reload until its foreground moved again.
  const restored = restoreStatus !== 'pending'
  useEffect(() => {
    if (!restored) return
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (typeof bridge?.getTerminalForegrounds !== 'function') return
    let live = true
    void bridge.getTerminalForegrounds()
      .then(snapshot => {
        if (!live) return
        for (const [sessionId, state] of Object.entries(snapshot)) apply(sessionId, state)
      })
      .catch(() => {
        // A failed snapshot only means shells read idle until their next
        // change; nothing here is worth surfacing to the user.
      })
    return () => { live = false }
  }, [restored, apply])
}
```

In `hook/index.ts`, import `useTerminalForeground` and, directly after the `useIpcSubscriptions(sessionFeed, refs, …)` line, add:

```ts
  useTerminalForeground(restoreStatus, setRuntimes)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the two commands from Step 2, plus
`NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.renderer.test.tsx`. This one proves the `withUnread` move changed nothing.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/session-runtime src/renderer/src/workspace/hook/ipc/useTerminalForeground.ts \
  src/renderer/src/workspace/hook/ipc/useTerminalForeground.renderer.test.tsx \
  src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts src/renderer/src/workspace/hook/index.ts
git commit -m "feat(workspace): light running terminals and mark finished commands unread

Main's foreground observations become the same processActive/activityStatus
inputs an agent spinner produces, so Status Mode, tab counts, the close
confirmation and Dispatch treat a busy shell as running with no terminal
branches downstream. A finished command marks the session unread like a
completed turn. withUnread moves to session-runtime so both writers share the
attention-outranks-output rule.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 5: Plain terminals render the shared header and can auto-follow

**Files:**
- Rename: `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts` → `terminalFollow.ts`; rename the export `useAgentTerminalFollow` → `useTerminalFollow`.
- Rename: `src/renderer/src/workspace/tile-tree/agentTerminalFollow.system.test.ts` → `terminalFollow.system.test.ts`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx` (import only)
- Modify: `src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/TileTree.tsx:172-181` (the terminal branch of `WorkspaceLeaf`)
- Modify: `src/renderer/src/workspace/tile-tree/TerminalLeaf.dictationOwnership.renderer.test.tsx` and `TerminalLeaf.retention.renderer.test.tsx`: pass the new required prop
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts`: `toggle-tail` `when` (`~:518-527`), `toggle-tail-all` description (`~:545`), `jump-latest-message` `when` and description (`~:560-575`)
- Test: create `src/renderer/src/workspace/tile-tree/TerminalLeaf.header.renderer.test.tsx`
- Test: modify `src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts`

**Interfaces:**
- Consumes: Task 4 `runtime.terminalForeground`, `runtime.sessionStatus`; Task 1/2 title and name row via `PaneHeader` → `AgentTitleHeader`.
- Produces: `TerminalLeaf` prop `showStatusMode: boolean` (required, mirroring #853's decision for `AgentTerminalLeaf`).
- Produces: `useTerminalFollow({ sessionId, scrollToLatestRequest, tailActive, termRef })`. The signature and return (`{ tailActiveRef, attach(term) }`) are unchanged.
- Produces: root `data-pane-id={sessionId}` on plain terminal panes. Tasks 10 and 11 rely on it for `agents.show`.

- [ ] **Step 1: Rename the follow hook**

```bash
git mv src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts src/renderer/src/workspace/tile-tree/terminalFollow.ts
git mv src/renderer/src/workspace/tile-tree/agentTerminalFollow.system.test.ts src/renderer/src/workspace/tile-tree/terminalFollow.system.test.ts
grep -rln "agentTerminalFollow\|useAgentTerminalFollow" src
```

In every file the grep lists, replace the module path `agentTerminalFollow` with `terminalFollow` and the identifier `useAgentTerminalFollow` with `useTerminalFollow`. In `terminalFollow.ts`, change the first comment line to:

```ts
// Both xterm leaves (AgentTerminalLeaf, and TerminalLeaf since #865) keep their
// expensive PTY/xterm attachment keyed on sessionId. Follow intent changes
```

Run `NODE_ENV=test npx vitest run --project system src/renderer/src/workspace/tile-tree/terminalFollow.system.test.ts`.
Expected: PASS. It is a pure rename.

- [ ] **Step 2: Write the failing header test**

`src/renderer/src/workspace/tile-tree/TerminalLeaf.header.renderer.test.tsx`:

```tsx
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TerminalLeaf } from './TerminalLeaf'

// #865: plain terminals render the shared PaneHeader instead of a hand-drawn
// `terminal $` strip. Same drift #851 fixed for agent terminal views: every
// header feature added since April (cwd, color flag, title/name row, Status
// Mode) skipped the copy. Assertions read the data-* hooks PaneHeader exposes,
// never Tailwind classes.

const store = vi.hoisted(() => ({
  settings: {
    dictationEnabled: false,
    dictationProvider: 'local',
    dictationShortcut: 'off',
    agentNamesEnabled: false,
    dispatchColorFlags: {} as Record<string, string>,
  },
  tailAllMode: false,
  workspaceState: { sessions: {} as Record<string, { cwd: string; kind: string; title?: string }> },
  workspaceRuntimes: {} as Record<string, unknown>,
  workspaceAgentNames: {} as Record<string, string>,
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store),
}))
vi.mock('@renderer/workspace/terminal/xtermWebglRenderer', () => ({
  attachXtermWebglRenderer: () => ({ ready: Promise.resolve(true), dispose: () => {} }),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    rows = 40
    options: Record<string, unknown> = {}
    modes = { bracketedPasteMode: true }
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0 } }
    dispose() {}
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    scrollToBottom() {}
    scrollToLine() {}
    registerMarker() { return null }
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@renderer/app-state/settings/theme', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  THEME_CHANGED_EVENT: 'agent-code:test-theme-change',
  getActiveAppFontFamily: () => 'monospace',
}))
vi.mock('@renderer/workspace/tile-tree/xtermTheme', () => ({ readXtermTheme: () => ({}), syncXtermTheme: () => {} }))
vi.mock('@renderer/workspace/tile-tree/TileLeaf/useComposerDictation', () => ({ useComposerDictation: () => {} }))

const workspace = {
  acknowledgeSession: vi.fn(),
  // Never settles: the header must not wait on the PTY.
  ensureSessionLive: vi.fn(() => new Promise(() => {})),
  showPaneToast: vi.fn(),
} as unknown as Workspace

function leaf(showStatusMode = true) {
  return (
    <TerminalLeaf
      sessionId="shell"
      paneLabel="A1"
      focused
      onFocusRequest={() => {}}
      workspace={workspace}
      showStatusMode={showStatusMode}
    />
  )
}

function statusRow(container: HTMLElement): Element {
  const row = container.querySelector('[data-pane-header-row="true"]')
  if (!row) throw new Error('plain terminal rendered no shared status row')
  return row
}

beforeEach(() => {
  store.workspaceState.sessions = { shell: { cwd: '/work/api', kind: 'terminal' } }
  store.workspaceRuntimes = {}
  store.settings.dispatchColorFlags = {}
  store.tailAllMode = false
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { disconnect() {} observe() {} unobserve() {} })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      attachTerminal: () => new Promise(() => {}),
      onSessionTerminalData: () => () => {},
      resize: () => Promise.resolve(),
      sendInput: () => Promise.resolve(true),
    },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  vi.unstubAllGlobals()
})

describe('TerminalLeaf shared header', () => {
  it('renders the shared status row, the pane id hook and the spawn folder', () => {
    const { container } = render(leaf())
    expect(statusRow(container)).toHaveTextContent('terminal')
    expect(container.querySelector('[data-pane-id="shell"]')).not.toBeNull()
    expect(container.querySelector('[title="/work/api"]')).not.toBeNull()
  })

  it('names the foreground command and lights Status Mode while a command runs', () => {
    store.workspaceRuntimes = {
      shell: { sessionStatus: 'running', terminalForeground: { busy: true, command: 'npm', cwd: '/work/web', changedAt: 1 } },
    }
    const { container } = render(leaf())
    expect(statusRow(container)).toHaveTextContent('npm')
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('true')
    // Live cwd from tmux wins over the spawn cwd, so the header follows `cd`.
    expect(container.querySelector('[title="/work/web"]')).not.toBeNull()
  })

  it('honors Status Mode being off', () => {
    store.workspaceRuntimes = { shell: { sessionStatus: 'running', terminalForeground: null } }
    const { container } = render(leaf(false))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('false')
  })

  it('shows the color flag and the title row', () => {
    store.settings.dispatchColorFlags = { shell: 'red' }
    store.workspaceState.sessions.shell.title = 'dev server'
    const { container } = render(leaf())
    expect(container.querySelector('[data-pane-color-flag="red"]')).not.toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('dev server')
  })

  it('shows the TAIL pill while auto-follow is on', () => {
    store.workspaceRuntimes = { shell: { tailMode: true } }
    const { container } = render(leaf())
    expect(statusRow(container)).toHaveTextContent('TAIL')
  })
})
```

In `paneCommands.follow.renderer.test.ts`, replace `it('keeps both commands hidden for plain shell terminals and visible for agent kinds', …)` with:

```ts
  it('offers both follow commands for plain shell terminals as well as every agent kind (#865)', () => {
    // Plain terminals follow through the same xterm hook as agent terminal
    // views now; there is no kind left for which these commands are inert.
    for (const command of [tail!, jump!]) {
      for (const kind of ['terminal', 'claude', 'codex', 'opencode']) {
        expect(command.when?.(contextWithKind(kind))).toBe(true)
      }
    }
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/tile-tree/TerminalLeaf.header.renderer.test.tsx src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts`
Expected: FAIL (no shared row, no `data-pane-id`, `when` false for `terminal`).

- [ ] **Step 4: Implement TerminalLeaf**

Imports to add:

```ts
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { paneHeaderStatusLit } from '@renderer/workspace/tile-tree/TileLeaf/paneHeaderStatus'
import { useTerminalFollow } from '@renderer/workspace/tile-tree/terminalFollow'
```

`Props`: add `showStatusMode: boolean` and destructure it.

Replace the header paragraph "No feed, no composer, no overlays." (lines 22-28) with the following. Keep the rest of that comment block unchanged.

```ts
// Counterpart to TileLeaf. Where TileLeaf owns the elaborate agent UI (feed,
// composer, slash picker, …), TerminalLeaf is the minimal VS Code-style
// integrated terminal: one xterm.js instance under the SHARED pane header. No
// feed, no composer. Since #865 the header, title/name row, color flag,
// Status Mode fill and auto-follow are the same ones agents get; only
// transcript and composer features stay agent-only.
```

Directly after `focusedRef.current = focused` (`~:140`), before the mount effect, add:

```ts
  // Session metadata and activity as PRIMITIVE selectors (#865). This leaf
  // deliberately never takes the runtime as a prop: the xterm owns its output
  // path, and a runtime prop would re-render the leaf on every PTY chunk. Each
  // value below changes only on the transition that changes what is painted.
  const title = useAppStore(state => state.workspaceState?.sessions?.[sessionId]?.title)
  const spawnCwd = useAppStore(state => state.workspaceState?.sessions?.[sessionId]?.cwd ?? null)
  const liveCwd = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.terminalForeground?.cwd ?? null)
  const foregroundCommand = useAppStore(state => {
    const foreground = state.workspaceRuntimes?.[sessionId]?.terminalForeground
    return foreground?.busy ? foreground.command : null
  })
  const isSessionLive = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.sessionStatus === 'running')
  const tailMode = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.tailMode === true)
  const tailAllMode = useAppStore(state => state.tailAllMode === true)
  const scrollToLatestRequest = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.scrollToLatestRequest ?? 0)
  // Same mask AgentTerminalLeaf uses: a display:none pane cannot scroll, and
  // folding visibility in makes re-reveal a real transition that re-engages.
  const tailActive = (tailMode || tailAllMode) && ownerVisible
  // Must run BEFORE the mount effect below: its effects read termRef at effect
  // time and React runs passive effects in declaration order.
  const follow = useTerminalFollow({ sessionId, scrollToLatestRequest, tailActive, termRef })
```

Inside the mount effect:
- Declare `let offFollowAttach: (() => void) | null = null` beside the other tracked resources.
- After `fitRef.current = fit`, add `offFollowAttach = follow.attach(term)`.
- In the cleanup, add `offFollowAttach?.()` before `term?.dispose()`.

Replace the live-data subscriber body with:

```ts
      offTerminalData = subscribeToTerminalData(sessionId, data => {
        if (!attachedBackfillDone) {
          backlogQueue.push(data)
          return
        }
        const liveTerm = term
        if (follow.tailActiveRef.current) {
          // Scroll in the write-completion callback: xterm parses chunks
          // asynchronously, so a synchronous scroll lands one chunk early.
          // Re-check at fire time: tail can disengage or the pane unmount first.
          liveTerm?.write(data, () => {
            if (disposed || !follow.tailActiveRef.current) return
            liveTerm.scrollToBottom()
          })
        } else {
          liveTerm?.write(data)
        }
      })
```

Replace `void forwarder.replay(liveTerm, [buffer, backlogQueue.join('')])` with:

```ts
          forwarder
            .replay(liveTerm, [buffer, backlogQueue.join('')])
            .then(() => {
              // Pin once the backfill is really parsed, not before it lands.
              if (disposed || !follow.tailActiveRef.current || termRef.current !== liveTerm) return
              liveTerm.scrollToBottom()
            })
            .catch(error => {
              if (!disposed) showPaneToastRef.current(sessionId,
                error instanceof Error ? error.message : 'Could not replay terminal')
            })
```

Before the `return (`, add:

```ts
  // PaneHeader's own rule, so the badge/TAIL colors can never disagree with
  // the fill they sit on (same reason as AgentTerminalLeaf).
  const statusLit = paneHeaderStatusLit(showStatusMode, isSessionLive)
```

Add `data-pane-id={sessionId}` to the root `<div>`, with this comment above the `className`:

```tsx
      // data-pane-id: agents.show, the HTML debug capture and the debug
      // bundle locate panes by it; plain terminals were the one leaf without it.
```

Replace the whole hand-drawn header `<div>` (the "Compact header to match…" block, lines 561-574) with:

```tsx
      {/* The shared header, not a copy (#865). The old hand-drawn strip
          predated every header feature and received none of them: no cwd,
          no color flag, no title/name row, no Status Mode fill. #851 was the
          same drift in AgentTerminalLeaf. Terminal chrome goes in via slots. */}
      <PaneHeader
        sessionId={sessionId}
        paneLabel={paneLabel}
        agentTitle={title}
        // runtime.projectDir is always undefined for shells (main emits
        // started without one). The live tmux cwd follows `cd`; the spawn
        // cwd is the fallback for direct PTYs and before the first sample.
        projectDir={liveCwd ?? spawnCwd}
        statusMode={showStatusMode}
        isSessionLive={isSessionLive}
        badge={
          <span className={`flex-shrink-0 ${statusLit ? '' : 'text-ink'}`}>
            {foregroundCommand ?? 'terminal'}
          </span>
        }
        trailing={tailActive ? (
          <span className={`text-[10px] font-code uppercase tracking-wider ${statusLit ? '' : 'text-accent'}`}>
            TAIL
          </span>
        ) : null}
      />
```

In `TileTree.tsx`, in the `if (kind === 'terminal')` branch, add `showStatusMode={showStatusMode}` to `<TerminalLeaf …>`. Note that the branch must keep using the physical `sessionId`: terminals are never related-agent owners.

In the two existing TerminalLeaf renderer tests, add `showStatusMode={false}` to every `<TerminalLeaf …>` render.

- [ ] **Step 5: Un-gate the follow commands**

In `paneCommands.ts`, set the `toggle-tail` `when` to:

```ts
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      // Every session follows (#865): agents through the feed or the raw
      // terminal view, plain shells through the same xterm follow hook.
      return sessionId !== null && Boolean(workspace.state.sessions[sessionId])
    },
```

Set the `jump-latest-message` `when` to the same body. In its description, replace `Agent panes only.` with `Works in agent feeds, raw agent terminal views and plain terminals.`.

In the `toggle-tail-all` description, replace `Plain shell terminals are never affected; raw agent terminal views follow too.` with `Plain terminals and raw agent terminal views follow too.`.

If `DEFAULT_PROVIDER` becomes unused in `paneCommands.ts`, remove it from the import. `tsc` will say.

- [ ] **Step 6: Run the tests to verify they pass**

Run: the Step 3 command plus
`NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/tile-tree/TerminalLeaf.retention.renderer.test.tsx src/renderer/src/workspace/tile-tree/TerminalLeaf.dictationOwnership.renderer.test.tsx src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/workspace/tile-tree src/renderer/src/features/workspace/commands/paneCommands.ts \
  src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts
git commit -m "feat(workspace): give plain terminals the shared pane header and auto-follow

TerminalLeaf hand-drew a 'terminal $' strip that predated every header feature,
so shells had no folder, color flag, title/name row or Status Mode fill, the
same drift #851 fixed for agent terminal views. It now renders PaneHeader with
the foreground command as its badge and the live tmux cwd, carries
data-pane-id, and follows output through the shared xterm follow hook, which
un-gates Auto-follow and Jump to Latest for shells.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 6: One display-title rule, and Dispatch treats a shell row like any other

**Files:**
- Create: `src/renderer/src/workspace/sessionDisplayTitle.ts`
- Create: `src/renderer/src/workspace/sessionDisplayTitle.test.ts`
- Modify: `src/renderer/src/features/workspace/lib/sessionDisplay.ts`: `cwdBasename` now re-exports from the new module.
- Modify: `src/renderer/src/workspace/dispatch/rowTitle.ts`: `dispatchRowTitle` gains `liveCwd`.
- Create: `src/renderer/src/workspace/dispatch/rowTitle.test.ts`
- Modify: `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`:
  - `:390` pass `liveCwd`;
  - `:401-407` unread for terminals;
  - `dispatchSubtitle` at `~:508-526` gets the command.
- Modify: `src/renderer/src/workspace/dispatch/DispatchMiniList.tsx:126` (pass `liveCwd`)
- Modify: `src/renderer/src/workspace/control.ts:76-77` (`displayedTitle`)
- Modify: `src/renderer/src/workspace/closeConfirmation.ts`: `snapshot()` title at `~:292`; `CloseExpansionState` gains `cwd`.
- Modify: `src/renderer/src/workspace/hook/actions/pane.ts:2164` (buried-kill confirmation title)
- Modify: `src/renderer/src/features/workspace/ui/CloseConfirmationDialog.tsx:51` (copy)
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx:~477-486` (buried picker label)
- Test: `src/renderer/src/workspace/closeConfirmation.test.ts`

**Interfaces:**
- Produces: `sessionDisplayTitle(meta: { title?: string; cwd: string }, liveCwd?: string | null): string` and `cwdBasename(cwd: string): string`, both from `@renderer/workspace/sessionDisplayTitle`.
- Produces: `dispatchRowTitle(row, entries?, liveCwd?: string | null)`.
- Consumed by Tasks 7, 8 and 9: the pin modal, label target and Agent Status title use `sessionDisplayTitle`.

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/workspace/sessionDisplayTitle.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { cwdBasename, sessionDisplayTitle } from './sessionDisplayTitle'

// One rule for "what do we call an untitled session" (#865). Before this, a
// dozen copies disagreed: folder name here, raw session UUID in the close
// dialog, `kind · folder` in the buried picker.
describe('sessionDisplayTitle', () => {
  it('prefers the explicit title, then the live folder, then the spawn folder', () => {
    expect(sessionDisplayTitle({ title: ' Review ', cwd: '/work/api' }, '/work/web')).toBe('Review')
    expect(sessionDisplayTitle({ cwd: '/work/api' }, '/work/web')).toBe('web')
    expect(sessionDisplayTitle({ cwd: '/work/api/' })).toBe('api')
  })

  it('falls back to the raw cwd when there is no folder segment', () => {
    expect(sessionDisplayTitle({ cwd: '/' })).toBe('/')
    expect(cwdBasename('')).toBe('')
  })
})
```

`src/renderer/src/workspace/dispatch/rowTitle.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { dispatchRowTitle } from './rowTitle'

describe('dispatchRowTitle', () => {
  it('lets a shell row follow the live folder while an explicit title still wins (#865)', () => {
    const shell = { kind: 'terminal' as const, title: 'api', agentTitle: undefined }
    expect(dispatchRowTitle(shell, undefined, '/work/web')).toBe('web')
    expect(dispatchRowTitle(shell, undefined, null)).toBe('api')
    expect(dispatchRowTitle({ ...shell, agentTitle: 'dev server' }, undefined, '/work/web')).toBe('dev server')
  })
})
```

In `closeConfirmation.test.ts`, add (importing `expandSessionCloseTargets` if the file doesn't already):

```ts
it('names an untitled session by its folder, never by its raw id (#865)', () => {
  // The dialog used to read "8f3a…-… is still working." for any untitled
  // session. Terminals reach it now that a busy shell counts as working.
  const targets = expandSessionCloseTargets(
    { sessions: { shell: { cwd: '/work/api', kind: 'terminal' } } },
    { shell: { sessionStatus: 'running' } },
    'shell',
  )
  expect(targets).toEqual([{ sessionId: 'shell', title: 'api', live: true }])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/sessionDisplayTitle.test.ts src/renderer/src/workspace/dispatch/rowTitle.test.ts src/renderer/src/workspace/closeConfirmation.test.ts`
Expected: FAIL. The module is missing, the row title ignores `liveCwd`, and the close title is `'shell'`.

- [ ] **Step 3: Implement**

`src/renderer/src/workspace/sessionDisplayTitle.ts`:

```ts
import type { SessionMeta } from '@renderer/workspace/types'

// The one rule for naming a session that has no explicit title (#865).
//
// WHY it lives in workspace/ and not features/: pane labels, Dispatch, the
// close confirmation and control observation are all workspace-layer readers,
// and they must agree. Copies disagreed before this module: folder name in
// most lists, the raw session UUID in the close dialog, `kind · folder` in the
// buried picker. Dispatch layers its latest-prompt fallback for agents on top
// of this; it does not replace it.

export function cwdBasename(cwd: string): string {
  if (!cwd) return ''
  // Trim trailing slashes so `/foo/bar/` doesn't yield an empty basename.
  const trimmed = cwd.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? trimmed
}

/**
 * Explicit title → live folder (terminals, from tmux; follows `cd`) → spawn
 * folder → raw cwd. Never returns the session id: an id is not a name a user
 * can recognize, and the close dialog showing one was the bug this replaced.
 */
export function sessionDisplayTitle(
  meta: Pick<SessionMeta, 'title' | 'cwd'>,
  liveCwd?: string | null,
): string {
  return meta.title?.trim()
    || (liveCwd ? cwdBasename(liveCwd) : '')
    || cwdBasename(meta.cwd)
    || meta.cwd
}
```

In `features/workspace/lib/sessionDisplay.ts`, replace the whole `cwdBasename` function with:

```ts
// Moved to the workspace layer with the shared title rule (#865); re-exported so
// the activity, prompt-search and bulk-switch modals keep their import.
export { cwdBasename } from '@renderer/workspace/sessionDisplayTitle'
```

In `rowTitle.ts`, replace `dispatchRowTitle` with:

```ts
export function dispatchRowTitle(
  row: Pick<DispatchAgentRow, 'agentTitle' | 'kind' | 'title'>,
  entries?: Entry[],
  // Live terminal cwd from main's foreground monitor (#865). Lets a shell row
  // follow `cd` the way an agent row follows its latest prompt.
  liveCwd?: string | null,
): string {
  if (row.agentTitle) return row.agentTitle
  if (row.kind !== 'terminal' && entries) {
    return cachedLatestPromptTitle(entries, row.kind) ?? row.title
  }
  if (row.kind === 'terminal' && liveCwd) return cwdBasename(liveCwd) || row.title
  return row.title
}
```

Add `import { cwdBasename } from '@renderer/workspace/sessionDisplayTitle'` to `rowTitle.ts`.

`DispatchAgentList.tsx`:
- Change `:390` to `const title = dispatchRowTitle(row, runtime.entries, runtime.terminalForeground?.cwd)`.
- Replace the `unreadKind` expression (`:401-407`) with the following, then remove `isTerminal` if tsc reports it unused:

```ts
  // Terminals get NEW and ERROR like every row (#865). NEW used to be hidden
  // because shells had no "finished" signal, which also hid a failed wake's
  // ERROR. The foreground monitor now marks a finished command unread.
  const unreadKind = attentionLabel
    ? 'attention'
    : runtime.unreadKind === 'attention'
      ? 'output'
      : runtime.unreadKind
```

- In `dispatchSubtitle`, add `activityStatus?: string | null` to the runtime parameter's object type. In the terminal branch, replace `if (runtime.sessionStatus === 'running') return 'shell running'` with:

```ts
    // The foreground command, e.g. `shell running · npm` (#865). Before the
    // monitor this branch could never be reached: shells were never running.
    if (runtime.sessionStatus === 'running') {
      return runtime.activityStatus ? `shell running · ${runtime.activityStatus}` : 'shell running'
    }
```

`DispatchMiniList.tsx:126`: `const title = dispatchRowTitle(row, runtime.entries, runtime.terminalForeground?.cwd)`.

`workspace/control.ts:76-77`:

```ts
    const runtime = store.workspaceRuntimes[sessionId]
    const displayedTitle = row
      ? dispatchRowTitle(row, runtime?.entries, runtime?.terminalForeground?.cwd)
      : sessionDisplayTitle(meta, runtime?.terminalForeground?.cwd)
```

Also import `sessionDisplayTitle` there.

`closeConfirmation.ts`:
- Widen the session shape in `CloseExpansionState` to `{ title?: string; cwd?: string; kind?: string; linkedParentId?: string }`.
- In `snapshot()`, replace `title: state.sessions[sessionId]?.title ?? sessionId` with:

```ts
    // Folder, not the session UUID, for untitled sessions (#865): shells
    // reach this dialog now that a running job counts as working.
    title: (() => {
      const meta = state.sessions[sessionId]
      return meta?.cwd !== undefined ? sessionDisplayTitle({ title: meta.title, cwd: meta.cwd }) : (meta?.title ?? sessionId)
    })(),
```

Also import `sessionDisplayTitle`.

`pane.ts:2164`: replace `title: snapshot.sessions[entry.sessionId]?.title ?? entry.sessionId` with `title: sessionDisplayTitle(entry.sessionMeta)`. A buried entry always carries its `sessionMeta`, including after the session left `sessions`. Import `sessionDisplayTitle`.

`CloseConfirmationDialog.tsx:51`: replace `'Close a working agent?'` with `'Close a working session?'`. A shell running a job reaches this dialog now.

`CommandPalette.tsx` buried picker: replace the `label` line and the `cwdBase` computation it uses with:

```ts
          return {
            id: entry.id,
            // Same title rule as every other list (#865), kind as context.
            label: `${sessionDisplayTitle(entry.sessionMeta)} · ${kind}`,
```

Import `sessionDisplayTitle` and delete the now-unused `cwdBase` local.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command plus
`NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx`. That file renders `DispatchAgentList`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/sessionDisplayTitle.ts src/renderer/src/workspace/sessionDisplayTitle.test.ts \
  src/renderer/src/features/workspace/lib/sessionDisplay.ts src/renderer/src/workspace/dispatch \
  src/renderer/src/workspace/control.ts src/renderer/src/workspace/closeConfirmation.ts \
  src/renderer/src/workspace/closeConfirmation.test.ts src/renderer/src/workspace/hook/actions/pane.ts \
  src/renderer/src/features/workspace/ui/CloseConfirmationDialog.tsx \
  src/renderer/src/features/command-palette/ui/CommandPalette.tsx
git commit -m "fix(workspace): name untitled sessions by folder everywhere, shells included

A dozen title fallbacks disagreed. The close dialog showed a raw session UUID
for any untitled session, and the buried picker showed 'kind · folder'. One
sessionDisplayTitle rule now covers them, a terminal's Dispatch row follows the
live tmux cwd, and shell rows show NEW, ERROR and the running command like any
other row.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 7: Pin terminals

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/dispatch.ts`:
  - the header comment at `:625-633`;
  - `pinSession` at `:640`;
  - `setPinnedSessionIds` at `~:673`.
- Modify: `src/renderer/src/workspace/dispatch/dispatchSelectors.ts:48-50` and `:253`
- Modify: `src/renderer/src/workspace/hook/invalidation/effects.ts:156-190` (pin sanity effect and its comment)
- Modify: `src/renderer/src/features/dispatch-pin/surfaces/PinAgentsSurface.tsx:~47-60`
- Modify: `src/renderer/src/workspace/types.ts:~533-537` (`pinnedSessionIds` doc)
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts`: the `pin-agents` / `unpin-agent` titles and descriptions
- Test: `src/renderer/src/workspace/dispatch/dispatchSelectors.test.ts`

**Interfaces:**
- Produces: `pinnedSessionIds` may hold any existing session id. The invariant is now just "every pinned id is in `sessions`".
- Operator `agents.pinSet` is un-gated in Task 10.

- [ ] **Step 1: Write the failing test**

In `dispatchSelectors.test.ts`, add `buildPinnedDispatchRows` to the import from `@renderer/workspace/dispatch/dispatchSelectors`, and add:

```ts
describe('buildPinnedDispatchRows', () => {
  it('pins a terminal like any other session (#865)', () => {
    // Pins were agent-only since before terminals were Dispatch rows (#152
    // deferred them "for v1"). Since #671 a shell is a full row, and a pinned
    // dev-server shell is exactly the one-keystroke-away session pins exist for.
    const state = makeState({ scope: 'global', focusedSessionId: 'a1' })
    state.sessions.shell = { cwd: '/work/project-a', kind: 'terminal' }
    state.tabs[0] = { ...state.tabs[0], root: { type: 'split', direction: 'vertical', ratio: 0.5, a: leaf('a1'), b: leaf('shell') } }
    state.pinnedSessionIds = ['shell']
    expect(buildPinnedDispatchRows(state).map(row => [row.sessionId, row.kind])).toEqual([['shell', 'terminal']])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/dispatch/dispatchSelectors.test.ts`
Expected: FAIL. The terminal is skipped, so the result is `[]`.

- [ ] **Step 3: Implement**

`dispatch.ts`:
- Rewrite the first paragraph of the pin-reducers header comment to:

```ts
  // Pin reducers. Three callbacks share the same invariant:
  //   pinnedSessionIds[i] -> state.sessions[id] exists. Any session kind can be
  //   pinned (#865); terminals were excluded until shells became full Dispatch
  //   rows (#671) made that exclusion a leftover of the #152 v1 scope.
```

- `pinSession`: `if (!meta || meta.kind === 'terminal') return prev` → `if (!prev.sessions[sessionId]) return prev`, and remove the now-unused `meta` local.
- `setPinnedSessionIds`: replace the filter body with `return prev.sessions[id] !== undefined`.

`dispatchSelectors.ts`:
- `:48-50`: `const pinnedSet = new Set(state.pinnedSessionIds.filter(id => state.sessions[id] !== undefined))`
- `:253`: `if (!meta) continue`

`effects.ts`:
- In the invariant comment, replace `"after any setState, pinnedSessionIds is a subset of Object.keys(sessions) (minus terminals)."` with `"after any setState, pinnedSessionIds is a subset of Object.keys(sessions)." Terminals are pinnable since #865.`
- In both filter callbacks, replace `meta !== undefined && meta.kind !== 'terminal'` with `meta !== undefined`.
- Delete the `// Terminals can never be pinned. …` comment and keep only the missing-session rationale.

`PinAgentsSurface.tsx`:
- Change `if (!meta || meta.kind === 'terminal') return` to `if (!meta) return`.
- Replace the inlined title expression and its comment with `title: sessionDisplayTitle(meta),` (import from `@renderer/workspace/sessionDisplayTitle`), under the comment `// The shared title rule (#865), no longer an inlined copy of the selector's.`.

`types.ts`: replace the paragraph `Terminals are never pinned: …` in the `pinnedSessionIds` doc with `Any session kind can be pinned, terminals included (#865).`.

`paneCommands.ts`:
- `pin-agents`: title `'Pin Sessions…'`; description `…which **Dispatch** agents and terminals stay pinned…`; add `'terminal'` to keywords.
- `unpin-agent`: title `'Unpin Session'`.
- Ids unchanged, per the Global Constraints.

- [ ] **Step 4: Run the test to verify it passes**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/hook/actions/dispatch.ts src/renderer/src/workspace/dispatch/dispatchSelectors.ts \
  src/renderer/src/workspace/dispatch/dispatchSelectors.test.ts src/renderer/src/workspace/hook/invalidation/effects.ts \
  src/renderer/src/features/dispatch-pin/surfaces/PinAgentsSurface.tsx src/renderer/src/workspace/types.ts \
  src/renderer/src/features/workspace/commands/paneCommands.ts
git commit -m "feat(dispatch): allow pinning terminals

Pins excluded terminals at seven layers, a scope decision from before shells
were Dispatch rows at all. Since #671 a terminal is a full row, and a pinned
dev-server shell is the one-keystroke-away session pins exist for. The
invariant shrinks to every pinned id is a live session; command ids stay stable.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 8: Jump to a terminal by its pane label

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/paneLabels.ts:41-49` (`AgentPaneLabelTarget.kind`) and `:131-160` (`buildAgentPaneLabelTarget`)
- Modify: `src/renderer/src/workspace/agentIndexNavigation.ts:~59-62` (`navigateToAgentIndexTarget` guard)
- Test: `src/renderer/src/workspace/tile-tree/paneLabels.test.ts`
- Test: `src/renderer/src/workspace/agentIndexNavigation.test.ts`

**Interfaces:**
- Produces: `AgentPaneLabelTarget.kind: SessionKind`, widened from `AgentProviderKind`. The type keeps its name, because renaming it would churn four modules for no behavior change. `agentIndexCommand.ts` renders `value(target.kind)`, which reads `terminal` for a shell.
- Produces: `resolveAgentPaneLabel(state, label)` and `navigateToAgentIndexTarget(...)` accept terminal targets. `workspace.focusAgentBySessionId`, used by `agents.show` in Task 10, inherits this.

- [ ] **Step 1: Write the failing tests**

In `paneLabels.test.ts`:

1. Replace `it('rejects terminals, incomplete labels, zero indexes, and stale coordinates', …)` with:

```ts
  it('resolves a terminal by its own label (#865)', () => {
    // #546 made labels agent-only; a shell kept its coordinate but could not be
    // jumped to, while Dispatch ⌘N and ⌥↑/↓ already selected it. One rule now.
    expect(resolveAgentPaneLabel(makeState(), 'A1')).toMatchObject({
      label: 'A1',
      sessionId: 'terminal',
      kind: 'terminal',
      title: 'alpha',
    })
  })

  it('rejects incomplete labels, zero indexes, and stale coordinates', () => {
    const state = makeState()
    expect(resolveAgentPaneLabel(state, 'A')).toBeNull()
    expect(resolveAgentPaneLabel(state, '2')).toBeNull()
    expect(resolveAgentPaneLabel(state, 'A0')).toBeNull()
    expect(resolveAgentPaneLabel(state, 'Z9')).toBeNull()
  })
```

2. In `it('resolves the exact globally numbered labels rendered by Dispatch', …)`, replace everything from `const agentRows = …` to the end of the loop with:

```ts
    // Every visible row resolves to itself, terminals included (#865).
    const rows = buildVisibleDispatchRows(state)
    expect(rows.some(row => row.kind === 'terminal')).toBe(true)
    for (const row of rows) {
      expect(resolveAgentPaneLabel(state, row.label)?.sessionId).toBe(row.sessionId)
    }
```

In `agentIndexNavigation.test.ts`, add the following, importing `resolveAgentPaneLabel` from `@renderer/workspace/tile-tree/paneLabels` and `WorkspaceState` if they are not already imported:

```ts
it('focuses a grid terminal through the same navigation as an agent (#865)', () => {
  const state: WorkspaceState = {
    tabs: [{
      id: 'tab', title: 'project',
      root: { type: 'split', direction: 'vertical', ratio: 0.5, a: { type: 'leaf', sessionId: 'agent' }, b: { type: 'leaf', sessionId: 'shell' } },
      focusedSessionId: 'agent',
    }],
    activeTabId: 'tab', dispatchMode: null, gridRelatedSelections: {},
    sessions: { agent: { cwd: '/w', kind: 'claude' }, shell: { cwd: '/w', kind: 'terminal' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [],
  }
  const target = resolveAgentPaneLabel(state, 'A2')
  expect(target?.sessionId).toBe('shell')
  const result = navigateToAgentIndexTarget(state, null, target!)
  expect(result?.kind).toBe('focus-grid-pane')
  expect(result?.state.tabs[0].focusedSessionId).toBe('shell')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/tile-tree/paneLabels.test.ts src/renderer/src/workspace/agentIndexNavigation.test.ts`
Expected: FAIL. The terminal label resolves to `null`.

- [ ] **Step 3: Implement**

`paneLabels.ts`:
- `AgentPaneLabelTarget.kind: SessionKind`. Import `SessionKind` from `@shared/types/providerKind` as a type.
- In `buildAgentPaneLabelTarget`, delete the `if (!isAgentProviderKind(kind)) return null` line and its comment. Replace them with:

```ts
  // Any session kind is navigable by label (#865). #546 scoped this to agents
  // "instead of becoming a hidden second terminal-navigation feature", but
  // Dispatch ⌘N and ⌥↑/↓ already selected terminals, so the two paths disagreed.
```

- Set `title: sessionDisplayTitle(meta),` (import it) and drop the local `cwdParts`.
- Remove `isAgentProviderKind` from the imports if unused.

`agentIndexNavigation.ts`: change `if (!meta || !isAgentProviderKind(kind)) return null` to `if (!meta) return null`, and remove the unused `kind` / `DEFAULT_PROVIDER` / `isAgentProviderKind` bindings. `tsc` confirms.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, plus `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/hook/actions/agentIndexNavigation.renderer.test.tsx src/renderer/src/features/command-palette/lib/agentIndexCommand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/paneLabels.ts src/renderer/src/workspace/tile-tree/paneLabels.test.ts \
  src/renderer/src/workspace/agentIndexNavigation.ts src/renderer/src/workspace/agentIndexNavigation.test.ts
git commit -m "feat(workspace): jump to terminals by pane label

Typing a terminal's label fell through to ordinary command search while
Dispatch keyboard navigation already selected terminals, so the two ways of
reaching a pane disagreed. Label resolution and index navigation now accept
every session kind.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 9: Terminals in Close Old Agents, the Activity modal, Agent Status and Worktrees

**Files:**
- Modify: `src/renderer/src/features/workspace/ui/CloseOldAgentsModal.tsx`:
  - `AgentRow.kind` at `:42`;
  - `buildAgentRows` at `:67-121`: export it, include terminals;
  - footer copy at `:655`.
- Create: `src/renderer/src/features/workspace/ui/CloseOldAgentsModal.rows.renderer.test.ts`
- Modify: `src/renderer/src/features/workspace/ui/AgentActivityModal.tsx`:
  - terminal branch at `:143-147`;
  - `buryRow` guard and comment at `:291-296`;
  - bury button guard at `:441`;
  - never-active hint at `:428`.
- Modify: `src/renderer/src/features/agent-status/commands/agentStatusCommands.ts`
- Modify: `src/renderer/src/features/agent-status/model/agentStatusModel.ts`: `AgentStatusKind`, the kind guard, conditions normalization, title.
- Modify: `src/renderer/src/features/agent-status/ui/AgentStatusPanel.tsx:46` (empty-state copy)
- Create: `src/renderer/src/features/agent-status/model/agentStatusModel.renderer.test.ts`
- Modify: `src/renderer/src/features/worktrees/lib/loadWorktreeDump.ts`: `WorktreeLiveAgent.kind` at `:12`, the guard at `:139`.
- Modify: `src/renderer/src/features/worktrees/lib/formatWorktreeDump.ts:133-136` (`providerLabel`)
- Test: `src/renderer/src/features/worktrees/lib/loadWorktreeDump.test.ts`

**Interfaces:**
- Consumes (Task 4): `runtime.terminalForeground.changedAt` as a terminal's last-active time, and `runtime.sessionStatus` as liveness.
- Consumes (Task 6): `sessionDisplayTitle`.
- Produces: `export function buildAgentRows(state, runtimes, now): AgentRow[]`. `AgentRow.kind: SessionKind`.
- Produces: `AgentStatusKind = SessionKind`. `buildAgentStatusModel` returns a model for terminals.
- Produces: `WorktreeLiveAgent.kind: SessionKind`. `providerLabel(kind: SessionKind)` returns `'Terminal'` for shells.

- [ ] **Step 1: Write the failing tests**

`CloseOldAgentsModal.rows.renderer.test.ts`:

```ts
import { expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { buildAgentRows } from './CloseOldAgentsModal'

// Close Old Agents aged sessions by transcript timestamps, which shells do not
// have, so terminals were excluded outright. The foreground monitor (#865) gives
// them an age: the last time a command started, finished or the shell cd'd.
it('ages an idle terminal from its last foreground change', () => {
  const state = {
    tabs: [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId: 'shell' }, focusedSessionId: 'shell' }],
    activeTabId: 'tab', dispatchMode: null, gridRelatedSelections: {},
    sessions: { shell: { cwd: '/work/api', kind: 'terminal' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [],
  } as unknown as Workspace['state']
  const runtimes = {
    shell: { ...emptyRuntime(), terminalForeground: { busy: false, command: 'zsh', cwd: '/work/api', changedAt: 1_000 } },
  } as Workspace['runtimes']

  expect(buildAgentRows(state, runtimes, 61_000)).toEqual([
    expect.objectContaining({ sessionId: 'shell', kind: 'terminal', lastActiveAt: 1_000, ageMs: 60_000, isLive: false }),
  ])
})
```

`agentStatusModel.renderer.test.ts`:

```ts
import { expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import { buildAgentStatusModel } from './agentStatusModel'

it('describes a terminal with the session facts that apply to it (#865)', () => {
  const state = {
    tabs: [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId: 'shell' }, focusedSessionId: 'shell' }],
    activeTabId: 'tab', dispatchMode: null, gridRelatedSelections: {},
    sessions: { shell: { cwd: '/work/api', kind: 'terminal', title: 'dev server' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: ['shell'],
  } as unknown as WorkspaceState
  const runtime = { ...emptyRuntime(), sessionStatus: 'running' as const, activityStatus: 'npm' }
  expect(buildAgentStatusModel(state, runtime, 'shell')).toMatchObject({
    kind: 'terminal',
    title: 'dev server',
    providerSessionState: 'none',
    runtime: { sessionStatus: 'running', activityStatus: 'npm', pendingCompaction: null },
    placement: { pinned: true },
    mcp: { builtInDomains: [] },
  })
})
```

In `loadWorktreeDump.test.ts`, add this inside the existing `describe('collectLiveAgentsByWorktree recorded context', …)`. It reuses the file's `status()`, `MAIN_CHECKOUT` and `LINKED_WORKTREE`:

```ts
  it('lists a shell working inside a worktree (#865)', () => {
    // A shell has no transcript, so it has no workActivity; its cwd is the
    // only evidence and is exact for where it was started.
    const worktrees = [
      status(MAIN_CHECKOUT, 'fixture/branch-1', 'main'),
      status(LINKED_WORKTREE, 'fixture/worktree-branch', 'active-unmerged'),
    ]
    const state = {
      tabs: [{ id: 'tab', title: 'Project', root: { type: 'leaf', sessionId: 'shell' }, focusedSessionId: 'shell' }],
      activeTabId: 'tab', dispatchMode: null,
      sessions: { shell: { cwd: LINKED_WORKTREE, kind: 'terminal' } },
      detachedSessions: {}, buried: [], pinnedSessionIds: [],
    } as WorkspaceState
    const workspace = {
      state,
      runtimes: { shell: { sessionStatus: 'running', streamPhase: 'idle' } as unknown as SessionRuntime },
    } as unknown as Workspace

    expect(collectLiveAgentsByWorktree(workspace, worktrees).get(LINKED_WORKTREE)).toEqual([
      expect.objectContaining({ sessionId: 'shell', kind: 'terminal', live: true }),
    ])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/workspace/ui/CloseOldAgentsModal.rows.renderer.test.ts src/renderer/src/features/agent-status/model/agentStatusModel.renderer.test.ts
NODE_ENV=test npx vitest run --project unit src/renderer/src/features/worktrees/lib/loadWorktreeDump.test.ts
```
Expected: FAIL. `buildAgentRows` is not exported, the status model is null for terminals, and the shell is absent from `liveAgents`.

- [ ] **Step 3: Implement**

`CloseOldAgentsModal.tsx`:
- `AgentRow.kind: SessionKind` (import the type).
- Export `buildAgentRows`. Add this line to its JSDoc: `Exported for its colocated test; still the one derivation the render memo and the close loop share.`
- In the loop, delete `if (!isAgentProviderKind(kind)) continue` and its comment. Replace the `lastActiveAt` computation with:

```ts
      // Every session kind can be old (#865). Agents age by transcript
      // timestamps; shells by their last foreground change (a command
      // starting/finishing or a cd), which is the only activity a shell has.
      const lastActiveAt = runtime
        ? kind === 'terminal'
          ? runtime.terminalForeground?.changedAt ?? null
          : extractLatestEntryTs(runtime.entries) ?? runtime.turnStartedAt ?? null
        : null
```

- Footer copy (`:655`): `Running agents are excluded unless explicitly included. Terminals are never included.` → `Running agents and terminals with a command in progress are excluded unless explicitly included.`

`AgentActivityModal.tsx`, terminal branch (`:143-147`):

```ts
        if (kind === 'terminal') {
          // Same liveness rule as agents via sessionStatus (#865); a shell's
          // last activity is its last foreground change.
          isLive = runtime?.sessionStatus === 'running'
          lastActiveAt = runtime?.terminalForeground?.changedAt ?? null
          statusLabel = runtime?.exited != null ? 'Exited' : isLive ? 'Active now' : 'Terminal'
          statusTone = runtime?.exited != null ? 'exited' : isLive ? 'active' : 'terminal'
        } else if (runtime) {
```

In `buryRow`, delete the guard `if (row.kind === 'terminal') return`. Replace its comment with:

```ts
      // Any session can be buried (#865). Bury keeps the process alive, and a
      // terminal revives by re-attaching its tmux session. The old comment
      // ("no notion of a resumable conversation") confused bury with resume.
```

- Change the bury button guard `{row.kind !== 'terminal' && (` to render unconditionally: remove the condition and its closing `)}`.
- Change the never-active hint at `:428` from `row.lastActiveAt == null && row.kind !== 'terminal' && !row.isLive` to `row.lastActiveAt == null && !row.isLive`.

`agentStatusCommands.ts`: replace `focusedAgentSessionId` with

```ts
// Every session kind has a status worth inspecting (#865): identity, placement,
// process state and activity apply to shells; MCP/transcript rows read "none".
function focusedSessionId(ctx: CommandContext): string | null {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return null
  return ctx.workspace.state.sessions[sessionId] ? sessionId : null
}
```

Then update `when` to use it, drop the provider-kind import, and change the description's `for the focused Claude or Codex agent` to `for the focused agent or terminal`. The title `Agent Status` stays; it is the panel's name.

`agentStatusModel.ts`:
- `export type AgentStatusKind = SessionKind`. Import `SessionKind` from `@shared/types/providerKind`; `SessionKind` is also exported from `@renderer/workspace/types`, so keep whichever import the file already has.
- Delete `if (!isAgentKind(kind)) return null`, plus the `isAgentKind` helper if it has no other use.
- Replace the `normalizeConditions` line with:

```ts
  // Provider capability lookups throw for 'terminal' (it is not a registry
  // kind); a shell has no provider conditions to normalize anyway.
  const normalizeConditions = isAgentProviderKind(kind)
    ? getRendererProviderCapabilities(kind).normalizeConditions
    : undefined
```

- Set `title: sessionDisplayTitle(meta),` (import it) instead of `meta.title?.trim() || basename(meta.cwd)`. Delete the local `basename` helper if nothing else uses it.

`AgentStatusPanel.tsx:46`: `'No focused agent'` → `'No focused session'`.

`loadWorktreeDump.ts`:
- `WorktreeLiveAgent.kind: SessionKind`.
- Delete `if (!isAgentProviderKind(kind)) continue`. Replace its comment with:

```ts
      // Every session kind occupies a worktree (#865): a shell running a dev
      // server in one is using it as much as an agent is. Shells fall back to
      // their cwd below (no transcript-derived workActivity), which is exact
      // for where they were started.
```

`formatWorktreeDump.ts`:

```ts
export function providerLabel(kind: SessionKind): string {
  // Registry-derived for agents (#394 phase 2c-2); terminal is the one
  // non-registry session kind and keeps its literal (#865).
  if (!isAgentProviderKind(kind)) return 'Terminal'
  return getRendererProviderCapabilities(kind).shortLabel
}
```

Import `isAgentProviderKind` and `SessionKind` as needed. `WorktreesBar.tsx` already routes through this `providerLabel`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the two commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/workspace/ui/CloseOldAgentsModal.tsx \
  src/renderer/src/features/workspace/ui/CloseOldAgentsModal.rows.renderer.test.ts \
  src/renderer/src/features/workspace/ui/AgentActivityModal.tsx src/renderer/src/features/agent-status \
  src/renderer/src/features/worktrees/lib/loadWorktreeDump.ts src/renderer/src/features/worktrees/lib/formatWorktreeDump.ts \
  src/renderer/src/features/worktrees/lib/loadWorktreeDump.test.ts
git commit -m "feat(workspace): include terminals in activity, status and worktree lists

Close Old Agents and the Activity modal had no age for a shell, Agent Status
refused one, the Worktrees panel ignored shells running inside a worktree, and
the Activity modal hid Bury for terminals although burying them works. Each now
treats a terminal as a session, aged by its last foreground change.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 10: The operator treats terminals as sessions, never as prompt targets

**Files:**
- Modify: `src/renderer/src/workspace/control/agents.ts`:
  - `requireSession` at `:22-29`;
  - its `false, true` call sites at `:76`, `:83`;
  - the `agents.list` filter at `:104` and descriptions;
  - `agents.prompt` at `~:218-222`;
  - `agents.titleSet` descriptions.
- Modify: `src/main/control/globalCapabilities.ts:43` (the `agents.search` filter and its description)
- Modify: `src/renderer/src/app/controlGuide.ts:88` (terminals paragraph)
- Modify: `operator-skills/agent-code-computer-execution/SKILL.md:~174-178`
- Test: `src/renderer/src/workspace/control/agents.renderer.test.ts`

**Interfaces:**
- Consumes (Tasks 1, 5, 7, 8): title, pin and navigation reducers accept terminals; `data-pane-id` exists on terminal panes.
- Produces: `requireSession(sessionId, allowBuried = false)`. The third parameter is removed, and every kind passes.
- Produces: `agents.prompt` on a terminal returns `ControlError('unavailable', 'This session is a terminal. Send text with terminals.input; agents.prompt only drives provider agents')`, **before** any wake or write.

- [ ] **Step 1: Write the failing test**

Append to `agents.renderer.test.ts`:

```ts
it('treats a terminal as a session for metadata and navigation, but never as a prompt target (#865)', async () => {
  const { invoke, deliverPrompt } = setup()
  useAppStore.getState().setWorkspaceState(state => ({
    ...state,
    sessions: { ...state.sessions, shell: { cwd: '/trial', kind: 'terminal' } },
    tabs: [{ ...state.tabs[0], root: { type: 'split', direction: 'vertical', ratio: 0.5,
      a: { type: 'leaf', sessionId: 'agent' }, b: { type: 'leaf', sessionId: 'shell' } } }],
  }))

  expect(await invoke('agents.titleSet', { sessionId: 'shell', title: 'dev server' }))
    .toMatchObject({ ok: true, value: { title: 'dev server' } })
  expect(await invoke('agents.locate', { sessionId: 'shell' }))
    .toMatchObject({ ok: true, value: { provider: 'terminal', title: 'dev server' } })
  expect(await invoke('agents.list', { query: 'dev server' }))
    .toMatchObject({ ok: true, value: { items: [expect.objectContaining({ sessionId: 'shell' })] } })

  // The refusal carries the route an operator should take instead, and it
  // happens before any wake or provider write.
  const refused = await invoke('agents.prompt', { sessionId: 'shell', prompt: 'ls' })
  expect(refused).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(JSON.stringify(refused)).toContain('terminals.input')
  expect(deliverPrompt).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/control/agents.renderer.test.ts`
Expected: FAIL. `titleSet` and `locate` answer `unavailable` for the terminal.

- [ ] **Step 3: Implement**

In `control/agents.ts`, replace `requireSession` with:

```ts
  // WHY every session kind passes (#865): locate/show/close/restore/titleSet/
  // pinSet act on metadata and placement, which a shell has exactly like an
  // agent. The single capability that must refuse a shell, agents.prompt,
  // checks provider itself because its refusal has to name the right route.
  const requireSession = (sessionId: string, allowBuried = false) => {
    const current = observe().sessions.find(session => session.sessionId === sessionId)
    if (!current) throw new ControlError('unavailable', 'Agent does not exist in this window')
    if (!allowBuried && current.placements.some(placement => placement.kind === 'buried')) {
      throw new ControlError('unavailable', 'Agent is buried; restore it explicitly before acting')
    }
    return current
  }
```

- Change the two `requireSession(sessionId, false, true)` calls (`:76`, `:83`) to `requireSession(sessionId)`.
- In `agents.list`:
  - drop `session.provider !== 'terminal' &&` from the filter;
  - change the description's `Search all agents in this window` to `Search all agents and terminals in this window`;
  - change the query `.describe` to `…Empty lists every agent and terminal in this window.`
- In `agents.prompt`, directly after `const session = requireSession(sessionId)`, add:

```ts
        // Terminals are sessions, not prompt targets (#865): provider delivery
        // needs a readiness gate and an acceptance signal a shell cannot give.
        // Point at the route that exists instead of a bare "unavailable".
        if (session.provider === 'terminal') {
          throw new ControlError('unavailable', 'This session is a terminal. Send text with terminals.input; agents.prompt only drives provider agents')
        }
```

- In `agents.titleSet`, change `title: 'Set an agent title'` to `'Set a session title'`, and change the description's `exact agent title` to `exact agent or terminal title`.

In `globalCapabilities.ts:43`, drop `session.provider !== 'terminal' &&` from the filter. In that capability's description, change `agents` to `agents and terminals` wherever it describes what is searched.

In `controlGuide.ts:88`, after `Use terminals.create/read/input for project terminals and bounded raw PTY replay.`, insert:

```
Terminals are sessions too: agents.locate/show/close/restore/list/titleSet/pinSet and agents.search accept them (provider "terminal"), but agents.prompt refuses them. Send text to a terminal, including one found by its spoken name, with terminals.input.
```

In `SKILL.md`, after the paragraph ending with `ac_terminals_input` (line `~177`), add:

```markdown
Terminals are sessions: `ac_agents_search`, locate, show, close, restore, title and
pin work on them (provider `terminal`). `ac_agents_prompt` refuses a terminal —
send text to it with `ac_terminals_input`, which appends no Enter.
```

Match the file's existing tool-name spelling. If it spells them differently than `ac_agents_*`, use its spelling.

- [ ] **Step 4: Run the test to verify it passes**

Run: the Step 2 command.
Expected: PASS, including all pre-existing cases in the file.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/control/agents.ts src/renderer/src/workspace/control/agents.renderer.test.ts \
  src/main/control/globalCapabilities.ts src/renderer/src/app/controlGuide.ts \
  operator-skills/agent-code-computer-execution/SKILL.md
git commit -m "feat(control): let the operator locate, title, pin and close terminals

The operator could create, read and write a terminal but not find, show,
title, pin, restore or close it. Session capabilities now accept every kind,
while agents.prompt refuses a terminal with the route that exists instead
(terminals.input), so a spoken shell name can never become a provider prompt.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 11: Terminal view shows which related agent it displays (#858)

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/TileTree.tsx` (the terminal-view branch of `WorkspaceLeaf`, `~:183-212`)
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`:
  - props;
  - the `badge` and `trailing` of its `PaneHeader`;
  - the #858 paragraph of the header comment.
- Create: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.related.renderer.test.tsx`

**Interfaces:**
- Produces: new optional `AgentTerminalLeaf` props:
  ```ts
  ownerSessionId?: SessionId
  relatedAgentTabs?: GridRelatedAgentTab[]
  onSelectRelatedSession?: (sessionId: SessionId) => void
  ```
- Consumes: `GridRelatedAgentTab` from `@renderer/workspace/gridRelatedAgents` (`{ sessionId, relation: 'parent' | 'linked' | 'orchestration', label, title, kind, placement }`).

- [ ] **Step 1: Write the failing test**

`AgentTerminalLeaf.related.renderer.test.tsx`. Copy the mocks, `beforeEach` and `afterEach` blocks from `AgentTerminalLeaf.statusHeader.renderer.test.tsx` lines 1-117 verbatim, then:

```tsx
describe('AgentTerminalLeaf related-agent identity (#858)', () => {
  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace
  const tabs = [{ sessionId: 'child', relation: 'orchestration' as const, label: 'worker-2', title: 'Tests', kind: 'codex' as const, placement: 'grid' as const }]

  function leaf(renderedSessionId: string, onSelect = vi.fn()) {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId={renderedSessionId}>
          <AgentTerminalLeaf
            sessionId={renderedSessionId}
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={withStatus('idle')}
            projectDir="/tmp/project"
            provider="codex"
            showStatusMode
            ownerSessionId="parent"
            relatedAgentTabs={tabs}
            onSelectRelatedSession={onSelect}
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  it('names the related agent in the status row and returns to the parent', () => {
    // The chip row is not used: every header row is taken out of the PTY,
    // so chips appearing when a child spawns would resize the live TUI. The
    // one-line status row carries the answer instead.
    const onSelect = vi.fn()
    const { container, getByRole } = render(leaf('child', onSelect))
    expect(statusRow(container)).toHaveTextContent('orchestration worker-2')
    getByRole('button', { name: 'parent' }).click()
    expect(onSelect).toHaveBeenCalledWith('parent')
  })

  it('adds nothing while the pane shows its own agent', () => {
    const { container, queryByRole } = render(leaf('parent'))
    expect(statusRow(container)).not.toHaveTextContent('worker-2')
    expect(queryByRole('button', { name: 'parent' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.related.renderer.test.tsx`
Expected: FAIL. The props are unknown, so there is no relation text and no button.

- [ ] **Step 3: Implement**

In `AgentTerminalLeaf.tsx`, add the three optional props to the `Props` type and destructure them. Before the `return (`, add:

```tsx
  // #858: WorkspaceLeaf mounts a persisted related selection here, so this pane
  // can be showing a CHILD's TUI under the PARENT's pane label. Say which one,
  // in the status row that already exists, and offer the way back. No chip row:
  // every header row is taken out of the PTY, and a row appearing when a child
  // spawns would resize the live TUI.
  const showingRelated = ownerSessionId !== undefined && ownerSessionId !== sessionId
  const relatedTab = showingRelated ? relatedAgentTabs?.find(tab => tab.sessionId === sessionId) : undefined
```

Change the `badge` to:

```tsx
        badge={
          <span className={`flex-shrink-0 ${statusLit ? '' : 'text-ink'}`}>
            raw {provider}
            {relatedTab ? ` · ${relatedTab.relation} ${relatedTab.label}` : null}
          </span>
        }
```

In `trailing`, before the TAIL pill, add:

```tsx
            {showingRelated && onSelectRelatedSession ? (
              <button
                type="button"
                // Keep xterm focused: a mousedown here must not steal it.
                onMouseDown={event => event.preventDefault()}
                onClick={event => {
                  event.stopPropagation()
                  onSelectRelatedSession(ownerSessionId!)
                }}
                className="rounded-control border border-current/30 px-1 leading-[14px] text-[9px] uppercase tracking-wider"
              >
                parent
              </button>
            ) : null}
```

In the header comment block, replace the paragraph beginning `Related-agent chips are not passed, which keeps pre-#851 behavior, but that behavior has a known hole (#858).` with:

```tsx
          Related agents (#858): the chip row is still not rendered here,
          because a row appearing when a child spawns would resize the live TUI.
          Instead the status row's badge names the displayed related agent and
          a `parent` button returns to the owner.
```

In `TileTree.tsx`, add to the `<AgentTerminalLeaf …>` props:

```tsx
          ownerSessionId={sessionId}
          relatedAgentTabs={relatedTabs}
          onSelectRelatedSession={(nextSessionId: SessionId) => {
            workspace.selectGridRelatedSession(sessionId, nextSessionId)
            workspace.focusSessionInTab(tabId, sessionId)
          }}
```

This is the same callback the rendered `LeafComponent` branch passes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command plus `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.statusHeader.renderer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx src/renderer/src/workspace/tile-tree/TileTree.tsx \
  src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.related.renderer.test.tsx
git commit -m "fix(workspace): show which related agent a terminal-view pane displays

A persisted related selection mounted a child's raw TUI under the parent's
pane label with nothing marking it, so input could go to the wrong agent. The
existing status row now names the displayed agent and offers the way back to
the parent, without adding a row that would resize the live TUI.

Fixes #858
Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 12: Small fixes found during the research

**Files:**
- Modify: `src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.tsx`:
  - `kindOptions` at `:117-126`;
  - the Dispatch commit at `:150-200`.
- Test: `src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.renderer.test.tsx`
- Create: `src/renderer/src/workspace/transcriptAvailability.ts`
- Create: `src/renderer/src/workspace/transcriptAvailability.test.ts`
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts`:
  - `copy-last-assistant` `when` at `~:584-592`;
  - `undo-clear-composer` `when` at `~:641-666`.
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.ts:78-90` (`view-prompts` `when`)
- Modify: `src/renderer/src/features/reader/commands/readerCommands.ts:15-25`
- Modify: `src/renderer/src/features/session-text-delivery/deliverTextToSession.ts`: extract `textDeliverySurface`; fix the stale comment at `:43`.
- Modify: `src/renderer/src/features/key-vault/ui/KeyVaultModal.tsx:40` (same stale comment)
- Modify: `src/renderer/src/features/prompt-templates/ui/PromptTemplateFillPane.tsx`
- Modify: `src/renderer/src/features/prompt-templates/ui/PromptTemplatePreviewPanel.tsx`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`:
  - fill pane at `~:1965`;
  - previews at `~:2394`, `~:2408`;
  - stale comment at `~:986-988`.
- Modify: `src/renderer/src/workspace/agentDisplayMode.ts:82-89` (comment)
- Create: `src/renderer/src/features/prompt-templates/ui/PromptTemplateFillPane.renderer.test.tsx`

**Interfaces:**
- Produces: `sessionHasTranscript(meta: Pick<SessionMeta, 'kind' | 'providerRuntime'> | undefined): boolean`, from `@renderer/workspace/transcriptAvailability`.
- Produces: `textDeliverySurface(workspace: Workspace, sessionId: SessionId): 'composer' | 'pty' | null`, from `deliverTextToSession.ts`. It is the same decision `deliverTextToSession` makes, exported so the UI can describe it.
- Produces: `PromptTemplateFillPane` required prop `deliverySurface: 'composer' | 'pty'`, and `PromptTemplatePreviewPanel` optional prop `deliverySurface?: 'composer' | 'pty'`.

- [ ] **Step 1: Write the failing tests**

Append to `NewAgentPlacementOverlay.renderer.test.tsx`, inside the `describe`:

```tsx
  it('offers Terminal in Dispatch and files it on the clicked project (#865)', () => {
    // The Dispatch picker filtered Terminal out ("no terminal option") from
    // before #671 made Dispatch terminals full detached rows; its commit path
    // even kept a dead terminal branch. A project-header "+" must also carry
    // its project, which the old splitFocused route could not.
    const createDetachedDispatchAgent = vi.fn(async () => undefined)
    const workspace = {
      activeTab: { id: 'tab-1', title: 'Project', focusedSessionId: 'parent', root: { type: 'leaf', sessionId: 'parent' } },
      dispatchMode: { focusedSessionId: 'parent' },
      state: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Project', focusedSessionId: 'parent', root: { type: 'leaf', sessionId: 'parent' } }],
        sessions: { parent: { cwd: '/project', kind: 'claude' } },
      },
      createDetachedDispatchAgent,
      createLinkedAgent: vi.fn(),
      splitFocused: vi.fn(),
      commitNewAgentPlacement: vi.fn(),
      attachDetachedToGrid: vi.fn(),
    } as unknown as Workspace
    const projectIntent = { tabId: 'tab-1', anchorSessionId: 'parent' }

    render(
      <NewAgentPlacementOverlay open workspace={workspace} onClose={vi.fn()}
        attachIntent={null} linkedAgentParentId={null} projectIntent={projectIntent} />,
    )
    fireEvent.click(screen.getByText('Terminal').closest('button')!)
    expect(createDetachedDispatchAgent).toHaveBeenCalledWith({ kind: 'terminal', providerRuntime: undefined }, projectIntent)
    expect(workspace.splitFocused).not.toHaveBeenCalled()
  })
```

`src/renderer/src/workspace/transcriptAvailability.test.ts`:

```ts
import { expect, it } from 'vitest'

import { sessionHasTranscript } from './transcriptAvailability'

// OpenCode Terminal is kind 'opencode' but never loads transcript entries (the
// history loaders skip providerRuntime 'terminal'), so commands that read
// entries silently did nothing there. One predicate now answers for all of them.
it('answers whether a session ever has rendered transcript entries', () => {
  expect(sessionHasTranscript({ kind: 'claude' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'opencode' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'opencode', providerRuntime: 'terminal' })).toBe(false)
  expect(sessionHasTranscript({ kind: 'terminal' })).toBe(false)
  expect(sessionHasTranscript({})).toBe(true) // legacy kind-less sessions were Claude
  expect(sessionHasTranscript(undefined)).toBe(false)
})
```

`src/renderer/src/features/prompt-templates/ui/PromptTemplateFillPane.renderer.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { PromptTemplateFillPane } from './PromptTemplateFillPane'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'

const template = {
  id: 'custom:1', title: 'Review', description: '', body: 'Review {{scope}}',
  scope: 'custom', insertMode: 'replace',
  variables: [{ name: 'scope', label: 'Scope', description: '', defaultValue: '', required: false }],
} as unknown as PromptTemplate

function pane(deliverySurface: 'composer' | 'pty') {
  return render(
    <PromptTemplateFillPane template={template} values={{}} insertMode="replace" deliverySurface={deliverySurface}
      onValueChange={vi.fn()} onInsertModeChange={vi.fn()} onCancel={vi.fn()} onInsert={vi.fn()} />,
  )
}

it('offers replace/append only where a draft exists, and says what a terminal does instead (#865)', () => {
  // On a PTY "replace" silently meant "paste at the cursor"; the pane claimed
  // it replaced the draft. Say the truth rather than offer a false choice.
  pane('pty')
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.getByText(/Pastes at the terminal cursor/)).toBeTruthy()
})

it('keeps the insert-mode choice for a composer target', () => {
  pane('composer')
  expect(screen.getAllByRole('radio')).toHaveLength(2)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.renderer.test.tsx src/renderer/src/features/prompt-templates/ui/PromptTemplateFillPane.renderer.test.tsx
NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/transcriptAvailability.test.ts
```
Expected: FAIL. There is no Terminal option in Dispatch, the predicate module is missing, and the fill pane always shows the radios.

- [ ] **Step 3: Implement**

`NewAgentPlacementOverlay.tsx`. Change the options filter so only linked mode is kind-only for agents:

```ts
  // Linked mode offers agent providers only: createLinkedAgent's signature
  // refuses 'terminal' (a shell cannot be an orchestration/linked child).
  // Dispatch offers Terminal too (#865): Dispatch terminals have been full
  // detached rows since #671, and the old "no terminal option" note predated it.
  const kindOptions = useMemo(
    () => linkedMode
      ? KIND_OPTIONS.filter((option): option is AgentProviderChoice =>
          isAgentProviderKind(option.kind),
        )
      : KIND_OPTIONS,
    [linkedMode],
  )
```

Keep `kindOnly` for the "no placement step" behavior it also controls. Only the filter changes.

In the `if (dispatchMode) {` branch of `commitKind`:
- delete the whole `if (kind === 'terminal') { … splitFocused … }` dead branch and its comment;
- delete the `if (!isAgentProviderKind(kind)) return` guard;
- keep a single call, preceded by this comment:

```ts
      // Every kind goes through the detached-Dispatch creator, terminals
      // included (#865): it accepts SessionSpawnSelection (control's
      // terminals.create already uses it for shells) and, unlike splitFocused,
      // honors projectIntent, so "+" on a project header files the shell there.
      void workspace.createDetachedDispatchAgent({ kind, providerRuntime }, projectIntent ?? undefined)
      return
```

Remove the now-unreferenced `DEAD BRANCH` comment text.

`src/renderer/src/workspace/transcriptAvailability.ts`:

```ts
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionMeta } from '@renderer/workspace/types'

/**
 * Does this session ever carry rendered transcript entries?
 *
 * WHY a shared predicate (#865): plain terminals have no transcript, and
 * OpenCode Terminal (kind 'opencode', providerRuntime 'terminal') never loads
 * one either. The history loaders (hook/actions/initialHistory.ts,
 * hook/actions/history.ts) skip it. Commands that read `runtime.entries`
 * (Copy Last Response, View Prompts, Reader) checked only `kind !== 'terminal'`
 * and so appeared on OpenCode Terminal and silently did nothing.
 */
export function sessionHasTranscript(
  meta: Pick<SessionMeta, 'kind' | 'providerRuntime'> | undefined,
): boolean {
  if (!meta) return false
  return isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER) && meta.providerRuntime !== 'terminal'
}
```

`paneCommands.ts`:
- `copy-last-assistant` `when`: replace `return workspace.state.sessions[sessionId]?.kind !== 'terminal'` with `return sessionHasTranscript(workspace.state.sessions[sessionId])`. Extend its WHY comment with: `sessionHasTranscript also excludes OpenCode Terminal, which never has entries to copy.`
- `undo-clear-composer`: add a `when`, and rewrite the `NO when guard` comment to explain that this guard reads only the session kind, never the stash:

```ts
    // Plain terminals have no composer at all; the rendered-view policy cannot
    // hide this for them because it answers "allowed" for non-agent kinds.
    // This guard reads only the session kind, never the module-level stash,
    // so the staleness concern that kept this command guard-free does not apply.
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      return sessionId !== null && workspace.state.sessions[sessionId]?.kind !== 'terminal'
    },
```

`sessionCommands.ts` `view-prompts` `when`: `return getProviderFeatures(kind).promptHistoryExtraction && sessionHasTranscript(meta)`.

`readerCommands.ts`: replace `return isAgentProviderKind(kind)` with `return sessionHasTranscript(workspace.state.sessions[sessionId])`. Append to its WHY comment: `OpenCode Terminal is excluded for the same reason: it never loads a transcript.` Drop the unused imports.

`deliverTextToSession.ts`. Extract the surface decision:

```ts
/**
 * Which surface would receive text for this session right now: the Agent Code
 * composer draft, or the PTY via a bracketed paste. Exported so the template
 * UI can describe the outcome truthfully (#865). Insert modes exist only
 * for a draft; on a PTY the text is pasted at the cursor.
 */
export function textDeliverySurface(workspace: Workspace, sessionId: SessionId): 'composer' | 'pty' | null {
  const session = workspace.state.sessions[sessionId]
  if (!session) return null
  // WHY normalize kind (review finding): legacy persisted sessions may lack
  // `kind`; an undefined kind must not silently mean "rendered".
  const kind = session.kind ?? DEFAULT_PROVIDER
  if (kind === 'terminal') return 'pty'
  return getEffectiveAgentSurfaceForSession({
    kind,
    providerRuntime: session.providerRuntime,
    globalMode: useAppStore.getState().settings.agentViewMode,
    override: session.agentViewModeOverride,
    runtime: workspace.getRuntime(sessionId),
  }) === 'rendered' ? 'composer' : 'pty'
}
```

Then rewrite the body of `deliverTextToSession` after the `isCurrent` check:

```ts
  const surface = textDeliverySurface(workspace, sessionId)
  if (surface === null) return { delivered: false, reason: 'no-session' }
  if (surface === 'composer') {
    const currentDraft = workspace.getRuntime(sessionId).draftInput
    workspace.setDraftInput(
      sessionId,
      opts?.insertMode ? applyPromptTemplateInsertMode(currentDraft, text, opts.insertMode) : currentDraft + text,
    )
    return { delivered: true, surface: 'composer' }
  }
  return deliverPtyText(workspace, sessionId, text, opts?.isCurrent)
```

Stale comment in both `deliverTextToSession.ts:43` and `KeyVaultModal.tsx:40`: replace `~/.config/agent-code/proxy, which nothing prunes or rotates.` with `~/.config/agent-code/proxy, kept until debug-storage retention prunes it (main/storage/debugRetention.ts).`

`PromptTemplateFillPane.tsx`:
- Add `deliverySurface: 'composer' | 'pty'` to `Props` and destructure it.
- Wrap the `Insert mode` label and the radio group in `deliverySurface === 'composer' ? (…) : (…)`, with this `pty` branch:

```tsx
            <div className="pt-2 text-[11px] text-muted">
              Pastes at the terminal cursor. Nothing is replaced, and nothing runs until you press Enter.
            </div>
```

`PromptTemplatePreviewPanel.tsx`: add `deliverySurface?: 'composer' | 'pty'` to its props. Where it renders `INSERT_MODE_LABEL[template.insertMode]`, render `deliverySurface === 'pty' ? 'Pastes at the terminal cursor' : INSERT_MODE_LABEL[template.insertMode]` instead.

`CommandPalette.tsx`:
- Import `textDeliverySurface`.
- Pass `deliverySurface={textDeliverySurface(workspace, promptTemplateFillState.sessionId) ?? 'composer'}` to `<PromptTemplateFillPane>`.
- For the two `<PromptTemplatePreviewPanel>` renders, compute once near the other template memos:

```ts
  const templateTargetId = promptTemplateTargetSessionId(workspace)
  const templateDeliverySurface = templateTargetId ? textDeliverySurface(workspace, templateTargetId) ?? undefined : undefined
```

  and pass `deliverySurface={templateDeliverySurface}`. Import `promptTemplateTargetSessionId` from `@renderer/features/prompt-templates/targetSession` if it is not already imported.
- Replace the stale comment at `~:986-988` with:

```ts
      // Templates are valid for every target since #830: a terminal receives
      // a bracketed paste (never Enter), so there is no dead result to hide.
```

`agentDisplayMode.ts:82-89`: in the "WHY draft input promotes Hybrid" comment, replace `Commands like Prompt Template intentionally stop at "prefill the draft, do not send";` with `Draft writers (operator templates.insert, Rewind to Prompt, restored drafts) intentionally stop at "prefill the draft, do not send". Prompt Template itself pastes into the PTY when Hybrid rests on the terminal (deliverTextToSession);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the two commands from Step 2, plus
`NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/session-text-delivery/deliverTextToSession.renderer.test.ts src/renderer/src/features/prompt-templates/control.renderer.test.tsx`
Expected: PASS. The delivery refactor must keep every existing case green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.tsx \
  src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.renderer.test.tsx \
  src/renderer/src/workspace/transcriptAvailability.ts src/renderer/src/workspace/transcriptAvailability.test.ts \
  src/renderer/src/features/workspace/commands/paneCommands.ts src/renderer/src/features/workspace/commands/sessionCommands.ts \
  src/renderer/src/features/reader/commands/readerCommands.ts \
  src/renderer/src/features/session-text-delivery/deliverTextToSession.ts src/renderer/src/features/key-vault/ui/KeyVaultModal.tsx \
  src/renderer/src/features/prompt-templates/ui src/renderer/src/features/command-palette/ui/CommandPalette.tsx \
  src/renderer/src/workspace/agentDisplayMode.ts
git commit -m "fix(workspace): close the small terminal gaps found alongside #865

Dispatch's New Agent picker could not create a terminal and its commit path
kept a dead branch that ignored the project header. Undo Clear Composer showed
on shells. Copy Last Response, View Prompts and Reader appeared on OpenCode
Terminal and silently did nothing. The template fill pane claimed replace or
append on a terminal that only ever pastes at the cursor. Stale comments about
proxy retention and template scope are corrected.

Refs #865

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 13: The phone never sees or touches a terminal (#866)

**Files:**
- Modify: `src/main/remote/SessionFeedSource.ts:214-217` (`emit`)
- Modify: `src/main/remote/RemoteServer.ts`: add a private helper, and guard `submit`, `interrupt` and `permission-reply` in `apply()` (`~:658-669`).
- Test: `src/main/remote/SessionFeedSource.test.ts`
- Test: `src/main/remote/RemoteServer.integration.test.ts`

**Interfaces:**
- No new exports. The behavior contract: no outbound remote frame names a terminal session, and inbound writes to a non-agent session are refused with `{ ok: false, error: 'not an agent session' }`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('SessionFeedSource', …)` in `SessionFeedSource.test.ts`:

```ts
  it('never forwards any frame for a terminal session, whatever the channel (#866)', () => {
    // The listing filter only ever ran on `started`; input-readiness, exit and
    // process-state still relayed terminal ids, which a client could then act on.
    const manager = makeManager()
    ;(manager.getSessionKind as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation((sessionId: string) => (sessionId === 'shell' ? 'terminal' : 'claude'))
    const source = new SessionFeedSource(manager)
    const seen: Array<[string, unknown]> = []
    source.onEvent((channel, payload) => seen.push([channel, (payload as { sessionId?: unknown }).sessionId]))

    manager.emit('input-readiness', { sessionId: 'shell', input: { ready: true } })
    manager.emit('process-state', { sessionId: 'shell', active: true })
    manager.emit('exit', { sessionId: 'shell', exitCode: 0 })
    manager.emit('input-readiness', { sessionId: 'agent', input: { ready: true } })

    expect(seen).toEqual([['input-readiness', 'agent']])
    source.dispose()
  })
```

Add next to `it('submit and interrupt write their control bytes', …)` in `RemoteServer.integration.test.ts`:

```ts
  it('refuses submit and interrupt for a terminal session (#866)', async () => {
    ;(manager.getSessionKind as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation((sessionId: string) => (sessionId === 'shell' ? 'terminal' : 'claude'))
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({ token, id: 'a', message: { type: 'submit', sessionId: 'shell' } }))
    ws.send(JSON.stringify({ token, id: 'b', message: { type: 'interrupt', sessionId: 'shell' } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    expect(manager.submitStagedPrompt).not.toHaveBeenCalled()
    expect(manager.write).not.toHaveBeenCalled()
    expect(framesOfType(frames, 'reply')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', ok: false, error: 'not an agent session' }),
      expect.objectContaining({ id: 'b', ok: false, error: 'not an agent session' }),
    ]))
    ws.close()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
NODE_ENV=test npx vitest run --project unit src/main/remote/SessionFeedSource.test.ts
NODE_ENV=test npx vitest run --project system src/main/remote/RemoteServer.integration.test.ts
```
Expected: FAIL. The terminal frames are forwarded, and `submitStagedPrompt` / `write` are called.

- [ ] **Step 3: Implement**

`SessionFeedSource.ts`, `emit`:

```ts
  private emit(channel: FeedChannel, payload: unknown): void {
    if (this.disposed) return
    // ONE gate at the choke point, not per channel (#866). The terminal filter
    // used to exist only on `started`, so every other channel (readiness, exit,
    // process-state) still relayed terminal ids, and a client could act on an
    // id it was never shown. Any future channel is covered automatically.
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId === 'string' && this.manager.getSessionKind(sessionId) === 'terminal') return
    for (const listener of [...this.listeners]) listener(channel, payload)
  }
```

`RemoteServer.ts`:
- Add `import { isAgentProviderKind } from '@shared/types/providerKind.js'`. If `SessionKind` is already imported from that module, extend the same import.
- Add a private method on the class:

```ts
  /** Inbound writes are for agent sessions only (#866). A terminal is never
   *  listed to a phone, so an inbound write to one is either stale or crafted,
   *  and pressing Enter in a shell would run whatever sits on its line. */
  private isAgentSession(sessionId: string): boolean {
    return isAgentProviderKind(this.deps.manager.getSessionKind(sessionId))
  }
```

In `apply()`:

```ts
      case 'submit': {
        if (!this.isAgentSession(msg.sessionId)) return { ok: false, error: 'not an agent session' }
        const wrote = this.deps.manager.submitStagedPrompt(msg.sessionId)
        return wrote ? { ok: true } : { ok: false, error: 'session not writable' }
      }

      case 'interrupt': {
        if (!this.isAgentSession(msg.sessionId)) return { ok: false, error: 'not an agent session' }
        const wrote = this.deps.manager.write(msg.sessionId, INTERRUPT_BYTES, 'remote')
        return wrote ? { ok: true } : { ok: false, error: 'session not writable' }
      }

      case 'permission-reply':
        if (!this.isAgentSession(msg.sessionId)) return { ok: false, error: 'not an agent session' }
        return this.applyPermissionReply(msg.sessionId, msg.action)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the two commands from Step 2.
Expected: PASS, including the existing `submit and interrupt write their control bytes` case, where the mock kind is `claude`.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote/SessionFeedSource.ts src/main/remote/SessionFeedSource.test.ts \
  src/main/remote/RemoteServer.ts src/main/remote/RemoteServer.integration.test.ts
git commit -m "fix(remote): keep terminal sessions out of every remote frame and write

The remote feed filtered terminals only on the started event, so readiness,
exit and process-state frames still carried terminal session ids, and submit
and interrupt accepted any id. A paired client could press Enter in a shell it
was never shown. The source now drops terminal frames at its single emit choke
point, and inbound writes require an agent session.

Fixes #866

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F"
```

---

### Task 14: Verification, review, and the PR

**Files:** none, apart from any fix a failure forces.

- [ ] **Step 1: Full gates on Node 24**

```bash
source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24
npm run test:contract
npm run check:keybindings
npm run typecheck
npm test
```
Expected: all exit 0.
- **A failure is a finding.** Fix it in the task's own area with a commit, and re-run only the failed command.
- **`hotkeyBinding.test.ts`** is a known pre-existing failure. If it fails, confirm the same failure on `origin/main` before treating it as unrelated.

- [ ] **Step 2: Search for leftover terminal exclusions this plan meant to remove**

```bash
git grep -n "Terminals are never\|never named\|Terminals can never be pinned\|terminal doesn't (no notion\|Plain shell terminals intentionally\|no terminal option" -- src operator-skills
git grep -n "isAgentProviderKind" -- src/renderer/src/workspace/agentNames src/renderer/src/workspace/agentTitle.ts src/renderer/src/features/workspace/commands/agentTitleCommands.ts src/renderer/src/features/agent-status/commands
```
Expected: no matches. Any match is a stale comment or a missed check; fix it.

- [ ] **Step 3: Review the whole diff**

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- src | less
```
Check:
- nothing unrelated changed;
- every removed check has an updated WHY comment;
- the command ids `agent.title.set`, `pin-agents`, `unpin-agent`, `toggle-tail` and `jump-latest-message` are unchanged;
- no `TerminalLeaf` selector returns an object, since that would re-render per chunk;
- `deliverPromptToAgent` still refuses terminals in `src/main/sessionManager.ts`.

- [ ] **Step 4: Update the issue and push**

```bash
gh auth status   # expect Juliusolsson05 active
git push -u origin feat/terminal-session-parity
```

- [ ] **Step 5: Open the PR, then stop**

Title: `feat(workspace): give terminals the same session features as agents`

The body must cover:
- **Problem:** ~40 agent checks standing in for "session" checks; the list from #865.
- **What changed,** by task.
- **Design decisions:** D1–D8, in particular the reversal of #660 / #836 / #152 and the dedicated channel.
- **Tests:** the list per task; plus why there is no SessionManager-level test (it would need a real PTY spawn) and no Activity-modal test (presentation only, with the shared rule tested through Close Old Agents).
- **Verification:** the Task 14 commands and their results.
- **Limitations:**
  - D8, including OpenCode Terminal still unlit (#857);
  - commands shorter than one second are never seen as busy;
  - a long-running dev server keeps its pane lit.
- **Needs a live check by the user:** Status Mode lights on `npm test` in a tmux terminal; a busy shell survives Cmd+R; the Dispatch shell subtitle shows the command.
- **Links:** `Fixes #865`, `Fixes #866`, `Fixes #858`, `Refs #857 #851 #853 #830 #831 #816 #660 #152`.
- Ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LEwGeHkkhnDxU3X3chXX3F
```

Then report the PR link and the gate results to the user. **Do not merge.** When the user authorizes a merge, use `gh pr merge <n> --merge`.

---

## Self-review

- **Spec coverage.** Every row of the inventory map points at a task:
  - D1 → Tasks 1, 2, 7, 8, 9, 10
  - D2 → the unchanged `deliverPromptToAgent`, the remote refusal (Task 13), and the Task 14 Step 3 check
  - D3 → Task 5
  - D4 → Tasks 3 and 4
  - D5 → Tasks 2 and 10
  - D6 → Task 6 (plus 7, 8 and 9 for the migrated copies)
  - D7 → Task 11
  - D8 → out of scope, listed in the PR limitations
- **Names are consistent across tasks:**
  - `TerminalForegroundSample` / `State` / `Event` (Task 3) are what Tasks 4 and 5 consume.
  - `terminalForeground` with `changedAt` (Task 4) is read in Tasks 5, 6 and 9.
  - `sessionDisplayTitle` (Task 6) is used in Tasks 7, 8 and 9.
  - `useTerminalFollow` (Task 5), `textDeliverySurface` and `sessionHasTranscript` (Task 12) are each defined and used within one task.
- **Placeholders.** The one deliberate "match the file's spelling" note, for SKILL.md tool names in Task 10, is a copy-convention check, not missing content. Every code step shows its code.
- **Ordering.** Task 4 depends on Task 3's types. Task 5 depends on Task 4's runtime field and on Tasks 1–2's header row. Tasks 6–13 depend only on earlier tasks. Task 14 runs last.

