import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'

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
    // THE LOAD-BEARING ASSERTION. The declared column is derived from the real
    // catalog, so adding, removing, or editing a `shortcut:` field in any
    // command module fails here and forces the drift table to be updated in the
    // same commit. Without this the table would be a comment that rots.
    //
    // Compared sorted by id, NOT in registration order: the table above is
    // grouped by theme (tabs, panes, navigation, editor) because that is what
    // makes the drift readable, while the catalog is in palette-browse order.
    // Registration order is already pinned by catalog.test.ts, so re-asserting
    // it here would only couple this table's layout to an unrelated concern.
    const byId = (a: { commandId: string }, b: { commandId: string }) =>
      a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0

    const declaredInCatalog = builtInCommandCatalog
      .filter(c => c.shortcut !== undefined)
      .map(c => ({ commandId: c.id, declared: c.shortcut ?? null }))
      .sort(byId)

    const declaredInBaseline = BINDING_BASELINE
      .filter(e => e.declared !== null)
      .map(e => ({ commandId: e.commandId, declared: e.declared }))
      .sort(byId)

    expect(declaredInBaseline).toEqual(declaredInCatalog)
  })

  it('counts 22 commands declaring display-only shortcut metadata', () => {
    // 80 of the 102 commands ship no chord at all. Scarcity is deliberate and
    // the plan preserves it: defaults are muscle memory, not an allocation of
    // every free chord.
    expect(builtInCommandCatalog.filter(c => c.shortcut !== undefined)).toHaveLength(22)
  })
})

describe('recorded authority drift', () => {
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
