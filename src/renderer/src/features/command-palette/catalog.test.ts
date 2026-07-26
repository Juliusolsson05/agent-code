import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog, findCatalogDefects } from '@renderer/features/command-palette/catalog'
import { NATIVE_MENU_COMMAND_IDS } from '@shared/commands/nativeMenuCommandIds'
import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { CommandDef } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Phase 0 of the command-governance plan (docs/superpowers/plans/
// 2026-07-23-command-surface-audit.md): CHARACTERIZE THE CURRENT CATALOG.
//
// Everything here describes what the catalog is TODAY, before any governance
// behavior changes. That is the whole point: the later phases retire five
// commands, add one, reclassify tiers, and rewire how ids resolve. Without a
// pinned before-state, "did we change exactly what we meant to change" is
// unanswerable, and the plan's central count (102 → 98) is an assertion nobody
// can check.
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

/** The exact ordered catalog as of the governance baseline (main @ 670f4c2d). */
const BASELINE_COMMAND_IDS: readonly string[] = [
  // tabCommands (6)
  'new-tab',
  'close-tab',
  'next-tab',
  'prev-tab',
  'reorder-tabs',
  'resume-session',
  // paneCommands (28: 24 literal + 4 generated provider splits)
  'new-agent',
  'split-vertical',
  'split-horizontal',
  'close-pane',
  'bury-pane',
  'linked-agent',
  'attach-detached-to-grid',
  'pin-agents',
  'unpin-agent',
  'attach-all-detached-for-tab',
  'detach-to-dispatch',
  'terminal-horizontal',
  'terminal-vertical',
  'codex-vertical',
  'codex-horizontal',
  'opencode-vertical',
  'opencode-horizontal',
  'nav-left',
  'nav-right',
  'nav-up',
  'nav-down',
  'undo-close',
  'revive-pane',
  'kill-buried-pane',
  'toggle-tail',
  'toggle-tail-all',
  'jump-latest-message',
  'copy-last-assistant',
  // layoutCommands (9)
  'dispatch-mode',
  'global-dispatch',
  'tiled-dispatch',
  'normalize-layout',
  'hard-normalize-layout',
  'rotate-layout',
  'toggle-status-mode',
  'toggle-performance-panel',
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
  // sessionCommands (29)
  'view-prompts',
  'rewind-to-prompt',
  'undo-rewind',
  'open-agent-activity',
  'close-old-agents',
  'switch-agents-provider',
  'search-conversation-prompts',
  'enable-built-in-mcp-ping',
  'enable-ai-workspace-mcp',
  'enable-orchestration-mcp',
  'enable-agent-transcripts-mcp',
  'enable-agent-management-mcp',
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
  'toggle-dev-debug-panel',
  // dispatchColorFlagCommands (1)
  'dispatch.color-flag.set',
  // spotlight / reader / tile-tabs (3)
  'toggle-spotlight',
  'toggle-reader-mode',
  'tiled-tabs',
  // settingsCommands + dangerousCommands (5)
  'open-settings',
  'toggle-aggressive-debug-persistence',
  'toggle-worktrees-bar',
  'toggle-worktree-badges',
  'dangerous-agents',
  // copy-assistant / copy-code-block (2)
  'copy-assistant-message',
  'copy-code-block',
  // prompt templates + reply to selection (4)
  'manage-prompt-templates',
  'prompt-template',
  'save-composer-as-prompt-template',
  'reply-to-selection',
  // agent status / remote (2)
  'show-agent-status',
  'toggle-remote-panel',
  // usage (3)
  'usage.open',
  'usage.toggle-header',
  'usage.cycle-header-level',
]

/** The five ids the plan retires in Phase 4, kept here so the retirement is a
 *  one-line diff against a named list rather than five scattered edits. */
const PLANNED_RETIREMENTS: readonly string[] = [
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
  'nav-left',
  'nav-right',
  'nav-up',
  'nav-down',
]

const ids = (): string[] => builtInCommandCatalog.map(c => c.id)

describe('built-in command catalog — baseline characterization', () => {
  it('contains exactly the 102 baseline commands in registration order', () => {
    // Order matters: this is the palette's empty-query browse order.
    expect(ids()).toEqual([...BASELINE_COMMAND_IDS])
  })

  it('has exactly 102 commands', () => {
    // Stated separately from the order assertion because the plan's headline
    // number is the thing later phases move (102 → 98), and a bare count
    // failure is a clearer signal than a 102-line array diff.
    expect(builtInCommandCatalog).toHaveLength(102)
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
  // The plan's arithmetic is 98 literal ids + 4 generated = 102. If a provider
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
    // 102 total - 4 generated = 98 literal `id:` fields in the command modules.
    // This is the exact reconciliation the plan performs, asserted rather than
    // asserted-in-prose.
    expect(builtInCommandCatalog.length - nonDefaultProviders.length * 2).toBe(98)
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

describe('picker visibility baseline', () => {
  it('resolves every command to the default tier today', () => {
    // The plan's most consequential finding: `advanced`/`experimental`/`debug`
    // all EXIST in the type and NONE are used, so debug tooling, destructive
    // maintenance and daily navigation enter the picker at the same tier.
    //
    // This assertion is expected to FAIL in Phase 3, which is the point — it is
    // the tripwire proving tier classification actually landed rather than
    // being declared in a doc.
    const tiers = builtInCommandCatalog.map(c => c.pickerVisibility ?? 'default')
    expect(new Set(tiers)).toEqual(new Set(['default']))
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

  it('covers the six File-menu actions recorded in the audit', () => {
    expect([...NATIVE_MENU_COMMAND_IDS]).toEqual([
      'new-tab',
      'resume-session',
      'save-editor-file',
      'save-all-editor-files',
      'reorder-tabs',
      'close-tab',
    ])
  })
})

describe('planned governance targets still exist in the baseline', () => {
  // These assertions exist so the later phases have something to invert. If a
  // retirement lands, the corresponding line here flips to `not.toContain` in
  // the same commit — making the retirement visible in the test diff instead of
  // only in the implementation diff.

  it('still contains all five commands planned for retirement', () => {
    const catalogIds = new Set(ids())
    for (const id of PLANNED_RETIREMENTS) {
      expect(catalogIds.has(id)).toBe(true)
    }
  })

  it('does not yet contain the planned open-command-palette command', () => {
    // Cmd+Shift+P is hard-coded in useKeybinds today and is not a command at
    // all, which is why its binding cannot be configured. Phase 4 adds it.
    expect(ids()).not.toContain('open-command-palette')
  })

  it('contains every member of the closed Navigation Commands group', () => {
    const catalogIds = new Set(ids())
    for (const id of NAVIGATION_COMMAND_GROUP) {
      expect(catalogIds.has(id)).toBe(true)
    }
  })

  it('projects the post-Phase-4 catalog size as 98', () => {
    // 102 - 5 retirements + 1 addition = 98. Encoded so the plan's headline
    // arithmetic is checked against the real catalog rather than trusted.
    expect(builtInCommandCatalog.length - PLANNED_RETIREMENTS.length + 1).toBe(98)
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
