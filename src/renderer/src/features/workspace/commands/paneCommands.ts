import {
  AGENT_PROVIDER_KINDS,
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  isAgentSessionKind,
} from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { panel, toggle } from '@renderer/features/command-palette/commandState'
import {
  commandTargetSessionId,
  commandTargetSessionIdForState,
} from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { isDetached } from '@renderer/workspace/queries'
import {
  buildVisibleDispatchRows,
  detachedDispatchSessionIdsForTab,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveDispatchAttachTarget } from '@renderer/workspace/dispatch/dispatchTarget'
import { dispatchFocusedSessionId } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { submitActiveComposer } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'

/**
 * Buried panes visible from the CURRENT tab.
 *
 * The buried picker is deliberately tab-scoped (see the note in
 * CommandPalette's `buried` memo: a buried Codex agent from project A listed
 * beside a buried Claude agent from project B mixes contexts and invites
 * revive-into-the-wrong-tab). Admission has to use the same scope, or the row
 * appears for a tab with nothing to revive.
 */
function buriedInActiveTab(workspace: CommandContext['workspace']): number {
  const activeTabId = workspace.state.activeTabId
  return workspace.state.buried.filter(entry => entry.sourceTabId === activeTabId).length
}

export const paneCommands: CommandDef[] = [
  {
    id: 'new-agent',
    category: 'create',
    // `app`: this is the universal creation entry point. It opens the
    // placement picker, which is Dispatch-aware — in Dispatch it makes a
    // detached agent, in the grid it makes a pane. Because it adapts,
    // it is the creation command Dispatch users reach for once the
    // grid-spatial `split-*` / `codex-*` / `terminal-*` commands below
    // are surface-gated out of Dispatch.
    surface: 'app',
    title: 'New Agent…',
    description: '**What it does:** Starts a **new agent or terminal**.\n\n**Use when:** You want another Claude, Codex, or shell pane.\n\n**Notes:** In **Dispatch**, Claude/Codex become detached agents; terminals attach to the focused project grid.',
    keywords: ['new', 'agent', 'placement', 'claude', 'codex', 'terminal'],
    when: ({ workspace }) => Boolean(workspace.activeTab && !workspace.tileTabs),
    run: ({ workspace }) => workspace.startNewAgentPlacement(),
  },
  {
    // `grid` surface — applies to split-vertical, split-horizontal,
    // codex-vertical, codex-horizontal, terminal-horizontal and
    // terminal-vertical below.
    //
    // WHY hide these in Dispatch even though `splitFocused` still
    // *works* there: the title encodes a grid direction (Right / Down /
    // Below) and Dispatch has no visible grid for that direction to
    // mean anything. Worse, `splitFocused` ignores the direction in
    // Dispatch entirely (pane.ts) — it just creates a detached agent —
    // so `Split Pane Right` and `Split Pane Down` would be two palette
    // rows doing the identical thing. Dispatch users create with
    // `New Agent…` (surface `app`), which is direction-free by design.
    // Power-user keybinds (⌥D etc.) still fire in Dispatch; only the
    // misleading palette rows are gated.
    id: 'split-vertical',
    category: 'create',
    // `app`, NOT `grid`. `splitFocused` has a full Dispatch branch that spawns a
    // DETACHED agent (see the `dispatchSnapshot.dispatchMode` path), which is
    // what this command's own description promises. `grid` made
    // `surfaceAvailable` return false in Dispatch, so admission refused a mode
    // the action implements.
    //
    // That was invisible until keybinds started routing through the gateway.
    // Before, ⌥D was a hard-coded branch in useKeybinds that bypassed admission
    // entirely and fired in both modes; the surface only hid the palette row.
    // Routing the chord through admission fused "don't show this row here" with
    // "refuse to run this here" — the exact split the governance plan exists to
    // maintain — and ⌥D silently stopped working in Dispatch.
    surface: 'app',
    title: 'Split Pane Right',
    description: '**What it does:** Creates a **new agent pane on the right**.\n\n**Use when:** You want side-by-side work in the grid.\n\n**Notes:** In **Dispatch**, this creates a detached agent instead.',
    run: ({ workspace }) => workspace.splitFocused('vertical'),
  },
  {
    id: 'split-horizontal',
    category: 'create',
    surface: 'app',
    title: 'Split Pane Down',
    description: '**What it does:** Creates a **new agent pane below**.\n\n**Use when:** You want a stacked grid layout.\n\n**Notes:** In **Dispatch**, this creates a detached agent instead.',
    run: ({ workspace }) => workspace.splitFocused('horizontal'),
  },
  {
    id: 'close-pane',
    category: 'session',
    // `session`: `closeFocused` resolves its target through the
    // Dispatch-aware path, so this closes a grid pane in the grid and
    // the highlighted row in Dispatch — meaningful in both modes.
    surface: 'session',
    title: 'Close Focused Session',
    keywords: ['pane', 'close pane'],
    description: '**What it does:** Closes the **currently targeted pane or Dispatch row**.\n\n**Use when:** You are done with the current target.\n\n**Notes:** In **Dispatch**, the highlighted row is the close target.',
    run: ({ workspace }) => workspace.closeFocused(),
  },
  {
    id: 'bury-pane',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Bury Session',
    keywords: ['pane'],
    description: '**What it does:** Hides the pane but keeps the **session alive**.\n\n**Use when:** You want it out of the layout without killing it.\n\n**Notes:** Buried panes can be revived later.',
    run: ({ workspace }) => workspace.requestBuryFocused(),
  },
  {
    id: 'linked-agent',
    category: 'create',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Linked Agent…',
    description: '**What it does:** Starts a new Claude or Codex agent linked to the currently targeted agent.\n\n**Use when:** You want a one-off helper, like a review agent, visually nested under the parent.\n\n**Notes:** The linked agent is a normal Dispatch agent. It renders directly under the parent and closes automatically when the parent closes.',
    keywords: ['linked', 'agent', 'review', 'helper', 'child', 'dispatch', 'claude', 'codex'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const kind = workspace.state.sessions[sessionId]?.kind
      return isAgentProviderKind(kind)
    },
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const kind = workspace.state.sessions[sessionId]?.kind
      if (!isAgentProviderKind(kind)) return
      ui.openLinkedAgent(sessionId)
    },
  },
  {
    // Promote the dispatch-focused detached session into the active
    // tab's grid via the existing placement-target picker. Available
    // only when Dispatch Mode is active AND its current focus is on a
    // detached session (grid-focused rows in the dispatch list don't
    // need attaching — they're already attached).
    id: 'attach-detached-to-grid',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // `dispatch` surface: the old `when` opened with
    // `if (!workspace.dispatchMode) return false`. That mode check now
    // lives in the registry's surface gate, so `when` only carries the
    // data condition (the focused row is a detached session).
    surface: 'dispatch',
    title: 'Attach Detached Session to Grid…',
    description: '**What it does:** Moves one **detached Dispatch session** into the grid.\n\n**Use when:** You want to pin background work into the normal layout.\n\n**Notes:** Uses the placement picker so you can choose where it lands.',
    keywords: ['attach', 'detached', 'dispatch', 'grid', 'pin', 'place'],
    when: ({ workspace }) => {
      const target = resolveDispatchAttachTarget(workspace.state)
      if (!target) return false
      return isDetached(workspace.state, target.sessionId)
    },
    run: ({ workspace, ui }) => {
      if (!workspace.dispatchMode) return
      const target = resolveDispatchAttachTarget(workspace.state)
      if (!target) return
      if (!isDetached(workspace.state, target.sessionId)) return
      ui.openDispatchAttach(target)
    },
  },
  {
    // Dispatch-only multi-select pin command. Opens the Pin Agents
    // modal; the user picks agents with Space, commits with Enter,
    // and the resulting ordered list lands on
    // workspace.state.pinnedSessionIds. Pinned agents render in
    // their own "Pinned" section at the top of the dispatch list,
    // visible in BOTH project and global scope — the whole point of
    // pins is that they survive the scope toggle.
    //
    // We gate on dispatchMode rather than the dispatch-row count
    // because the modal handles the empty case ("No agents
    // available to pin") gracefully. Showing the command in an
    // empty workspace is fine — running it just opens a modal that
    // tells the user there's nothing to pin yet, which is more
    // discoverable than hiding the entry altogether.
    id: 'pin-agents',
    category: 'layout-dispatch',
    // `dispatch` surface replaces the old `when: Boolean(dispatchMode)`
    // guard — pins are a Dispatch-list concept and the registry gate
    // now hides this in the grid.
    surface: 'dispatch',
    title: 'Pin Agents…',
    description: '**What it does:** Opens the multi-select Pin modal to choose which **Dispatch** agents stay pinned at the top of the agent list.\n\n**Use when:** You want a few favorite agents to always be one keystroke away regardless of project or scope.\n\n**Notes:** Space toggles, Enter commits, Esc cancels. The order you Space through the rows is the order pins render in. Pins survive project↔global scope toggles.',
    keywords: ['pin', 'pins', 'pinned', 'favorite', 'star', 'top', 'dispatch'],
    getState: ({ flags }) => panel(flags.pinAgentsOpen),
    run: ({ ui, flags }) => {
      if (flags.pinAgentsOpen) {
        ui.closePinAgents()
        return
      }
      ui.openPinAgents()
    },
  },
  {
    // Quick-remove counterpart to pin-agents. Targets the currently
    // dispatch-focused row so the keyboard-driven flow is "navigate
    // to a pinned row, run Unpin Agent." We use the same
    // commandTargetSessionId resolver the rest of this file uses
    // for dispatch-aware target picking, so the highlighted row in
    // the dispatch list IS the unpin target.
    //
    // The `when` guard is intentionally strict: only show the
    // command if the focused row is currently pinned. Showing it
    // unconditionally would lead users to "Unpin Agent" on a
    // non-pinned row, which silently no-ops in the reducer — bad
    // affordance.
    id: 'unpin-agent',
    category: 'layout-dispatch',
    // `dispatch` surface carries the mode gate; `when` keeps only the
    // data condition (the focused row is currently pinned).
    surface: 'dispatch',
    title: 'Unpin Agent',
    description: '**What it does:** Removes the currently-focused **Dispatch** row from the Pinned section.\n\n**Use when:** You want to quickly drop a single pin without opening the Pin modal.\n\n**Notes:** Only appears when the focused dispatch row is currently pinned.',
    keywords: ['unpin', 'remove', 'pin', 'pinned', 'star'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return workspace.state.pinnedSessionIds.includes(sessionId)
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      workspace.unpinSession(sessionId)
    },
  },
  {
    // Available in BOTH grid and Dispatch modes. The original gate was
    // `dispatchCommandTabId`, which returned null whenever the workspace
    // was not in Dispatch — that was the wrong shape for this command.
    // Detached agents can outlive a Dispatch session (you can leave
    // Dispatch with agents still parked), and the natural recovery flow
    // is "from the regular grid, bring my parked agents back into this
    // tab." Forcing the user to flip into Dispatch first was friction
    // with no upside. In Dispatch we still delegate to the dispatch-
    // aware resolver so global Dispatch can target the focused row's
    // tab (which may differ from `activeTabId`).
    id: 'attach-all-detached-for-tab',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // `app`, NOT `dispatch`: this command deliberately works in both
    // modes (see the comment above) — detached agents outlive Dispatch,
    // and the recovery flow is "from the grid, bring my parked agents
    // back." Surface-gating it to `dispatch` would break that. Its
    // `when` already hides it when there is nothing to attach.
    surface: 'app',
    title: 'Attach All Dispatch Sessions for Tab',
    description: '**What it does:** Moves all detached **Dispatch** sessions for a tab into the grid.\n\n**Use when:** You want to bring a whole tab’s background work into view.\n\n**Notes:** Preserves the existing grid and adds the sessions beside it. Works in both Grid and Dispatch modes.',
    keywords: ['attach', 'all', 'detached', 'dispatch', 'grid', 'tab', 'pin'],
    when: ({ workspace }) => {
      const tabId = attachAllCommandTabId(workspace)
      if (!tabId) return false
      return detachedDispatchSessionIdsForTab(workspace.state, tabId).length > 0
    },
    run: ({ workspace }) => {
      const tabId = attachAllCommandTabId(workspace)
      if (!tabId) return
      return workspace.attachAllDetachedForTab(tabId)
    },
  },
  {
    // The reverse of attach: take the focused grid pane out of the
    // tile tree without killing it and add it to the dispatch
    // detached bucket. The action side refuses the only-leaf-in-tab
    // case; this `when` check gates on an actual grid leaf so the command
    // does not show for a session that is already detached.
    id: 'detach-to-dispatch',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // `session`: works in both modes against the Dispatch-aware target
    // (the `when` below requires that target to be a real grid leaf).
    surface: 'session',
    title: 'Detach Session to Dispatch',
    description: '**What it does:** Moves a grid session into **Dispatch** without killing it.\n\n**Use when:** You want to park work in the background.\n\n**Notes:** The last pane in a tab cannot be detached.',
    keywords: ['detach', 'dispatch', 'park', 'background', 'unpin'],
    when: ({ workspace }) => {
      // Use the Dispatch-aware target resolver, not tab.focusedSessionId.
      // tab.focusedSessionId has a "must be a leaf in tab.root" invariant
      // — i.e. it's grid-only. In Dispatch Mode the user has a row
      // selected, not a grid focus, and reading tab.focusedSessionId
      // silently misses that selection: the command would either gate
      // off entirely or target a stale grid leaf. The action itself
      // (`workspace.detachFocusedToDispatch`) already routes through
      // the Dispatch-aware target; this gate must agree or the palette
      // shows/hides the command for the wrong reason.
      if (!workspace.activeTab) return false
      const sessionId = commandTargetSessionIdForState(workspace.state)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const owner = workspace.state.tabs.find(tab => collectLeaves(tab.root).includes(sessionId))
      return Boolean(meta && owner)
    },
    run: ({ workspace }) => workspace.detachFocusedToDispatch(),
  },
  {
    id: 'terminal-horizontal',
    category: 'create',
    // `app`. A terminal split from Dispatch lands in a grid the user cannot see
    // immediately and the "Right" label points at nothing visible, which is why
    // this was `grid` — the intent was to hide the palette ROW while, as the
    // old comment here put it, "power-user keybinds still work because they
    // route through splitFocused".
    //
    // They stopped working. Keybinds now route through the execution gateway,
    // which applies `surfaceAvailable`, so `grid` refused ⌥T in Dispatch as well
    // as hiding it. Between a slightly odd palette row and a dead chord the user
    // has muscle memory for, the row is the cheaper cost — and `surface` is an
    // APPLICABILITY declaration, which this command genuinely satisfies in both
    // modes. Mode-conditional row hiding, if it is still wanted, needs its own
    // mechanism rather than borrowing this one.
    surface: 'app',
    title: 'New Terminal Right',
    description: '**What it does:** Opens a **terminal on the right**.\n\n**Use when:** You need a shell beside the current pane.\n\n**Notes:** From **Dispatch**, the terminal attaches to the focused row or lane’s project grid.',
    run: ({ workspace }) => workspace.splitFocused('vertical', 'terminal'),
  },
  {
    id: 'terminal-vertical',
    category: 'create',
    surface: 'app',
    title: 'New Terminal Below',
    description: '**What it does:** Opens a **terminal below**.\n\n**Use when:** You need a shell under the current pane.\n\n**Notes:** From **Dispatch**, the terminal attaches to the focused row or lane’s project grid.',
    run: ({ workspace }) => workspace.splitFocused('horizontal', 'terminal'),
  },
  // Per-provider split commands, generated for every registered agent
  // provider EXCEPT the default (#394 phase 4). The default provider
  // is what the generic split-vertical/-horizontal commands spawn, so
  // it doesn't need named variants; every additional provider gets
  // "New <Provider> Right/Below" palette entries automatically, with
  // an ⌥<key> chord when its identity descriptor declares
  // splitShortcutKey (codex: ⌥C/⌥⇧C — the ids stay `codex-vertical`
  // etc. so user keybinding overrides keyed on command ids survive).
  ...AGENT_PROVIDER_KINDS.filter(kind => kind !== DEFAULT_PROVIDER).flatMap(kind => {
    const caps = getRendererProviderCapabilities(kind)
    const chord = caps.splitShortcutKey
    return [
      {
        id: `${kind}-vertical`,
        // `app` for the same reason as split-vertical: splitFocused spawns a
        // detached agent in Dispatch, so the command applies in both modes.
        surface: 'app' as const,
        // Same category/tier as the generic and terminal splits they sit
        // beside: creating a named-provider pane is not a more advanced act
        // than creating a default one, it just names the provider.
        category: 'create' as const,
        title: `New ${caps.shortLabel} Right`,
        description: `**What it does:** Opens a **${caps.shortLabel} agent on the right**.\n\n**Use when:** You want ${caps.shortLabel} beside the current agent.\n\n**Notes:** In **Dispatch**, this creates a detached ${caps.shortLabel} agent instead.`,
        run: ({ workspace }: CommandContext) =>
          workspace.splitFocused('vertical', kind),
      },
      {
        id: `${kind}-horizontal`,
        // `app` for the same reason as split-vertical: splitFocused spawns a
        // detached agent in Dispatch, so the command applies in both modes.
        surface: 'app' as const,
        category: 'create' as const,
        title: `New ${caps.shortLabel} Below`,
        description: `**What it does:** Opens a **${caps.shortLabel} agent below**.\n\n**Use when:** You want ${caps.shortLabel} in a stacked layout.\n\n**Notes:** In **Dispatch**, this creates a detached ${caps.shortLabel} agent instead.`,
        run: ({ workspace }: CommandContext) =>
          workspace.splitFocused('horizontal', kind),
      },
    ]
  }),
  {
    // `grid` surface — applies to nav-left/right/up/down below.
    //
    // WHY this is a real fix and not just a label tidy-up: in Dispatch
    // `workspace.navigate()` walks `tab.root` grid focus, which Dispatch
    // does not drive. When the Dispatch selection is a detached session
    // it diverges from grid focus entirely and these commands were a
    // SILENT NO-OP (issue #228). Dispatch row navigation is ⌥↑/⌥↓ (and,
    // after this change, ⌥J/⌥K) — handled directly in useKeybinds.
    id: 'nav-left',
    category: 'navigate',
    commandGroup: 'navigation',
    surface: 'grid',
    title: 'Focus Pane Left',
    description: '**What it does:** Focuses the pane to the **left**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    run: ({ workspace }) => workspace.navigate('left'),
  },
  {
    id: 'nav-right',
    category: 'navigate',
    commandGroup: 'navigation',
    surface: 'grid',
    title: 'Focus Pane Right',
    description: '**What it does:** Focuses the pane to the **right**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    run: ({ workspace }) => workspace.navigate('right'),
  },
  {
    id: 'nav-up',
    category: 'navigate',
    commandGroup: 'navigation',
    surface: 'grid',
    title: 'Focus Pane Up',
    description: '**What it does:** Focuses the pane **above**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    run: ({ workspace }) => workspace.navigate('up'),
  },
  {
    id: 'nav-down',
    category: 'navigate',
    commandGroup: 'navigation',
    surface: 'grid',
    title: 'Focus Pane Down',
    description: '**What it does:** Focuses the pane **below**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    run: ({ workspace }) => workspace.navigate('down'),
  },
  {
    id: 'undo-close',
    category: 'session',
    surface: 'app',
    title: 'Undo Close',
    description: '**What it does:** Restores the most recent closed **pane or tab** from a small recent-close history.\n\n**Use when:** You closed something by mistake, or repeat it to walk back through earlier closes.\n\n**Notes:** Also restores detached **Dispatch** agents captured with a closed tab.',
    run: ({ workspace }) => workspace.undoClose(),
  },
  {
    id: 'revive-pane',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // `app`: buried panes are mode-independent state, and a revived
    // session re-enters the grid tree — which also makes it a Dispatch
    // row — so the command is meaningful from either mode.
    surface: 'app',
    title: 'Revive Buried Session…',
    keywords: ['pane'],
    description: '**What it does:** Restores a **buried live pane**.\n\n**Use when:** You parked a session and want it back.\n\n**Notes:** Opens a picker when multiple buried panes exist.',
    keepPaletteOpen: true,
    // Scoped to the ACTIVE TAB, matching the list the picker actually renders.
    //
    // This read `state.buried.length > 0` — the whole workspace — while the
    // picker filters by `sourceTabId`, so both buried commands could be
    // admitted from a tab with nothing buried and land the user on an empty
    // list. Admission has to agree with what the command will show, or the
    // command is advertising something it cannot deliver.
    when: ({ workspace }) => buriedInActiveTab(workspace) > 0,
    run: ({ ui, flags }) => {
      // Already showing this mode? Dismiss. A mode-entering command whose
      // second press re-enters the mode it is already in reads as a dead key,
      // which is the same complaint that started this whole change.
      if (flags.paletteMode === 'buried') {
        ui.closePalette()
        return
      }
      ui.enterBuriedMode()
    },
  },
  {
    id: 'kill-buried-pane',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'app',
    title: 'Kill Buried Session…',
    description: '**What it does:** Permanently kills a **buried session**.\n\n**Use when:** You no longer need hidden background work.\n\n**Notes:** This is destructive.',
    keywords: ['kill', 'buried', 'hidden', 'pane', 'session', 'pane'],
    keepPaletteOpen: true,
    when: ({ workspace }) => buriedInActiveTab(workspace) > 0,
    run: ({ ui, flags }) => {
      // Already showing this mode? Dismiss. A mode-entering command whose
      // second press re-enters the mode it is already in reads as a dead key,
      // which is the same complaint that started this whole change.
      if (flags.paletteMode === 'kill-buried') {
        ui.closePalette()
        return
      }
      ui.enterKillBuriedMode()
    },
  },
  {
    id: 'toggle-tail',
    category: 'session',
    surface: 'session',
    title: 'Auto-follow Focused Agent',
    keywords: ['tail'],
    description: '**What it does:** Toggles feed **auto-follow** for the focused target.\n\n**Use when:** You want output to stay pinned to the bottom.\n\n**Notes:** Applies to the visible command target, including **Dispatch** selection.',
    renderedViewPolicy: { kind: 'requires-rendered-feed' },
    getState: ({ workspace, flags }) => {
      const sessionId = commandTargetSessionId(workspace)
      const tailMode = sessionId
        ? workspace.getRuntime(sessionId).tailMode
        : false
      // WHY this consults Tail All: the pane's actual behavior is
      // `runtime.tailMode || tailAllMode` (see TileLeaf). Reporting the raw
      // per-session flag would print "Off" next to a pane that is visibly
      // pinned to the bottom, which reads as a broken command. The distinct
      // 'On (all)' label says the state is real but not this session's to own —
      // the toggle below still flips the session's own flag, which takes effect
      // the moment Tail All goes off.
      if (!tailMode && flags.tailAllMode) {
        // EFFECTIVE, not owned. Auto-follow is on because Tail All turned it
        // on, and invoking Tail cannot turn that off — only Tail All can. The
        // old "On (all)" label rendered through the same chip as a plain On,
        // so the user could not tell the difference and got no explanation of
        // why toggling did nothing.
        // `detail` is what actually reaches the user — it renders in the row's
        // explanation. A `truth: 'effective'` marker rode alongside it for a
        // while and was never read by any surface, so the sentence was always
        // doing the whole job.
        return toggle(true, { detail: 'On via Auto-follow All Visible Agents' })
      }
      return toggle(Boolean(tailMode))
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      // WHY tail is agent-only even though terminals are Dispatch rows:
      // tailMode controls the rendered transcript/feed scroll container.
      // Terminal panes delegate scrollback to xterm.js, and extension-view panes
      // have no feed at all, so toggling this runtime flag on either would
      // present a command that appears to work while changing nothing visible.
      return isAgentSessionKind(workspace.state.sessions[sessionId]?.kind)
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      workspace.toggleTailMode(sessionId)
    },
  },
  {
    id: 'toggle-tail-all',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // WHY 'app' and not 'session': this acts on the workspace, not on the
    // resolved command target. Same reasoning recorded for
    // `switch-agents-provider` — the user is acting across the workspace, not
    // on the focused pane.
    surface: 'app',
    title: 'Auto-follow All Visible Agents',
    description:
      '**What it does:** Toggles feed **auto-follow for every visible agent** at once.\n\n**Use when:** You are watching several agents work and want them all pinned to the bottom.\n\n**Notes:** Scopes to what is on screen — in **single dispatch** that is the one agent, in **tiled** every lane, in the **grid** the current tab\'s panes only. Panes you open afterward tail too, until you toggle it off. Terminals are never affected.\n\n**Caution:** A tailing feed cannot be scrolled up — this takes scrollback away from every visible pane at once, and turning it off does not restore where you were reading.',
    keywords: ['tail', 'all', 'follow', 'auto-scroll', 'bulk', 'every', 'watch', 'tail all', 'tail'],
    // WHY no `renderedViewPolicy` even though per-session Tail has one: that
    // gate resolves ONE target session and checks whether it renders a feed.
    // Tail All has no single target — it is a stance that applies to whatever
    // is mounted, now and later. Gating it on the currently focused pane would
    // hide a workspace-level command because of one pane's view mode.
    //
    // WHY no `when` guard: it is meaningful in every layout mode, and with zero
    // agent panes visible it is a harmless no-op rather than a command that
    // disappears from the palette for reasons the user cannot see.
    getState: ({ flags }) => toggle(flags.tailAllMode),
    run: ({ ui }) => ui.toggleTailAllMode(),
  },
  {
    id: 'jump-latest-message',
    category: 'navigate',
    surface: 'session',
    title: 'Jump to Latest Message',
    description: '**What it does:** Scrolls to the **latest agent message**.\n\n**Use when:** You are far up in the feed and want to return to the bottom.\n\n**Notes:** Agent panes only.',
    renderedViewPolicy: { kind: 'requires-rendered-feed' },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return isAgentSessionKind(workspace.state.sessions[sessionId]?.kind)
    },
    run: ({ workspace }) => {
      workspace.scrollFocusedToLatest()
    },
  },
  {
    id: 'copy-last-assistant',
    category: 'session',
    surface: 'session',
    title: 'Copy Last Response',
    description: '**What it does:** Copies the **latest assistant response**.\n\n**Use when:** You want the most recent answer quickly.\n\n**Notes:** No picker; copies immediately.',
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      // WHY hide this on non-agent panes: terminal output is not an assistant
      // transcript, and extractLastAssistantText intentionally reads provider
      // entries. Showing the command on a shell row would imply there is an
      // assistant response to copy when there is only PTY scrollback — and on an
      // extension-view pane `run` would call getRuntime() for a session that has
      // no runtime at all.
      return isAgentSessionKind(workspace.state.sessions[sessionId]?.kind)
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const runtime = workspace.getRuntime(sessionId)
      const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
      const text = extractLastAssistantText(runtime.entries, kind)
      if (text) {
        void navigator.clipboard.writeText(text)
        workspace.showPaneToast(sessionId, 'Copied to clipboard')
      }
    },
  },
  {
    id: 'clear-composer',
    // Composer commands need a composer. In hard Terminal view an agent renders
    // through AgentTerminalLeaf, which never registers a composer target at
    // all — so without this, Send Prompt was admitted and silently did nothing
    // while Clear toasted about a draft the user could not see. This is the
    // policy rewind-to-prompt already declares for the same reason: it too
    // restores text into the composer. Hybrid needs no special case — a
    // non-empty draft already promotes the pane to the rendered surface.
    renderedViewPolicy: { kind: 'opens-rendered-feed' },
    category: 'session',
    surface: 'session',
    title: 'Clear Composer',
    description:
      '**What it does:** Empties the composer draft for the focused agent.\n\n**Use when:** You typed or dictated something you want to start over from — with a mouse there is no select-all-and-delete.\n\n**Notes:** Reversible with **Undo Clear Composer**. Attached images are removed but not restored by the undo.',
    keywords: ['clear', 'composer', 'draft', 'erase', 'reset', 'prompt', 'delete'],
    // Terminals have no composer draft — their input goes straight to the PTY —
    // and extension-view panes have no composer at all, so offering this on
    // either would imply a draft that cannot exist. Same reasoning as
    // copy-last-assistant above.
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return isAgentSessionKind(workspace.state.sessions[sessionId]?.kind)
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      // Silence on a no-op is deliberate: `clearDraft` returns false when the
      // composer was already empty, and toasting "Cleared" at someone who
      // cleared nothing is noise.
      if (workspace.clearDraft(sessionId)) {
        workspace.showPaneToast(sessionId, 'Composer cleared · Undo Clear Composer to restore')
      }
    },
  },
  {
    id: 'undo-clear-composer',
    // Composer commands need a composer. In hard Terminal view an agent renders
    // through AgentTerminalLeaf, which never registers a composer target at
    // all — so without this, Send Prompt was admitted and silently did nothing
    // while Clear toasted about a draft the user could not see. This is the
    // policy rewind-to-prompt already declares for the same reason: it too
    // restores text into the composer. Hybrid needs no special case — a
    // non-empty draft already promotes the pane to the rendered surface.
    renderedViewPolicy: { kind: 'opens-rendered-feed' },
    category: 'session',
    surface: 'session',
    title: 'Undo Clear Composer',
    description:
      '**What it does:** Restores the draft removed by the last **Clear Composer** in this agent.\n\n**Use when:** You cleared the composer by mistake.\n\n**Notes:** Text only — attached images are not restored. Survives further typing, so it is still available after you start over.',
    keywords: ['undo', 'restore', 'composer', 'draft', 'clear', 'recover'],
    // NO `when` guard, matching `undo-close`: the stash lives in module state
    // that the command registry does not re-derive on, so a guard reading it
    // would go stale. `undoClearDraft` returns false when there is nothing to
    // restore and the command stays quiet.
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      if (workspace.undoClearDraft(sessionId)) {
        workspace.showPaneToast(sessionId, 'Draft restored')
      }
    },
  },
  {
    id: 'send-composer',
    // Composer commands need a composer. In hard Terminal view an agent renders
    // through AgentTerminalLeaf, which never registers a composer target at
    // all — so without this, Send Prompt was admitted and silently did nothing
    // while Clear toasted about a draft the user could not see. This is the
    // policy rewind-to-prompt already declares for the same reason: it too
    // restores text into the composer. Hybrid needs no special case — a
    // non-empty draft already promotes the pane to the rendered surface.
    renderedViewPolicy: { kind: 'opens-rendered-feed' },
    category: 'session',
    surface: 'session',
    title: 'Send Prompt',
    description:
      '**What it does:** Submits the composer draft for the focused agent, exactly as pressing Enter would.\n\n**Use when:** You are driving with a mouse, or you want the action bound to a shortcut of your own.\n\n**Notes:** Targets the same composer bare Enter would — the hovered one if the pointer is over a composer, otherwise the focused one. Does nothing when there is no submittable draft.',
    keywords: ['send', 'submit', 'prompt', 'composer', 'enter', 'go'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return isAgentSessionKind(workspace.state.sessions[sessionId]?.kind)
    },
    // Routed through the Enter registry rather than reimplemented: `submit` is
    // built from `submitCurrentDraft`, which owns provider capability dispatch,
    // the optimistic-echo rollback and the in-flight latch. A second submit
    // path is the exact class of bug that registry exists to prevent.
    run: ({ workspace }) => {
      if (submitActiveComposer()) return
      // Feedback on the no-op. Without it a mouse-first user who clicks this
      // with an empty draft — or with the pointer parked on a different, empty
      // composer — gets absolutely nothing back and cannot tell the command
      // from a dead row. Clear Composer already toasts on success; this is the
      // same courtesy for the failure it is far more likely to hit.
      const sessionId = commandTargetSessionId(workspace)
      if (sessionId) workspace.showPaneToast(sessionId, 'Nothing to send')
    },
  },
]

function dispatchCommandTabId(
  workspace: CommandContext['workspace'],
): string | null {
  if (!workspace.dispatchMode) return null
  if (workspace.dispatchMode.scope !== 'global') {
    return workspace.state.activeTabId || null
  }
  const activeTab = workspace.activeTab
  const row = selectVisibleDispatchRow(
    buildVisibleDispatchRows(workspace.state),
    // tiled-aware focus so the resolved tab follows the focused lane.
    dispatchFocusedSessionId(workspace.dispatchMode),
    activeTab?.focusedSessionId,
  )
  return row?.tabId ?? workspace.state.activeTabId ?? null
}

// Resolver for "attach all dispatch agents for tab" that works in BOTH
// modes. In Dispatch we delegate to `dispatchCommandTabId` so global
// Dispatch can target the focused row's tab (potentially != activeTabId).
// Outside Dispatch we use the active tab — there is no dispatch focus
// to consult and the user's only reasonable target is "this tab."
function attachAllCommandTabId(
  workspace: CommandContext['workspace'],
): string | null {
  if (workspace.dispatchMode) return dispatchCommandTabId(workspace)
  return workspace.state.activeTabId || null
}
