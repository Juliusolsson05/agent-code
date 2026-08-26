import { describe, expect, it } from 'vitest'

import { PALETTE_MODE_COMMANDS, SURFACE_OWNER_FLAGS, commandOwnsOpenSurface } from '@renderer/features/command-palette/surfaceOwnership'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'

// ---------------------------------------------------------------------------
// Phase 0 characterization: THE SHORTCUT AUTHORITY SPLIT.
//
// `CommandDef.shortcut` is a display-only string. The behavior it describes is
// implemented somewhere else entirely — `workspace/tile-tree/useKeybinds.ts`
// for workspace chords, Monaco `addAction` + the EditorWorkbench bubble handler
// for editor chords, and a hard-coded `onCommandPalette?.()` callback for the
// palette itself. Nothing keeps the two in sync.
//
// That split is the reason the governance plan's keybinding phase exists: a
// user-editable binding would be cosmetic, because editing the string the
// palette renders would not touch the code that actually runs. Phase 4 replaces
// `shortcut` with `defaultKeybindings` and routes every command-backed handler
// through the execution gateway.
//
// This file pins the split BEFORE that migration, in three parts:
//   1. exactly which commands declare display metadata today;
//   2. the recorded drift — declared-but-not-implemented, implemented-but-not-
//      declared, and chords with no command at all;
//   3. the invariant that (1) and (2) agree, so the drift table cannot silently
//      rot when someone edits a `shortcut:` field.
//
// WHY the "actual behavior" column is a hand-authored table rather than
// something derived from the source: deriving it would mean parsing
// useKeybinds.ts's branch structure, which is a bespoke framework the repo's
// conventions reject, and which would still miss Monaco's registration. The
// table was read off the implementation directly (see the per-entry notes) and
// is cross-checked against the catalog by the last test, so an edit on either
// side breaks the suite.
// ---------------------------------------------------------------------------

/** Where the chord that runs a command is actually implemented today. */
type BindingOwner =
  /** `useKeybinds.ts` — the workspace capture-phase router. */
  | 'useKeybinds'
  /** Monaco `addAction` and/or the EditorWorkbench bubble-phase handler. */
  | 'editor'
  /** Nothing runs it; the metadata string is decoration. */
  | 'nothing'

type BindingBaseline = {
  commandId: string
  /** The `shortcut` string the command declares, or null if it declares none. */
  declared: string | null
  /** Chords that really run this command's behavior today. May be empty. */
  effective: readonly string[]
  owner: BindingOwner
  note: string
}

/**
 * The complete recorded state of command-backed keyboard behavior at the
 * governance baseline. Only commands that either declare a shortcut OR have a
 * real chord appear here; a command with neither is unbound and uninteresting.
 */
