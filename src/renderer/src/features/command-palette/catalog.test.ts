import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog, findCatalogDefects } from '@renderer/features/command-palette/catalog'
import { NATIVE_MENU_COMMAND_IDS } from '@shared/commands/nativeMenuCommandIds'
import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { CommandDef } from '@renderer/features/command-palette/types'
import { RETIRED_BUILT_IN_COMMAND_IDS } from '@renderer/app-state/settings/persistence'

// ---------------------------------------------------------------------------
// Phase 0 of the command-governance plan (docs/superpowers/plans/
// 2026-07-23-command-surface-audit.md): CHARACTERIZE THE CURRENT CATALOG.
//
// This file pinned the exact 102-id before-state, then the 106-id governance
// after-state (102 - 5 retired + 9 added), then 112 with Grid Dispatch's six
// row commands (#681), 113 with New Window (#688), 114 with Clear
// Agent Composer (#683), 115 with API Key Vault (#831), 116 with
// Remove Cybersecurity Block (#848), 117 with New Agent In… (#852),
// 119 with TLDR preview and TLDR MCP (#888), 120 with Root Agent Code
// Management (#906), 121 with Use Global MCP Settings (#904), 122 with
// Merge Project Tabs (#913), 123 with View TLDR History (#917), 125 with
// Goal preview and Goal MCP (#936), 126 with Auto-follow All Working Agents (#938), 128 with
// the performance report/trace commands (#944), 129 with Close Idle Orchestration
// Agents (#960), 130 with Open Agent Analytics (#964), 132 with Goal Loop (#1001), 134
// with the two generated Grok split commands (#844), then the unified layout (#992):
// 16 retirements took it to 118, Clear Lane (stage 4) to 119 and the lane keyboard
// grammar (stage 5) to 123. (#992 was written against 130 and read 119 at the end;
// merging main added Goal Loop's two commands and the two generated Grok splits.)
// 124 with Open Setup (#995), 127 with the two generated Pi splits (#1132).
// Keeping ONE snapshot that moved — rather
// than a "baseline" file and an "after" file — is what makes the plan's
// headline count an assertion anyone can check against running code instead of
// prose.
//
// WHY a literal ordered snapshot rather than just a count: registration order
// is the palette's empty-query browse order, and users navigate that list by
// position. A count-only test passes while an import reshuffle silently moves
// every row. The plan calls order out explicitly, so the test pins order.
//
// When a later phase legitimately changes this list, the diff should be the
// reviewable artifact — update the snapshot in the SAME commit as the change,
// never as a follow-up "fix the test" commit.
// ---------------------------------------------------------------------------

