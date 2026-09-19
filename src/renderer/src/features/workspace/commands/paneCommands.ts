import {
  AGENT_PROVIDER_KINDS,
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  isAgentSessionKind,
  isProcessSessionKind,
} from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { panel, toggle } from '@renderer/features/command-palette/commandState'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { submitActiveComposer } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'
import { sessionHasTranscript } from '@renderer/workspace/transcriptAvailability'
import { isWorkingAgent } from '@renderer/workspace/agentFollow'

// DELETED with the unified layout (#992) — see RETIRED_COMMAND_IDS in
// catalog.test.ts for the ledger:
//   bury-pane / revive-pane / kill-buried-pane — "hide but keep alive" is the
//     pool's default state now, so there is nothing to bury into or revive
//     from; a session not shown in a lane is simply unplaced.
//   attach-detached-to-grid / attach-all-detached-for-tab /
//   detach-to-dispatch — there is no grid to attach into or detach from;
//     showing a pool session is a lane selection.
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
    description: '**What it does:** Starts a **new agent or terminal**.\n\n**Use when:** You want another Claude, Codex, OpenCode, or shell pane.\n\n**Notes:** OpenCode and OpenCode Terminal are separate choices. In **Dispatch**, agents become detached rows.',
    keywords: ['new', 'agent', 'placement', 'claude', 'codex', 'opencode', 'terminal'],
    when: ({ workspace }) => Boolean(workspace.activeTab),
    run: ({ workspace }) => workspace.startNewAgentPlacement(),
  },
  {
    // New Agent… files a Dispatch agent under whatever project the spawn
    // resolver derives from FOCUS. With an empty lane in an unbound row that is
    // the last agent you selected, so aiming at another project meant first
    // selecting some unrelated agent in it purely to move the target, then
    // coming back to the lane (#852). This asks for the project instead. It
    // still fills the focused lane, exactly like New Agent….
    id: 'new-agent-in',
    category: 'create',
    // `dispatch`, not `app`: in the grid a project is a tab one keystroke away,
    // and a detached agent spawned from the grid lands nowhere visible — the
    // grid has no lanes to fill and Dispatch rows are not on screen.
    surface: 'workspace',
    // Title per docs/command-style.md: "New X" for creation, and the ellipsis
    // because the command asks for more input (agent, then project).
    title: 'New Agent In…',
    // The Notes used to end with a scope sentence ("In project-scoped Dispatch,
    // choosing another project switches to it"), because spawning into another
    // project blanked every other lane until you switched back. With no
    // layout-wide scope (#992) nothing blanks, so the warning went with it.
    description: '**What it does:** Starts a **new agent in a project you choose**, in the focused lane.\n\n**Use when:** You want an agent for a different project than the one you last selected, e.g. to fill an empty lane.\n\n**Notes:** Pick the agent, then the project. A row limited to certain projects only offers those.',
    keywords: ['new', 'agent', 'project', 'lane', 'fill', 'empty', 'dispatch', 'claude', 'codex', 'opencode'],
    // Same data gate as New Agent…. Tiled Tabs covers Dispatch, so the lane the
    // agent would fill is not the thing on screen.
    when: ({ workspace }) => Boolean(workspace.activeTab),
    run: ({ ui }) => ui.openNewAgentIn(),
  },
  // The split-family commands (split-vertical/-horizontal, terminal-*, the
  // per-provider pairs) were grid-spatial: "Split Pane Right", the direction
  // parameterized a tile-tree split. The tree is gone (#992), the direction
  // argument with it, and every member of the family is the same action now:
  // spawn a session (fill the focused lane if it is empty, else pool it).
  //
  // IDs AND CHORDS ARE KEPT (plan §5.4): ⌥D, ⌥⇧D, ⌥T, ⌥⇧T, ⌥C, ⌥⇧C keep
  // firing what they always fired — a user's muscle memory and any persisted
  // keybinding overrides key on the ids. Only the TITLES changed, because the
  // old ones described a direction that no longer exists; a palette row whose
  // title lies is worse than one whose id is historical.
  //
  // The "-horizontal" twins are palette-hidden ('advanced'): identical
  // behavior to their "-vertical" sibling means two visible rows would be two
  // names for one action, the exact confusion the old comment below this table
  // used to describe. They stay RUNNABLE and rebindable for the ⌥⇧ chords.
  ...[
    {
      id: 'split-vertical',
      category: 'create' as const,
      surface: 'app' as const,
      title: `New ${getRendererProviderCapabilities(DEFAULT_PROVIDER).shortLabel}`,
      description: `**What it does:** Starts a **${getRendererProviderCapabilities(DEFAULT_PROVIDER).shortLabel} agent** now, without opening a picker.\n\n**Use when:** You know which provider you want.\n\n**Notes:** Fills the focused lane when it is empty; otherwise the agent lands in the pool with a **new** badge in the index.`,
      run: ({ workspace }: CommandContext) => workspace.splitFocused(),
    },
    {
      id: 'split-horizontal',
      category: 'create' as const,
      surface: 'app' as const,
      pickerVisibility: 'advanced' as const,
      title: `New ${getRendererProviderCapabilities(DEFAULT_PROVIDER).shortLabel} (legacy id)`,
      description: '**What it does:** Same as the **-vertical** command it predates.\n\n**Notes:** Kept runnable for the ⌥⇧ chord and old bindings; hidden from the default palette because it is a duplicate.',
      run: ({ workspace }: CommandContext) => workspace.splitFocused(),
    },
  ],
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
    id: 'linked-agent',
    category: 'create',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Linked Agent…',
    description: '**What it does:** Starts a new agent linked to the currently targeted agent.\n\n**Use when:** You want a one-off helper, like a review agent, visually nested under the parent.\n\n**Notes:** The linked agent is a normal Dispatch agent. It renders directly under the parent and closes automatically when the parent closes.',
    keywords: ['linked', 'agent', 'review', 'helper', 'child', 'dispatch', 'claude', 'codex', 'opencode'],
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
    surface: 'workspace',
    title: 'Pin Sessions…',
    description: '**What it does:** Opens the multi-select Pin modal to choose which **Dispatch** agents and terminals stay pinned at the top of the agent list.\n\n**Use when:** You want a few favorite agents or terminals to always be one keystroke away regardless of project or scope.\n\n**Notes:** Space toggles, Enter commits, Esc cancels. The order you Space through the rows is the order pins render in. Pins survive project↔global scope toggles.',
    keywords: ['pin', 'pins', 'pinned', 'favorite', 'star', 'top', 'dispatch', 'terminal'],
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
    // to a pinned row, run Unpin Session." We use the same
    // commandTargetSessionId resolver the rest of this file uses
    // for dispatch-aware target picking, so the highlighted row in
    // the dispatch list IS the unpin target.
    //
    // The `when` guard is intentionally strict: only show the
    // command if the focused row is currently pinned. Showing it
    // unconditionally would lead users to "Unpin Session" on a
    // non-pinned row, which silently no-ops in the reducer — bad
    // affordance.
    id: 'unpin-agent',
    category: 'layout-dispatch',
    // `dispatch` surface carries the mode gate; `when` keeps only the
    // data condition (the focused row is currently pinned).
    surface: 'workspace',
    title: 'Unpin Session',
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
    id: 'terminal-horizontal',
    category: 'create',
    // `app`: a terminal applies everywhere the workspace runs. The id keeps
    // its historical "-horizontal" suffix (and the ⌥T chord) even though the
    // direction died with the tile tree (#992) — see the split-family note
    // above for why ids are frozen while titles stopped lying.
    surface: 'app',
    title: 'New Terminal',
    description: '**What it does:** Starts a **plain shell** in the focused lane\'s project.\n\n**Use when:** You need a scratch shell beside your agents.\n\n**Notes:** Fills the focused lane when it is empty; otherwise it lands in the pool with a **new** badge in the index.',
    run: ({ workspace }) => workspace.splitFocused('terminal'),
  },
  {
    id: 'terminal-vertical',
    category: 'create',
    surface: 'app',
    pickerVisibility: 'advanced',
    title: 'New Terminal (legacy id)',
    description: '**What it does:** Same as **New Terminal**.\n\n**Notes:** Kept runnable for the ⌥⇧T chord and old bindings; hidden from the default palette because it is a duplicate.',
    run: ({ workspace }) => workspace.splitFocused('terminal'),
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
    return [
      {
        id: `${kind}-vertical`,
        // `app` for the same reason as the generic create: one workspace, one
        // spawn flow. Id keeps its historical "-vertical" suffix (plan §5.4).
        surface: 'app' as const,
        // Same category/tier as the generic and terminal creates they sit
        // beside: creating a named-provider agent is not a more advanced act
        // than creating a default one, it just names the provider.
        category: 'create' as const,
        title: `New ${caps.shortLabel}`,
        description: `**What it does:** Starts a **${caps.shortLabel} agent** now, without opening a picker.\n\n**Use when:** You know which provider you want.\n\n**Notes:** Fills the focused lane when it is empty; otherwise the agent lands in the pool with a **new** badge in the index.`,
        run: ({ workspace }: CommandContext) =>
          workspace.splitFocused(kind),
      },
      {
        id: `${kind}-horizontal`,
        surface: 'app' as const,
        category: 'create' as const,
        pickerVisibility: 'advanced' as const,
        title: `New ${caps.shortLabel} (legacy id)`,
        description: `**What it does:** Same as **New ${caps.shortLabel}**.\n\n**Notes:** Kept runnable for the ⌥⇧ chord and old bindings; hidden from the default palette because it is a duplicate.`,
        run: ({ workspace }: CommandContext) =>
          workspace.splitFocused(kind),
      },
    ]
  }),
  // DELETED with the tile tree (#992): nav-left/right/up/down walked
  // `tab.root` grid focus, and the tree no longer renders. Lane movement
  // is ⌥←/⌥→ (focus within the row) and ⌥↑/⌥↓ (index walk), handled in
  // useKeybinds and migrated into the command registry in stage 5.
  {
    id: 'undo-close',
    category: 'session',
    surface: 'app',
    title: 'Undo Close',
    description: '**What it does:** Restores the most recent closed **pane, tab, or Dispatch row** from a small recent-close history.\n\n**Use when:** You closed something by mistake, or repeat it to walk back through earlier closes.\n\n**Notes:** A restored **Dispatch** terminal re-attaches its tmux session, so its scrollback comes back.',
    run: ({ workspace }) => workspace.undoClose(),
  },
  {
    id: 'toggle-tail',
    category: 'session',
    surface: 'session',
    title: 'Auto-follow Focused Agent',
    keywords: ['tail'],
    description: '**What it does:** Toggles **auto-follow** for the focused target.\n\n**Use when:** You want output to stay pinned to the bottom.\n\n**Notes:** Applies to the visible command target, including **Dispatch** selection. Works in both the rendered feed and raw agent terminal views — in a terminal view the TUI output stays pinned to the bottom.',
    // NO `renderedViewPolicy` — deliberately: this command owns follow
    // behavior on BOTH agent surfaces now (Feed's tailMode on the rendered
    // surface, useTerminalFollow on the raw terminal — and, since #865, on
    // plain shell terminals too). The old 'requires-rendered-feed' gate hid
    // it on terminal surfaces, where following is exactly as meaningful.
    getState: ({ workspace, flags }) => {
      const sessionId = commandTargetSessionId(workspace)
      const tailMode = sessionId
        ? workspace.getRuntime(sessionId).tailMode
        : false
      // WHY this consults Tail All: the pane's actual behavior is
      // the individual flag OR the active bulk policy (see agentFollow). Reporting the raw
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
      if (
        !tailMode && flags.tailWorkingMode && sessionId
        && isWorkingAgent(workspace.state.sessions[sessionId]?.kind, workspace.getRuntime(sessionId))
      ) {
        return toggle(true, { detail: 'On via Auto-follow All Working Agents' })
      }
      return toggle(Boolean(tailMode))
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : undefined
      // Shell and agent panes both follow; a processless extension has no output to follow.
      return Boolean(meta && isProcessSessionKind(meta.kind))
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
      '**What it does:** Toggles **auto-follow for every visible agent** at once.\n\n**Use when:** You are watching several agents work and want them all pinned to the bottom.\n\n**Notes:** Scopes to what is on screen — in **single dispatch** that is the one agent, in **tiled** every lane, in the **grid** the current tab\'s panes only. Panes you open afterward tail too, until you toggle it off. Enabling this switches off Auto-follow All Working Agents. Plain terminals and raw agent terminal views follow too.\n\n**Caution:** A tailing pane cannot be scrolled up. Turning this off leaves individually enabled followers on; other panes restore their earlier reading position where that content is still retained. Raw terminal follow controls xterm scrollback, not a TUI\'s internal history.',
    keywords: ['tail', 'all', 'follow', 'auto-scroll', 'bulk', 'every', 'watch', 'tail all', 'tail'],
    // WHY no `renderedViewPolicy` — Tail All is a stance over whatever is
    // mounted, on either agent surface (rendered feed or raw terminal view,
    // both of which follow now). Gating it on the currently focused pane's
    // view mode would hide a workspace-level command for pane-local reasons.
    // (Per-session Tail used to carry such a policy; it no longer does.)
    //
    // WHY no `when` guard: it is meaningful in every layout mode, and with zero
    // agent panes visible it is a harmless no-op rather than a command that
    // disappears from the palette for reasons the user cannot see.
    getState: ({ flags }) => toggle(flags.tailAllMode),
    run: ({ ui }) => ui.toggleTailAllMode(),
  },
  {
    id: 'toggle-tail-working',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'app',
    title: 'Auto-follow All Working Agents',
    description: '**What it does:** Keeps working agents pinned to their latest output.\n\n**Use when:** You want to watch active work while reading idle conversations freely.\n\n**Notes:** Applies automatically as agents start and stop working, in rendered feeds and raw agent terminal views. Agents waiting for your approval or an answer release follow so you can read the context. Hidden panes suspend scrolling. Plain shell terminals are excluded. Enabling this switches off Auto-follow All Visible Agents. Individually enabled followers stay on.\n\n**Caution:** A following pane cannot be scrolled up. When work ends or this mode is switched off, other panes restore their earlier reading position where retained. Raw terminal follow controls xterm scrollback, not a TUI’s internal history.',
    keywords: ['tail', 'all', 'working', 'busy', 'running', 'follow', 'auto-scroll', 'watch'],
    // This is a policy for future work too, so it stays available with no busy
    // target and on either view surface. The leaf observes activity changes;
    // the command never wakes agents or snapshots the current working set.
    getState: ({ flags }) => toggle(flags.tailWorkingMode),
    run: ({ ui }) => ui.toggleTailWorkingMode(),
  },
  {
    id: 'jump-latest-message',
    category: 'navigate',
    surface: 'session',
    title: 'Jump to Latest Message',
    description: '**What it does:** Scrolls to the **latest agent message**.\n\n**Use when:** You are far up in the feed and want to return to the bottom.\n\n**Notes:** Works in agent feeds, raw agent terminal views and plain terminals. In a raw terminal view this scrolls the xterm viewport, which works for providers that render inline (Claude, Codex). A TUI that owns its own transcript on the alternate screen (OpenCode Terminal) keeps its history outside the viewport, so there is nothing here to scroll — use that TUI\'s own scroll keys.',
    // NO `renderedViewPolicy` — the xterm viewport answers jump requests too
    // (useTerminalFollow); gating on a rendered feed would hide this on
    // the surface where returning to the bottom is most often needed.
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : undefined
      return Boolean(meta && isProcessSessionKind(meta.kind))
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
      // assistant response to copy when there is only PTY scrollback.
      // sessionHasTranscript admits OpenCode Terminal since #971 — #882 loads
      // its committed entries, so there is a real last response to copy.
      return sessionHasTranscript(workspace.state.sessions[sessionId])
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
    // Terminals and extension panes have no composer at all; the rendered-view
    // policy cannot hide this for them because it answers "allowed" for non-agent
    // kinds. Positive agent check, matching Clear Composer and Send Prompt.
    // This guard reads only the session kind, never the module-level stash,
    // so the staleness concern that kept this command guard-free does not apply.
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      return sessionId !== null && isAgentSessionKind(workspace.state.sessions[sessionId]?.kind)
    },
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

// `dispatchCommandTabId` and an attach-all resolver lived below until #992.
// They picked the project a Dispatch-only command should act on (the active
// tab in project scope, the focused row's tab in global scope). Their last
// caller — Attach All Dispatch Agents — died with the tile tree in stage 3a,
// and the scope they branched on died in 3b, so the helpers went with them.
