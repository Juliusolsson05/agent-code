import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog, findCatalogDefects } from '@renderer/features/command-palette/catalog'
import { NATIVE_MENU_COMMAND_IDS } from '@shared/commands/nativeMenuCommandIds'
import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { CommandDef } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Phase 0 of the command-governance plan (docs/superpowers/plans/
// 2026-07-23-command-surface-audit.md): CHARACTERIZE THE CURRENT CATALOG.
//
// This file pinned the exact 102-id before-state, and now pins the 107-id
// after-state: five durable preferences retired to Settings, nine approved
// additions (102 - 5 + 10 = 107). Keeping ONE snapshot that moved — rather
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
  // tabCommands (6)
  'new-tab',
  'close-tab',
  'next-tab',
  'prev-tab',
  'reorder-tabs',
  'resume-session',
  // paneCommands (31: 27 literal + 4 generated provider splits)
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
  'clear-composer',
  'undo-clear-composer',
  'send-composer',
  // layoutCommands (11: New Lane joins the two lane-removal commands)
  'dispatch-mode',
  'global-dispatch',
  'tiled-dispatch',
  'new-tiled-lane',
  'remove-tiled-lane',
  'close-agent-remove-lane',
  'normalize-layout',
  'hard-normalize-layout',
  'rotate-layout',
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
  'clear-agent-composer',
  'toggle-dev-debug-panel',
  // agentTitleCommands (1)
  'agent.title.set',
  // dispatchColorFlagCommands (1)
  'dispatch.color-flag.set',
  // spotlight / reader / tile-tabs (3)
  'toggle-spotlight',
  'toggle-reader-mode',
  'tiled-tabs',
  // settingsCommands (4, was 5: worktree-badges + dangerous-agents retired,
  // open-keyboard-shortcuts added)
  'open-settings',
  'open-keyboard-shortcuts',
  'toggle-aggressive-debug-persistence',
  'toggle-worktrees-bar',
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
  // usage (1, was 3: both header preferences retired)
  'usage.open',
  // paletteCommands (1) — the single approved addition
  'open-command-palette',
]

/** The five durable preferences retired from Commands to Settings. Their
 *  canonical settings fields are untouched, so no value migration is needed —
 *  only the now-meaningless per-command preference entries are pruned. */
const RETIRED_COMMAND_IDS: readonly string[] = [
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
  it('contains exactly the 107 governed commands in registration order', () => {
    // Order matters: this is the palette's empty-query browse order.
    expect(ids()).toEqual([...BASELINE_COMMAND_IDS])
  })

  it('has exactly 107 commands', () => {
    // Stated separately from the order assertion because this number is the
    // thing that moves, and a bare count failure is a clearer signal than a
    // 99-line array diff.
    //
    // 102 baseline → 98 after governance (5 retirements, 1 addition) → 99 with
    // `open-keyboard-shortcuts` → 102 with the three composer commands → 104
    // with the two lane-removal commands → 105 with Set Agent Title → 106 with
    // New Lane → 107 with Clear Agent Composer (#683). Each
    // step of that arithmetic was a deliberate edit to this line, which is the
    // entire point of pinning it.
    expect(builtInCommandCatalog).toHaveLength(107)
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
  // The arithmetic is 103 literal ids + 4 generated = 107. If a provider
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
    // 107 total - 4 generated = 103 literal `id:` fields across the command
    // modules. At the original baseline this read 102 - 4 = 98; it moved down by
    // the five retirements, then back up by the nine additions.
    expect(builtInCommandCatalog.length - nonDefaultProviders.length * 2).toBe(103)
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
    // 102 baseline - 5 retirements + 10 additions = 107, checked against the
    // real catalog rather than trusted as prose.
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
    // `new-tiled-lane`, and `clear-agent-composer`.
    expect(builtInCommandCatalog.length + RETIRED_COMMAND_IDS.length - 10).toBe(102)
    expect(builtInCommandCatalog).toHaveLength(107)
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