/** The exact ordered catalog after governance (was 102 at main @ 670f4c2d). */
const BASELINE_COMMAND_IDS: readonly string[] = [
  // tabCommands (7)
  'new-tab',
  'close-tab',
  'next-tab',
  'prev-tab',
  'reorder-tabs',
  'merge-project-tabs',
  'resume-session',
  // windowCommands (1)
  'new-window',
  // paneCommands (34: 28 literal + 6 generated provider splits)
  'new-agent',
  // Registered directly after New Agent… so the two creation entry points sit
  // together in the empty-query browse order (#852).
  'new-agent-in',
  'split-vertical',
  'split-horizontal',
  'close-pane',
  'linked-agent',
  'pin-agents',
  'unpin-agent',
  'terminal-horizontal',
  'terminal-vertical',
  'codex-vertical',
  'codex-horizontal',
  'opencode-vertical',
  'opencode-horizontal',
  'grok-vertical',
  'grok-horizontal',
  'pi-vertical',
  'pi-horizontal',
  'undo-close',
  'toggle-tail',
  'toggle-tail-all',
  'toggle-tail-working',
  'jump-latest-message',
  'copy-last-assistant',
  'clear-composer',
  'undo-clear-composer',
  'send-composer',
  // layoutCommands (performance report/trace are ordinary app commands)
  'tiled-dispatch',
  'new-tiled-lane',
  'remove-tiled-lane',
  'clear-focused-lane',
  'dispatch-select-previous-agent',
  'dispatch-select-next-agent',
  'dispatch-focus-lane-left',
  'dispatch-focus-lane-right',
  'close-agent-remove-lane',
  'new-dispatch-row',
  'remove-dispatch-row',
  'dispatch-row-project',
  'dispatch-row-child-cap',
  'dispatch-focus-row-up',
  'dispatch-focus-row-down',
  'toggle-performance-panel',
  'save-performance-report',
  'record-performance-trace',
  'toggle-caffeinate',
  // globalEditorCommands (10)
  'toggle-global-editor',
  'save-editor-file',
  'save-all-editor-files',
  'quick-open-file',
  'search-in-files',
  'toggle-editor-fullscreen',
  'open-ai-workspace',
  'create-ai-workspace',
  'clear-ai-workspace',
  'toggle-file-tree',
  // sessionCommands (33)
  'use-global-mcp-settings',
  'view-prompts',
  'rewind-to-prompt',
  'remove-cybersecurity-block',
  'undo-rewind',
  'open-agent-activity',
  'close-old-agents',
  // Registered directly after Close Old Agents so the two cleanup commands sit
  // together in the empty-query browse order (#960).
  'close-idle-orchestration-agents',
  'switch-agents-provider',
  'search-conversation-prompts',
  'enable-built-in-mcp-ping',
  'enable-ai-workspace-mcp',
  'enable-orchestration-mcp',
  'enable-agent-transcripts-mcp',
  'enable-agent-management-mcp',
  'enable-root-agent-code-management',
  'enable-tldr-mcp',
  'enable-goal-mcp',
  'enable-goal-loop-mcp',
  'enable-workflow-mcp',
  'reload-agent',
  'soft-reload-agent',
  'set-agent-view-mode',
  'copy-resume-command',
  'duplicate-agent',
  'switch-provider',
  'toggle-git-bar',
  'toggle-debug-panel',
  'toggle-feed-debug-panel',
  'toggle-proxy-debug-panel',
  'save-debug-logs',
  'toggle-session-recording',
  'attach-recording-note',
  'toggle-rendering-debug-mode',
  'toggle-html-debug-panel',
  'clear-agent-composer',
  'toggle-dev-debug-panel',
  // agentTitleCommands (1)
  'agent.title.set',
  // dispatchColorFlagCommands (1)
  'dispatch.color-flag.set',
  // spotlight / TLDR / reader / tile-tabs (6) + goal loop (2)
  'toggle-spotlight',
  'tldr-preview',
  'goal-preview',
  'view-tldr-history',
  'goal-loop-preview',
  'goal-loop-stop',
  'toggle-reader-mode',
  // settingsCommands (4, was 5: worktree-badges + dangerous-agents retired,
  // open-keyboard-shortcuts added)
  'open-settings',
  'open-keyboard-shortcuts',
  'toggle-aggressive-debug-persistence',
  'toggle-worktrees-bar',
  // setupCommands (1, #995)
  'open-setup',
  // copy-assistant / copy-code-block (2)
  'copy-assistant-message',
  'copy-code-block',
  // prompt templates + api key vault + reply to selection (5)
  'manage-prompt-templates',
  'prompt-template',
  'save-composer-as-prompt-template',
  'api-key-vault',
  'reply-to-selection',
  // agent status / remote (2)
  'show-agent-status',
  'toggle-remote-panel',
  // usage (1, was 3: both header preferences retired)
  'usage.open',
  // agentAnalyticsCommands (1) — beside Usage, the other app-wide report (#964)
  'agent-analytics.open',
  // paletteCommands (1) — the single approved addition
  'open-command-palette',
]

