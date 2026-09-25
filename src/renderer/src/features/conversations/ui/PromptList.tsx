import { relativeTime } from '@renderer/lib/relativeTime'

// The prompt list behind View Prompts and Rewind to Prompt. Uncapped on
// purpose (the user, 2026-09-11: "capping the view prompts command is just
// pure stupid"): a few hundred rows of one-line cards render fine without
// virtualisation, and a cap silently hid the prompt the user was looking for.
// Relative time is the primary label because "3h ago" is how people remember
// their own afternoon; the absolute time stays on hover.

export function formatPromptTime(timestamp: number | null): { relative: string; absolute: string | null } {
  if (timestamp === null || !Number.isFinite(timestamp)) return { relative: 'unknown time', absolute: null }
  return {
    relative: relativeTime(timestamp),
    absolute: new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  }
}

/**
 * Two modes, and the ARIA must match the mode (keyboard-first plan S7/S8):
 *
 * - Read-only (View Prompts: no `nav`): a plain `list` of `listitem`s. The
 *   scroller around it is the keyboard target and scrolls natively.
 * - Interactive (Rewind to Prompt: `nav` given): a `listbox` of `option`s.
 *   The LISTBOX is the focus owner and carries aria-activedescendant
 *   (focus-owner invariant, lib/useListNavigation). Before this, the rows
 *   were `listitem`s with `aria-selected` — an attribute a listitem does not
 *   support, so the highlight was announced as nothing — and focus sat on the
 *   scroller, which carried no active-descendant at all.
 *
 * WHY flat divided rows and not the old rounded-slab cards: every other list
 * in the app is flat rows with the one row-highlight treatment (plan T7), and
 * the house rule is "no cards". The prompt TEXT still wraps in full — only
 * the chrome around it changed.
 */
export function PromptList({ prompts, emptyMessage, nav, listRef, label }: {
  /** Newest first: row 0 is numbered `prompts.length`, the last row `#1`. */
  prompts: ReadonlyArray<{ text: string; timestamp: number | null }>
  emptyMessage: string
  /** Interactive mode: the list navigation from useListNavigation. */
  nav?: {
    index: number
    activeId: string | undefined
    getItemProps: (index: number) => Record<string, unknown>
  }
  listRef?: React.Ref<HTMLUListElement>
  label?: string
}) {
  if (prompts.length === 0) return <div className="py-8 text-center text-[12px] text-muted">{emptyMessage}</div>
  return (
    <ul
      ref={listRef}
      className="rounded-slab flex flex-col overflow-hidden border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
      role={nav ? 'listbox' : 'list'}
      aria-label={label}
      aria-activedescendant={nav?.activeId}
      // One Tab stop in interactive mode (plan K4); read-only lists are not a
      // stop of their own — their scroller is.
      tabIndex={nav ? 0 : undefined}
    >
      {prompts.map((prompt, index) => {
        const time = formatPromptTime(prompt.timestamp)
        const selected = nav?.index === index
        return (
          <li
            key={`${prompt.timestamp ?? 'unknown'}:${index}`}
            {...(nav ? nav.getItemProps(index) : {})}
            role={nav ? 'option' : 'listitem'}
            aria-selected={nav ? selected : undefined}
            data-prompt-index={index}
            className={`border-b border-l-2 border-border px-3 py-2 last:border-b-0 ${selected ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent'} ${nav ? 'cursor-pointer hover:bg-row-hover-bg' : ''}`}
          >
            <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.12em] text-muted">
              <span>#{prompts.length - index}</span>
              <span title={time.absolute ?? undefined}>{time.relative}</span>
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">{prompt.text}</div>
          </li>
        )
      })}
    </ul>
  )
}
