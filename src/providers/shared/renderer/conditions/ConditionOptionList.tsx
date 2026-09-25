import { forwardRef, useId } from 'react'

import { Kbd, KbdLegend } from '@renderer/components/ui/kbd'

/**
 * The option list inside an inline provider condition strip (Claude's resume
 * prompt, Codex's command approval), plus its key legend.
 *
 * WHY one shared component: the two strips were copy-pasted `div onClick`
 * rows with a prose "Press enter to confirm or esc to cancel" footer. Neither
 * list had option semantics, so a screen reader heard a block of text and
 * never the highlighted choice (ledger N16).
 *
 * Ownership contract, unchanged from before and still owned by the CALLER:
 * - the strip's onKeyDown forwards ↑↓↩⎋ (and Codex's y/p/n) to the PTY, and
 *   the agent's TUI moves its own highlight. `selectedIndex` mirrors what the
 *   screen parser read back, so this list never owns selection;
 * - key events from this focused list bubble to that handler, so moving focus
 *   from the strip to the list costs no key routing.
 *
 * Focus owner (plan k2): the listbox holds DOM focus and carries
 * aria-activedescendant. The strip keeps role="group" because it also holds
 * the title, reason and command, which cannot be children of a listbox.
 */
export type ConditionOption = {
  label: string
  /** Canonical binding shown as a chip on the row: Codex's `Y` / `P` /
   *  `Escape` shortcuts. Omit when the row has no direct key. */
  shortcut?: string
}

type Props = {
  label: string
  options: readonly ConditionOption[]
  selectedIndex: number
  /** The TUI's own selection marker (`❯` for Claude, `›` for Codex), kept so
   *  the strip still reads as the agent's prompt rather than our dialog. */
  marker: string
  onChoose: (index: number) => void
}

export const ConditionOptionList = forwardRef<HTMLDivElement, Props>(function ConditionOptionList(
  { label, options, selectedIndex, marker, onChoose },
  ref,
) {
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const active = selectedIndex >= 0 && selectedIndex < options.length ? selectedIndex : -1

  return (
    <>
      <div
        ref={ref}
        role="listbox"
        aria-label={label}
        // tabIndex 0, not -1: the strip used to be focusable ONLY by the
        // mount effect, so a user who tabbed away from a pending approval
        // could never tab back to it.
        tabIndex={0}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        className="-mx-1 mb-2 flex flex-col gap-0.5 rounded-control px-1 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        {options.map((option, index) => {
          const selected = index === active
          return (
            <div
              key={index}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              className={`flex cursor-pointer items-center gap-1.5 ${selected ? 'text-ink' : 'text-ink-dim hover:text-ink'}`}
              onClick={() => onChoose(index)}
            >
              <span aria-hidden="true" className={`select-none ${selected ? 'text-accent' : 'text-transparent'}`}>
                {marker}
              </span>
              <span className="min-w-0">
                {index + 1}. {option.label}
              </span>
              {option.shortcut ? <Kbd binding={option.shortcut} /> : null}
            </div>
          )
        })}
      </div>
      {/* H3: keys with no button. Replaces the prose footer. The words are
          the same verbs every other legend in the app uses. */}
      <KbdLegend
        className="text-[10px] text-muted"
        items={[
          { keys: ['Up', 'Down'], label: 'move' },
          { keys: ['Enter'], label: 'confirm' },
          { keys: ['Escape'], label: 'cancel' },
        ]}
      />
    </>
  )
})