/** The five durable preferences retired from Commands to Settings. Their
 *  canonical settings fields are untouched, so no value migration is needed —
 *  only the now-meaningless per-command preference entries are pruned. */
const RETIRED_COMMAND_IDS: readonly string[] = [
  // Unified layout retirements (#992): the mode toggle, mode scope, and the
  // tree-only layout/navigation commands. Their bindings (⌘⇧M, ⌘⇧G, ⌥H/J/K/L
  // + ⌥Arrows) are released; release notes must say so.
  'dispatch-mode',
  'global-dispatch',
  'normalize-layout',
  'hard-normalize-layout',
  'rotate-layout',
  'nav-left',
  'nav-right',
  'nav-up',
  'nav-down',
  // Stage 3a (#992): Tile Tabs, the bury archive and the grid attach/detach
  // pair. No default chords were bound to any of them except none — see
  // defaults.ts — so only palette rows and visibility overrides are affected.
  'tiled-tabs',
  'bury-pane',
  'revive-pane',
  'kill-buried-pane',
  'attach-detached-to-grid',
  'attach-all-detached-for-tab',
  'detach-to-dispatch',
  'toggle-status-mode',
  'toggle-worktree-badges',
  'usage.toggle-header',
  'usage.cycle-header-level',
  'dangerous-agents',
]

/** The exact six-member Navigation Commands group (plan decision 6). Closed by
 *  id, deliberately NOT derived from the broader `Navigate` category — the plan
 *  is explicit that a future navigation-adjacent command must not inherit
 *  default-hidden behavior merely by reusing a category. */
const NAVIGATION_COMMAND_GROUP: readonly string[] = [
  'next-tab',
  'prev-tab',
]

const ids = (): string[] => builtInCommandCatalog.map(c => c.id)

describe('built-in command catalog — baseline characterization', () => {
  it('contains exactly the 127 governed commands in registration order', () => {
    // Order matters: this is the palette's empty-query browse order.
    expect(ids()).toEqual([...BASELINE_COMMAND_IDS])
  })

  it('has exactly 127 commands', () => {
    // Stated separately from the order assertion because this number is the
    // thing that moves, and a bare count failure is a clearer signal than a
    // 99-line array diff.
    //
    // 102 baseline → 98 after governance (5 retirements, 1 addition) → 99 with
    // `open-keyboard-shortcuts` → 102 with the three composer commands → 104
    // with the two lane-removal commands → 105 with Set Agent Title → 106 with
    // New Lane → 112 with Grid Dispatch's six row commands → 113 with New
    // Window → 114 with Clear Agent Composer (#683) → 115 with API Key
    // Vault (#831) → 116 with Remove Cybersecurity Block (#848) → 117 with
    // New Agent In… (#852) → 119 with TLDR preview and TLDR MCP (#888) → 120
    // with Root Agent Code Management (#906) → 121 with Use Global MCP
    // Settings (#904) → 122 with Merge Project Tabs (#913) → 123 with View
    // TLDR History (#917) → 125 with Goal preview and Goal MCP (#936) → 126
    // with Auto-follow All Working Agents (#938) → 128 with the two ordinary
    // performance report/trace commands (#944) → 129 with Close Idle
    // Orchestration Agents (#960) → 130 with Open Agent Analytics (#964) → 121 with
    // the unified layout (#992): −dispatch-mode, −global-dispatch, −nav×4,
    // −normalize×3 → 114 with stage 3a: −tiled-tabs, −bury/revive/kill-buried,
    // −attach×2, −detach → 115 with Clear Lane (#992 stage 4) → 119 with the
    // lane keyboard grammar (#992 stage 5) → 123 once main's Goal Loop preview
    // and stop (#1001) and the two generated Grok splits (#844) merged in → 124
    // with Goal Loop MCP (#1006) → 125 with Open Setup (#995) → 127 with the two
    // generated Pi splits `pi-vertical` / `pi-horizontal` (#1132).
    // Each step of that arithmetic was a deliberate edit to this line, which is the entire point of pinning it. (The two test
    // titles above had drifted to "115" while this line said 116; they now
    // track it again.)
    expect(builtInCommandCatalog).toHaveLength(127)
  })

  it('reports no structural defects', () => {
    expect(findCatalogDefects(builtInCommandCatalog)).toEqual([])
  })

  it('has no duplicate ids', () => {
    // Redundant with findCatalogDefects, kept because a duplicate id is the one
    // defect that silently HALVES a command's reachability (the second
    // definition wins in some lookups and loses in others) rather than
    // producing a visible error.
    expect(new Set(ids()).size).toBe(builtInCommandCatalog.length)
  })
})

