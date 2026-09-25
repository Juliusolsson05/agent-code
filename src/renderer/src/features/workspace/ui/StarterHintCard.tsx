import { useMemo } from 'react'
import { Kbd } from '@renderer/components/ui/kbd'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import { displayKeybinding } from '@shared/keybindings'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { reservedInteractionBindings } from '@renderer/features/command-keybindings/reservations'
import { isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionKind } from '@renderer/workspace/types'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'

// The starter card (#992 §4.6) — the which-key/starter-dashboard pattern, at
// the two moments of maximum "now what?": a FRESH agent whose feed shows only
// the provider welcome, and an EMPTY focused lane.
//
// THE CARD IS REGISTRY-DRIVEN, ALWAYS. Every row is a COMMAND ID resolved
// through the catalog for its title and through `resolveEffectiveKeybindings`
// for its chord — the same resolution the router performs — so a user who
// rebinds New Lane sees THEIR chord, and a default-chord change can never
// leave the card lying. Hardcoded chord strings in this component are a plan
// failure, not a shortcut; the one non-command entry (the ⌘1–9 fill grammar)
// resolves through the reservation table for the same reason — it is the
// registry of things that own chords without being commands.
//
// Commands with no default binding render title-only. That is deliberate
// honesty, not a gap: the shortcuts surface and Settings are where bindings
// are made, and a card that invented chords would be a second source of truth
// the day one of them changed.

/**
 * Whether the FRESH-AGENT card is visible for a session (#992 §4.6): an
 * agent-kind session whose committed entries hold no user turn yet.
 *
 * WHY derived and not stored: the card must vanish by itself the moment the
 * first prompt lands (an entry arriving is the event), never survive a
 * restart as stale chrome (restored sessions replay their history into
 * entries), and never need dismissal state persisted anywhere. Terminal views
 * never ask — AgentTerminalLeaf does not render the card at all.
 */
export function starterCardVisibleForAgent(
  meta: { kind?: SessionKind | string } | undefined,
  entries: readonly { type: string }[],
): boolean {
  if (!meta || !isAgentProviderKind(meta.kind)) return false
  return !entries.some(entry => entry.type === 'user')
}

type Slot =
  | { commandId: string }
  /** Two commands that are one gesture in the reader's mind (⌥← / ⌥→). */
  | { pairCommandIds: [string, string] }
  /** A chord-owning non-command (the digit grammar). */
  | { reservationOwner: string; label: string }

// Context A — the eight slots, curated for v1 (§4.6 table), not usage-ranked.
// Usage-adaptive ranking is a stated follow-up, not v1.
const FRESH_AGENT_SLOTS: readonly Slot[] = [
  { commandId: 'open-command-palette' },
  { commandId: 'new-agent' },
  { commandId: 'new-tiled-lane' },
  { commandId: 'new-dispatch-row' },
  { pairCommandIds: ['dispatch-focus-lane-left', 'dispatch-focus-lane-right'] },
  { reservationOwner: 'Numbered tab / Dispatch row selection', label: 'Fill Lane from Index' },
  { commandId: 'toggle-spotlight' },
  { commandId: 'clear-focused-lane' },
]

// Context B — the four placement-flavored slots only: fill, grow, escape
// hatch, and the index walk (§4.6 "Context B shows the four placement-flavored
// slots only (6, 3, 1, plus the index walk)").
const EMPTY_LANE_SLOTS: readonly Slot[] = [
  { reservationOwner: 'Numbered tab / Dispatch row selection', label: 'Fill Lane from Index' },
  { commandId: 'new-tiled-lane' },
  { commandId: 'open-command-palette' },
  { pairCommandIds: ['dispatch-select-previous-agent', 'dispatch-select-next-agent'] },
]

type CardRow = {
  key: string
  label: string
  /** Display chord, or null when the command has no live binding. */
  chord: string | null
}