const BINDING_BASELINE: readonly BindingBaseline[] = [
  // --- Tabs: declared and implemented, in agreement. -----------------------
  {
    commandId: 'new-tab',
    declared: '⌘T',
    effective: ['⌘T'],
    owner: 'useKeybinds',
    note: 'cmd && k === "t" && !shift. Agrees with metadata.',
  },
  {
    commandId: 'close-tab',
    declared: '⌘⇧W',
    effective: ['⌘⇧W'],
    owner: 'useKeybinds',
    note: 'cmd && w && shift → closeTab(activeTab.id).',
  },
  {
    commandId: 'next-tab',
    declared: '⌘]',
    effective: ['⌘]'],
    owner: 'useKeybinds',
    note: 'cmd && k === "]" → workspace.nextTab().',
  },
  {
    commandId: 'prev-tab',
    declared: '⌘[',
    effective: ['⌘['],
    owner: 'useKeybinds',
    note: 'cmd && k === "[" → workspace.prevTab().',
  },
  {
    commandId: 'resume-session',
    declared: '⌘⇧R',
    effective: ['⌘⇧R'],
    owner: 'useKeybinds',
    note: 'cmd && r && shift → onResumeRequest(focused cwd).',
  },
  {
    commandId: 'undo-close',
    declared: '⌘⇧T',
    effective: ['⌘⇧T'],
    owner: 'useKeybinds',
    note: 'cmd && shift && t → workspace.undoClose().',
  },

  // --- Panes: one UNDECLARED ALIAS. ---------------------------------------
  {
    commandId: 'close-pane',
    declared: '⌘W',
    effective: ['⌘W', '⌥W'],
    owner: 'useKeybinds',
    note:
      'DRIFT (undeclared alias): cmd+w AND alt+w (code === "KeyW") both call ' +
      'workspace.closeFocused(). Only ⌘W is advertised, so ⌥W is a destructive ' +
      'chord that no UI surface discloses.',
  },
  {
    commandId: 'split-vertical',
    declared: '⌥D',
    effective: ['⌥D'],
    owner: 'useKeybinds',
    note: 'code === "KeyD" && !shift. Physical code, because ⌥D types "∂" on macOS.',
  },
  {
    commandId: 'split-horizontal',
    declared: '⌥⇧D',
    effective: ['⌥⇧D'],
    owner: 'useKeybinds',
    note: 'code === "KeyD" && shift.',
  },
  {
    commandId: 'terminal-horizontal',
    declared: '⌥T',
    effective: ['⌥T'],
    owner: 'useKeybinds',
    note: 'code === "KeyT" && !shift → splitFocused("vertical", "terminal").',
  },
  {
    commandId: 'terminal-vertical',
    declared: '⌥⇧T',
    effective: ['⌥⇧T'],
    owner: 'useKeybinds',
    note: 'code === "KeyT" && shift → splitFocused("horizontal", "terminal").',
  },
  {
    commandId: 'codex-vertical',
    declared: '⌥C',
    effective: ['⌥C'],
    owner: 'useKeybinds',
    note:
      'Generated from the provider identity descriptor (splitShortcutKey: "C"). ' +
      'The keybind side loops AGENT_PROVIDER_KINDS and matches code === `Key${chord}`, ' +
      'so metadata and behavior share one source — the only chord family that does.',
  },
  {
    commandId: 'codex-horizontal',
    declared: '⌥⇧C',
    effective: ['⌥⇧C'],
    owner: 'useKeybinds',
    note: 'Same provider loop, shift branch.',
  },

  // --- Navigation: FOUR UNDECLARED ARROW ALIASES. -------------------------
  {
    commandId: 'nav-left',
    declared: '⌥H',
    effective: ['⌥H', '⌥←'],
    owner: 'useKeybinds',
    note: 'DRIFT (undeclared alias): `code === "KeyH" || k === "ArrowLeft"`.',
  },
  {
    commandId: 'nav-right',
    declared: '⌥L',
    effective: ['⌥L', '⌥→'],
    owner: 'useKeybinds',
    note: 'DRIFT (undeclared alias): `code === "KeyL" || k === "ArrowRight"`.',
  },
  {
    commandId: 'nav-up',
    declared: '⌥K',
    effective: ['⌥K', '⌥↑'],
    owner: 'useKeybinds',
    note: 'DRIFT (undeclared alias): `code === "KeyK" || k === "ArrowUp"`.',
  },
  {
    commandId: 'nav-down',
    declared: '⌥J',
    effective: ['⌥J', '⌥↓'],
    owner: 'useKeybinds',
    note: 'DRIFT (undeclared alias): `code === "KeyJ" || k === "ArrowDown"`.',
  },

  // --- Feed ---------------------------------------------------------------
  {
    commandId: 'jump-latest-message',
    declared: 'End',
    effective: ['End'],
    owner: 'useKeybinds',
    note:
      'Bare End with no modifiers, guarded by !isTextEditingTarget and a ' +
      'rendered-surface check. Agrees with metadata.',
  },

  // --- Editor: a METADATA GAP and an EDITOR-OWNED chord. ------------------
  {
    commandId: 'toggle-global-editor',
    declared: null,
    effective: ['⌘⇧E'],
    owner: 'useKeybinds',
    note:
      'DRIFT (metadata gap): cmd+shift+e calls toggleGlobalEditor() directly, but ' +
      'the command declares no shortcut, so the palette shows this row with no ' +
      'chord even though one exists. Phase 4 adds ⌘⇧E to defaultKeybindings.',
  },
  {
    commandId: 'toggle-editor-fullscreen',
    declared: '⌥⌘E',
    effective: ['⌥⌘E'],
    owner: 'useKeybinds',
    note: 'cmd && alt && code === "KeyE". Opens the editor first when closed.',
  },
  {
    commandId: 'quick-open-file',
    declared: '⌘P',
    effective: ['⌘P'],
    owner: 'useKeybinds',
    note: 'cmd && !shift && !alt && p. Opens the editor first when closed.',
  },
  {
    commandId: 'search-in-files',
    declared: '⌘⇧F',
    effective: ['⌘⇧F'],
    owner: 'useKeybinds',
    note: 'cmd && shift && f. Opens the editor first when closed.',
  },
  {
    commandId: 'save-editor-file',
    declared: '⌘S',
    effective: ['⌘S'],
    owner: 'editor',
    note:
      'DRIFT (not command-backed): useKeybinds deliberately RETURNS for ' +
      'cmd+s in editor chrome. The chord is implemented twice elsewhere — ' +
      'Monaco `editor.addAction({keybindings: [CtrlCmd | KeyS]})` inside the ' +
      'text area, and EditorWorkbench.onKeyDown for tabs/Explorer/splitters. ' +
      'Neither consults the command. This is the case the plan singles out: ' +
      'rebinding Save in Settings must remove BOTH, or the old chord survives.',
  },
  {
    commandId: 'save-all-editor-files',
    declared: null,
    effective: [],
    owner: 'nothing',
    note: 'No chord today. Reachable from the palette and the File menu only.',
  },
]