describe('generated per-provider split commands', () => {
  // The current literal + generated arithmetic is asserted by "accounts for the
  // difference between literal and total command count" below — not restated
  // here, because a number in this comment is what drifted to "103 + 4 = 107"
  // while the assertions moved on. If a provider
  // is ever added to AGENT_PROVIDER_KINDS, this invariant is what tells the
  // author that the catalog count moved for a legitimate reason, and forces the
  // baseline snapshot above to be updated deliberately.
  const nonDefaultProviders = AGENT_PROVIDER_KINDS.filter(k => k !== DEFAULT_PROVIDER)

  it('generates exactly (providers - default) x {vertical, horizontal}', () => {
    const generated = ids().filter(id =>
      nonDefaultProviders.some(kind => id === `${kind}-vertical` || id === `${kind}-horizontal`),
    )
    expect(generated).toHaveLength(nonDefaultProviders.length * 2)
  })

  it('accounts for the difference between literal and total command count', () => {
    // 125 total - 6 generated = 119 literal `id:` fields across the command
    // modules. At the original baseline this read 102 - 4 = 98; it moved down by
    // the five retirements, then back up by the nine additions, Grid Dispatch's
    // six row commands, New Window, and the later additions recorded in the
    // count test above (through the lane keyboard grammar, #992 stage 5, and
    // Goal Loop, #1001, Goal Loop MCP, #1006, and Open Setup, #995). Grok
    // (#844) grew only the
    // GENERATED term, 4 → 6.
    expect(builtInCommandCatalog.length - nonDefaultProviders.length * 2).toBe(119)
  })

  it('emits both directions for every non-default provider', () => {
    for (const kind of nonDefaultProviders) {
      expect(ids()).toContain(`${kind}-vertical`)
      expect(ids()).toContain(`${kind}-horizontal`)
    }
  })

  it('does not generate split commands for the default provider', () => {
    // The generic split-vertical/-horizontal commands already spawn the default
    // provider; a named duplicate would be two palette rows doing one thing.
    expect(ids()).not.toContain(`${DEFAULT_PROVIDER}-vertical`)
    expect(ids()).not.toContain(`${DEFAULT_PROVIDER}-horizontal`)
  })
})

describe('picker visibility', () => {
  it('uses more than one tier', () => {
    // HISTORICAL NOTE, kept because the inversion is the evidence:
    // at the Phase 0 baseline this assertion read `toEqual(new Set(['default']))`
    // — all 102 commands resolved to one tier, so debug tooling, destructive
    // maintenance and daily navigation entered the picker at the same level,
    // even though `advanced`/`experimental`/`debug` already existed in the type
    // and went unused.
    //
    // Phase 3 classified them. Inverting the assertion here rather than
    // deleting it keeps the before-state legible in the diff: the tripwire
    // fired exactly once, on purpose.
    const tiers = builtInCommandCatalog.map(c => c.pickerVisibility ?? 'default')
    expect(new Set(tiers).size).toBeGreaterThan(1)
  })

  it('keeps the tier distribution deliberate rather than incidental', () => {
    // Detailed per-tier rules live in taxonomy.test.ts. This one guards the
    // shape: every tier that is used must have a real population, so a typo
    // cannot create a tier with a single accidental member.
    const counts = new Map<string, number>()
    for (const command of builtInCommandCatalog) {
      const tier = command.pickerVisibility ?? 'default'
      counts.set(tier, (counts.get(tier) ?? 0) + 1)
    }
    expect(counts.get('default')).toBeGreaterThan(20)
    expect(counts.get('advanced')).toBeGreaterThan(10)
    expect(counts.get('debug')).toBeGreaterThan(5)
    expect(counts.get('experimental')).toBe(1)
  })
})