function buildRow(slot: Slot, titles: Map<string, string>, bindings: Map<string, readonly string[]>): CardRow | null {
  if ('commandId' in slot) {
    const title = titles.get(slot.commandId)
    // An unresolvable id is a programming error in the slot table, not a
    // runtime condition: rendering a title-less row would show a bare chord,
    // which is the card lying. Drop the row; its test fails loudly instead.
    if (!title) return null
    const binding = bindings.get(slot.commandId)?.[0]
    return { key: slot.commandId, label: title, chord: binding ? displayKeybinding(binding) : null }
  }
  if ('pairCommandIds' in slot) {
    const [leftId, rightId] = slot.pairCommandIds
    const left = titles.get(leftId)
    const right = titles.get(rightId)
    if (!left || !right) return null
    const leftChord = bindings.get(leftId)?.[0]
    const rightChord = bindings.get(rightId)?.[0]
    // Pair label names the gesture, not the two commands: "Focus Lane", with
    // both chords, reads as one idea — the slot table's whole intent.
    const gesture = pairGesture(left, right)
    const chord = leftChord && rightChord
      ? `${displayKeybinding(leftChord)} / ${displayKeybinding(rightChord)}`
      : leftChord ? displayKeybinding(leftChord) : null
    return { key: `${leftId}:${rightId}`, label: gesture, chord }
  }
  const reserved = reservedInteractionBindings(slot.reservationOwner)
  // The digit grammar owns ⌘1..⌘9; show the RANGE, because that is how it is
  // spoken ("⌘1–9"), while the chord strings stay in the table where the
  // collision checker sees them.
  const chord = reserved.length > 0 ? '⌘1–9' : null
  return { key: slot.reservationOwner, label: slot.label, chord }
}

/**
 * The words two paired titles share: "Focus Lane Left" + "Focus Lane Right"
 * gives "Focus Lane", and "Select Previous Agent" + "Select Next Agent" gives
 * "Select Agent".
 *
 * WHY word-by-word, not a trailing-direction regex: the regex only stripped a
 * LAST word, and the index-walk titles put the direction in the middle, so the
 * empty-lane card read "Select Previous Agent ⌥↑ / ⌥↓" (#1013 review B).
 * Titles of different lengths share no positional words to compare, so they
 * fall back to the left title as written.
 */
function pairGesture(left: string, right: string): string {
  const a = left.split(' ')
  const b = right.split(' ')
  if (a.length !== b.length) return left
  const shared = a.filter((word, index) => word === b[index])
  return shared.length > 0 ? shared.join(' ') : left
}

export function StarterHintCard({ variant }: { variant: 'fresh-agent' | 'empty-lane' }) {
  // LIVE bindings, read through the same store the router's index is built
  // from: defaults + the user's persisted overrides. Extension-contributed
  // defaults are deliberately absent — no extension can contribute to these
  // slots, and folding them in would couple the card to the extension store
  // for nothing.
  // `state.settings?.` — optional-chained for the same reason PaneHeader's
  // store reads are: test harnesses (and the phone stub) mount components
  // against a minimal store without the settings slice, and a card that
  // throws there would fail every layout suite it renders inside. Degrading
  // to "no overrides" shows the shipped defaults, which is true in exactly
  // those contexts.
  const overrides = useAppStore(useShallow(state => state.settings?.commandKeybindingOverrides ?? {}))
  const rows = useMemo<CardRow[]>(() => {
    // Titles here are the STATIC ones. A function title (dynamic, per-context
    // label) has no meaning on a context-free card; dropping it fails the
    // card's own tests loudly rather than rendering a function reference.
    // Every slot commands a static title today.
    const titles = new Map<string, string>()
    for (const command of builtInCommandCatalog) {
      if (typeof command.title === 'string') titles.set(command.id, command.title)
    }
    const bindings = new Map(
      resolveEffectiveKeybindings(overrides).map(entry => [entry.commandId, entry.bindings]),
    )
    const slots = variant === 'fresh-agent' ? FRESH_AGENT_SLOTS : EMPTY_LANE_SLOTS
    return slots.flatMap(slot => {
      const row = buildRow(slot, titles, bindings)
      return row ? [row] : []
    })
  }, [overrides, variant])

  return (
    <div
      data-starter-card={variant}
      className="mx-2 mb-1 rounded-control border border-border bg-surface-hi px-2 py-1.5 text-[10px] leading-relaxed text-muted"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
        {rows.map(row => (
          <span key={row.key} className="flex items-baseline gap-1.5 whitespace-nowrap">
            {row.chord ? (
              // The shared chip (plan H1): this was the last hand-drawn <kbd>.
              // aria-hidden={false}: here the key IS the information.
              <Kbd aria-hidden={false}>{row.chord}</Kbd>
            ) : null}
            <span>{row.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