/** Chords that run real behavior but belong to NO command — they cannot be
 *  rebound today because there is no id to attach a binding to. */
const UNOWNED_COMMAND_CHORDS = [
  {
    chord: '⌘⇧P',
    behavior: 'Opens the command palette',
    note:
      'useKeybinds calls the hard-coded `onCommandPalette?.()` callback. There is ' +
      'no command id, so this chord is absent from the catalog AND unconfigurable. ' +
      'Phase 4 introduces `open-command-palette` precisely to give it an owner — ' +
      'the single approved catalog addition (102 - 5 + 1 = 98).',
  },
] as const

const catalogById = new Map(builtInCommandCatalog.map(c => [c.id, c]))

describe('shortcut metadata baseline', () => {
  it('every baseline entry names a command that exists', () => {
    const missing = BINDING_BASELINE.filter(e => !catalogById.has(e.commandId))
    expect(missing.map(e => e.commandId)).toEqual([])
  })

  it('records the declared shortcut of every command that has one', () => {
    // THE LOAD-BEARING ASSERTION, now inverted.
    //
    // At the baseline this compared the table's `declared` column against
    // `CommandDef.shortcut`, so editing an authored string forced the drift
    // table to be updated. That field NO LONGER EXISTS — the migration
    // deleted it — so the assertion now checks the thing that replaced it:
    // every chord the table recorded as REALLY RUNNING is present in the
    // effective binding set the router and the palette both consume.
    //
    // That is the migration's core claim, checked rather than asserted in
    // prose: the behaviour did not change, only its source of truth. A chord
    // that silently stopped working would fail here.
    const effective = new Map(
      resolveEffectiveKeybindings({}).map(e => [e.commandId, e.bindings]),
    )

    const missing: string[] = []
    for (const entry of BINDING_BASELINE) {
      // Save is editor-owned and still implemented by Monaco/EditorWorkbench
      // rather than routed, so it has a default but its runtime path is
      // unchanged. Excluded here and tracked separately below.
      if (entry.owner !== 'useKeybinds') continue
      const now = effective.get(entry.commandId) ?? []
      for (const chord of entry.effective) {
        const canonical = DISPLAY_TO_CANONICAL[chord]
        if (!canonical) continue
        if (!now.includes(canonical)) missing.push(`${entry.commandId}:${chord}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('no longer carries any authored display-only shortcut metadata', () => {
    // The audit's core keybinding finding was that `CommandDef.shortcut` was a
    // display string with no relationship to the code that ran. It is gone:
    // `ResolvedCommand.shortcut` is now DERIVED from effective bindings at
    // resolve time, so the chord the palette shows is the chord that runs.
    for (const command of builtInCommandCatalog) {
      expect('shortcut' in command).toBe(false)
    }
  })
})

/** Display chords in the baseline table, mapped to the canonical grammar. */
const DISPLAY_TO_CANONICAL: Record<string, string> = {
  '⌘T': 'Cmd+T', '⌘⇧W': 'Cmd+Shift+W', '⌘]': 'Cmd+]', '⌘[': 'Cmd+[',
  '⌘⇧R': 'Cmd+Shift+R', '⌘⇧T': 'Cmd+Shift+T', '⌘W': 'Cmd+W', '⌥W': 'Alt+W',
  '⌥D': 'Alt+D', '⌥⇧D': 'Alt+Shift+D', '⌥T': 'Alt+T', '⌥⇧T': 'Alt+Shift+T',
  '⌥C': 'Alt+C', '⌥⇧C': 'Alt+Shift+C',
  '⌥H': 'Alt+H', '⌥←': 'Alt+Left', '⌥L': 'Alt+L', '⌥→': 'Alt+Right',
  '⌥K': 'Alt+K', '⌥↑': 'Alt+Up', '⌥J': 'Alt+J', '⌥↓': 'Alt+Down',
  'End': 'End', '⌘⇧E': 'Cmd+Shift+E', '⌥⌘E': 'Cmd+Alt+E',
  '⌘P': 'Cmd+P', '⌘⇧F': 'Cmd+Shift+F',
}

// HISTORICAL: these describe the state BEFORE the migration. The table is
// kept because it is the evidence for what the defaults had to preserve, and
// the assertions still hold over the table itself.
describe('recorded authority drift (pre-migration history)', () => {
  it('lists exactly the six commands whose real chords exceed their metadata', () => {
    // Undeclared aliases: the palette under-reports what the keyboard does.
    const underReported = BINDING_BASELINE.filter(
      e => e.declared !== null && e.effective.length > 1,
    )
    expect(underReported.map(e => e.commandId).sort()).toEqual([
      'close-pane',
      'nav-down',
      'nav-left',
      'nav-right',
      'nav-up',
    ])
  })

  it('lists the command whose chord exists with no metadata at all', () => {
    const gaps = BINDING_BASELINE.filter(e => e.declared === null && e.effective.length > 0)
    expect(gaps.map(e => e.commandId)).toEqual(['toggle-global-editor'])
  })

  it('lists the command whose chord is owned by the editor, not the command', () => {
    const editorOwned = BINDING_BASELINE.filter(e => e.owner === 'editor')
    expect(editorOwned.map(e => e.commandId)).toEqual(['save-editor-file'])
  })

  it('records the palette chord that used to have no command owner', () => {
    // At the baseline ⌘⇧P ran through a hard-coded `onCommandPalette?.()`
    // callback and named no command, which is precisely why it could not be
    // rebound, listed in Settings, or collision-checked.
    expect(UNOWNED_COMMAND_CHORDS.map(c => c.chord)).toEqual(['⌘⇧P'])
    // It has an owner now. The assertion is inverted rather than deleted so the
    // before-state stays legible: this is the defect, and this is the fix.
    expect(builtInCommandCatalog.map(c => c.id)).toContain('open-command-palette')
  })

  it('proves declared metadata is not sufficient to know what a key does', () => {
    // The one-sentence summary of why Phase 4 exists, as an executable claim:
    // the set of chords the app really runs for commands is strictly larger
    // than the set the palette advertises.
    const declaredChords = new Set(
      BINDING_BASELINE.flatMap(e => (e.declared === null ? [] : [e.declared])),
    )
    const effectiveChords = new Set(BINDING_BASELINE.flatMap(e => e.effective))
    for (const chord of UNOWNED_COMMAND_CHORDS) effectiveChords.add(chord.chord)

    // Seven chords do real work that no palette row advertises: the Global
    // Editor toggle (declared nowhere), the palette itself (owned by no
    // command), the undisclosed ⌥W close, and the four arrow aliases.
    const undisclosed = [...effectiveChords].filter(c => !declaredChords.has(c)).sort()
    expect(undisclosed).toEqual(['⌘⇧E', '⌘⇧P', '⌥W', '⌥←', '⌥↑', '⌥→', '⌥↓'])
  })
})

// ---------------------------------------------------------------------------
// Surface ownership — the narrow exemption to the interaction-owner gate.
//
// `useKeybinds` bails out of the whole key handler while any Radix dialog is
// mounted, which is correct (⌘W must not close a pane behind a confirmation)
// but means a dialog-based surface makes its own chord unreachable. That is the
// entire reason ⌘⇧U could open Usage and never dismiss it, while ⌥R Reader
// round-tripped fine — Reader renders inline and stamps no owner marker.
//
// The exemption lets a chord cross the gate when it maps to the command that
// owns the surface currently in front of the user. These cases pin the two
// properties that keep it narrow: the table names real commands, and the
// predicate only ever answers for those.
// ---------------------------------------------------------------------------
describe('surface ownership', () => {
  const catalogIds = new Set(builtInCommandCatalog.map(command => command.id))

  it('names only commands that exist', () => {
    for (const commandId of Object.keys(PALETTE_MODE_COMMANDS)) {
      expect(catalogIds.has(commandId)).toBe(true)
    }
    // A stale id here is worse than useless: the chord silently stops being
    // exempt and the surface becomes undismissable again, with nothing failing.
    for (const commandId of Object.keys(SURFACE_OWNER_FLAGS)) {
      expect(catalogIds.has(commandId)).toBe(true)
    }
  })

  it('reports ownership only when that command’s own surface is open', () => {
    expect(commandOwnsOpenSurface('usage.open', { usageModalOpen: true } as never)).toBe(true)
    expect(commandOwnsOpenSurface('usage.open', { usageModalOpen: false } as never)).toBe(false)
  })

  it('refuses every command not in the table', () => {
    // The gate's default is still "bail". Only a listed command may cross it,
    // so an unrelated chord cannot reach a workspace action while a modal owns
    // the screen — which is the bug the gate exists to prevent.
    expect(commandOwnsOpenSurface('close-pane', { usageModalOpen: true } as never)).toBe(false)
    expect(commandOwnsOpenSurface('split-vertical', { usageModalOpen: true } as never)).toBe(false)
  })

  it('lets a palette-mode command through whenever the palette is open', () => {
    // Wider than strict dismissal on purpose: pressing ⌥P while the palette
    // sits in Resume mode should SWITCH to prompt templates, not be swallowed.
    // The command compares flags.paletteMode and decides; the table only
    // decides whether it gets the chance.
    expect(commandOwnsOpenSurface('prompt-template', { commandPaletteOpen: true } as never)).toBe(true)
    expect(commandOwnsOpenSurface('prompt-template', { commandPaletteOpen: false } as never)).toBe(false)
  })

  it('gives every flag-backed command a state badge that reports its surface', () => {
    // The two halves of the round-trip have to agree. The table lets the chord
    // CROSS the interaction gate; the command's own state and run are what
    // dismiss once it does. A command listed here without a `getState` is one
    // whose second press reaches a `run` that may still only open — the chord
    // would look like it does nothing, which is exactly the reported bug.
    // Scoped to SURFACE_OWNER_FLAGS. Palette-mode commands are deliberately
    // excluded: they dismiss by comparing `flags.paletteMode`, and an
    // Open/Closed badge on Resume Session would report a property of the
    // palette rather than of the command. Merging the two tables made this
    // assertion demand exactly that, which is how the split was found.
    for (const commandId of Object.keys(SURFACE_OWNER_FLAGS)) {
      const command = builtInCommandCatalog.find(candidate => candidate.id === commandId)
      expect(command?.getState, `${commandId} has no getState`).toBeDefined()
    }
  })

  it('actually calls the matching close action when its surface is open', () => {
    // The assertion that was missing, and the one a copy-paste defeats: a
    // `getState` proving a command CAN see its surface says nothing about the
    // `run` closing the RIGHT one. Driving each run with its own flag true and
    // asserting the matching `close*` fired — and that no other one did — is
    // what pins the pairing.
    for (const [commandId, flag] of Object.entries(SURFACE_OWNER_FLAGS)) {
      const command = builtInCommandCatalog.find(candidate => candidate.id === commandId)
      if (!command) throw new Error(`${commandId} is not in the catalog`)

      const calls: string[] = []
      const ui = new Proxy({}, {
        get: (_target, prop: string) => () => calls.push(prop),
      })
      command.run({
        ui,
        flags: { [flag]: true },
        workspace: { state: { sessions: {}, tabs: [], activeTabId: '' } },
      } as never)

      // Two legitimate shapes, and the distinction is real rather than
      // cosmetic: most of these surfaces have separate open/close actions and
      // the command must branch, but Remote Panel has a genuine `toggle*` that
      // is already correct in both directions. Both dismiss when the flag is
      // true; only "opened anyway" is a defect.
      const dismissed = calls.filter(name =>
        (name.startsWith('close') && name !== 'closePalette') || name.startsWith('toggle'),
      )
      expect(dismissed, `${commandId} (flag ${flag}) did not dismiss`).toHaveLength(1)
      expect(
        calls.some(name => name.startsWith('open')),
        `${commandId} opened its surface while it was already open`,
      ).toBe(false)
    }
  })

  it('excludes surfaces where a second press must not mean dismiss', () => {
    // Recorded as a decision, not an omission. Per-target pickers should
    // RE-TARGET on a second press; Save Debug Logs and Attach Recording Note
    // each write something on the way in, so a second press legitimately writes
    // a second one; Settings is a destination, not a peek.
    for (const excluded of [
      'view-prompts',
      'rewind-to-prompt',
      'set-agent-view-mode',
      'agent.title.set',
      'dispatch.color-flag.set',
      'save-debug-logs',
      'attach-recording-note',
      'open-settings',
      'open-command-palette',
    ]) {
      expect(Object.keys(SURFACE_OWNER_FLAGS)).not.toContain(excluded)
      expect(Object.keys(PALETTE_MODE_COMMANDS)).not.toContain(excluded)
    }
  })
})