describe('native menu contract', () => {
  it('dispatches only ids that exist in the catalog', () => {
    // The high-severity defect in the plan: the menu resolves through the
    // picker-filtered registry, so a cosmetic visibility override can disable a
    // File-menu item. Fixing that (Phase 1) requires the ids to be resolvable
    // against the full catalog — which first requires them to BE in it.
    const catalogIds = new Set(ids())
    const missing = NATIVE_MENU_COMMAND_IDS.filter(id => !catalogIds.has(id))
    expect(missing).toEqual([])
  })

  it('covers the six File-menu actions recorded in the audit, plus Setup', () => {
    expect([...NATIVE_MENU_COMMAND_IDS]).toEqual([
      'new-tab',
      'resume-session',
      'save-editor-file',
      'save-all-editor-files',
      'reorder-tabs',
      'close-tab',
      // #995: the spawn error for a missing CLI says "Open Setup", so the menu
      // bar has to offer it.
      'open-setup',
    ])
  })
})

describe('governance targets', () => {
  // These assertions were written inverted at the baseline ("still contains",
  // "does not yet contain") so the retirement would be visible in the TEST
  // diff, not only in the implementation diff. This is that flip.

  it('no longer contains any of the five retired commands', () => {
    const catalogIds = new Set(ids())
    for (const id of RETIRED_COMMAND_IDS) {
      expect(catalogIds.has(id)).toBe(false)
    }
  })

  it('prunes every retired id from persisted settings', () => {
    // The #992 retirements were recorded here and nowhere else, so saved
    // overrides for them were never pruned and kept swallowing the chords the
    // lane commands now own (#1013 review B). Retiring an id means listing it
    // in BOTH places; this keeps the two lists equal.
    expect([...RETIRED_BUILT_IN_COMMAND_IDS].sort()).toEqual([...RETIRED_COMMAND_IDS].sort())
  })

  it('contains the one approved addition', () => {
    // Cmd+Shift+P was hard-coded in useKeybinds and named no command at all,
    // which is exactly why it could not be rebound or collision-checked.
    expect(ids()).toContain('open-command-palette')
  })

  it('contains every member of the closed Navigation Commands group', () => {
    const catalogIds = new Set(ids())
    for (const id of NAVIGATION_COMMAND_GROUP) {
      expect(catalogIds.has(id)).toBe(true)
    }
  })

  it('lands on the arithmetic the plan predicted', () => {
    // 102 baseline - 21 retirements + 46 additions = 127, checked against the
    // real catalog rather than trusted as prose. (5 governance retirements +
    // 16 unified-layout retirements, all recorded in RETIRED_COMMAND_IDS.)
    //
    // The subtracted term is the count of APPROVED ADDITIONS and the expected
    // value is the pre-governance baseline — so growing the catalog means
    // raising the subtrahend, never the right-hand side. Bumping 102 -> 105
    // instead would keep this green while making it assert nothing about the
    // plan, which is the one thing it exists to do.
    //
    // Additions so far: `open-command-palette` (governance: the palette could
    // not be rebound because it had no command id), `open-keyboard-shortcuts`,
    // and the three composer commands (`clear-composer`,
    // `undo-clear-composer`, `send-composer`), the two lane-removal commands
    // (`remove-tiled-lane`, `close-agent-remove-lane`), `agent.title.set`,
    // `new-tiled-lane`, Grid Dispatch's six row commands (#681):
    // `new-dispatch-row`, `remove-dispatch-row`, `dispatch-row-project`,
    // `dispatch-row-child-cap`, `dispatch-focus-row-up`,
    // `dispatch-focus-row-down`, `new-window` (#688), and
    // `clear-agent-composer` (#683), `api-key-vault` (#831),
    // `remove-cybersecurity-block` (#848), `new-agent-in` (#852),
    // `tldr-preview` and `enable-tldr-mcp` (#888),
    // `enable-root-agent-code-management` (#906), and
    // `use-global-mcp-settings` (#904), `merge-project-tabs` (#913), and
    // `view-tldr-history` (#917), `goal-preview` and `enable-goal-mcp` (#936),
    // `toggle-tail-working` (#938), `save-performance-report` and
    // `record-performance-trace` (#944), `close-idle-orchestration-agents` (#960),
    // `agent-analytics.open` (#964), `goal-loop-preview` and `goal-loop-stop`
    // (#1001), `grok-vertical` and `grok-horizontal` (#844, generated from
    // AGENT_PROVIDER_KINDS), `clear-focused-lane` (#992 stage 4), and the four
    // lane-grammar commands (#992 stage 5), `enable-goal-loop-mcp` (#1006),
    // `open-setup` (#995), and `pi-vertical` / `pi-horizontal` (#1132,
    // generated from AGENT_PROVIDER_KINDS like Grok's).
    expect(builtInCommandCatalog.length + RETIRED_COMMAND_IDS.length - 46).toBe(102)
    expect(builtInCommandCatalog).toHaveLength(127)
  })
})

describe('findCatalogDefects', () => {
  // The validator is only load-bearing if it actually catches things. Feeding
  // it deliberately broken fixtures is what stops it from degrading into a
  // function that returns [] for everything and a suite that proves nothing.

  const ok: CommandDef = {
    id: 'x.ok',
    surface: 'app',
    title: 'Ok',
    description: 'fine',
    run: () => {},
  }

  it('accepts a well-formed command', () => {
    expect(findCatalogDefects([ok])).toEqual([])
  })

  it('reports duplicate ids with both positions', () => {
    const defects = findCatalogDefects([ok, ok])
    expect(defects).toHaveLength(1)
    expect(defects[0]).toContain('duplicate id "x.ok"')
  })

  it('reports an empty description', () => {
    const defects = findCatalogDefects([{ ...ok, description: '   ' }])
    expect(defects).toEqual(['command "x.ok" has an empty description'])
  })

  it('reports an empty static title but tolerates a function title', () => {
    expect(findCatalogDefects([{ ...ok, title: '  ' }])).toEqual([
      'command "x.ok" has an empty title',
    ])
    expect(findCatalogDefects([{ ...ok, title: () => 'dynamic' }])).toEqual([])
  })

  it('reports an unknown surface', () => {
    const defects = findCatalogDefects([
      { ...ok, surface: 'nope' as CommandDef['surface'] },
    ])
    expect(defects).toEqual(['command "x.ok" has unknown surface "nope"'])
  })

  it('reports an unknown picker visibility tier', () => {
    const defects = findCatalogDefects([
      { ...ok, pickerVisibility: 'secret' as CommandDef['pickerVisibility'] },
    ])
    expect(defects).toEqual(['command "x.ok" has unknown pickerVisibility "secret"'])
  })

  it('reports a missing run handler', () => {
    const defects = findCatalogDefects([
      { ...ok, run: undefined as unknown as CommandDef['run'] },
    ])
    expect(defects).toEqual(['command "x.ok" has no run handler'])
  })

  it('accumulates every defect rather than stopping at the first', () => {
    const defects = findCatalogDefects([
      { ...ok, id: 'x.bad', description: '', surface: 'nope' as CommandDef['surface'] },
    ])
    expect(defects).toHaveLength(2)
  })
})
