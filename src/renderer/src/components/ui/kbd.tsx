import * as React from 'react'

import { cn } from '@renderer/lib/utils'
import { displayKeybinding, type Keybinding } from '@shared/keybindings'

// Adapted from https://ui.shadcn.com/docs/components/kbd (Kbd + KbdGroup).
//
// WHY one primitive: before this file the app drew key hints five different
// ways — a bare unstyled <kbd> (Pin Agents), a rounded-chip <kbd> at 9px
// (StarterHintCard), a rounded-chip <span> in font-mono (Keyboard Shortcuts),
// a rounded-control button chip (Commands & Shortcuts editor) and plain muted
// text (the palette). The keyboard-first pass puts a chip on nearly every
// action in the app, so a sixth hand-rolled recipe per surface is exactly the
// drift this exists to stop. Every key hint renders through `Kbd`.
//
// WHY `rounded-chip`: the radius table in styles.css names keycaps as `chip`
// (non-interactive, content-sized label). A chip is never interactive, which
// is also why this is a <kbd> and never a button — a clickable chip would be a
// second control competing with the button it labels.
//
// WHY `binding` takes the CANONICAL form ("Cmd+Shift+P") and formats it here
// rather than accepting pre-formatted glyphs: `displayKeybinding` is the one
// presentation projection of a binding (see its doc — a display string that
// became a second source of truth was the original audit finding). Callers
// that show a rebindable command's chord pass the resolved canonical binding,
// so a user override shows up here automatically. Literal children remain for
// the few hints that are not a single binding: ranges ("⌘1–9") and fixed
// interaction keys spelled out ("↑↓").
//
// WHY `aria-hidden` by default: a chip almost always sits next to text that
// already names the action ("Cancel"), and it is the button's accessible name
// that a screen reader should announce, not "Cancel escape". A standalone hint
// whose key IS the information (a legend entry) passes `aria-hidden={false}`.

type KbdTone = 'default' | 'onAccent'

type KbdProps = Omit<React.ComponentProps<'kbd'>, 'children'> & {
  /** Canonical binding, e.g. `Cmd+Shift+P`, rendered via displayKeybinding. */
  binding?: Keybinding
  children?: React.ReactNode
  /**
   * `onAccent` for a chip INSIDE a filled button (default/destructive
   * variants). The resting chip's surface-hi fill would punch a dark hole in
   * an accent button; on a filled button the chip instead inherits the
   * button's foreground and only draws a translucent frame, so the hint reads
   * as part of the button rather than a sticker on it.
   */
  tone?: KbdTone
}

const toneClasses: Record<KbdTone, string> = {
  default: 'border-border bg-surface-hi text-muted',
  onAccent: 'border-current/30 bg-transparent text-current opacity-80',
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ binding, children, tone = 'default', className, ...props }, ref) => (
    <kbd
      ref={ref}
      data-slot="kbd"
      aria-hidden
      {...props}
      className={cn(
        // h-4 / 10px: sized to sit inside a `sm` (h-7, 11px) button without
        // changing its height — the chip must never be the reason a footer
        // grows. min-w-4 keeps single glyphs (⎋, ↩) square instead of slivers.
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-chip border px-1 font-code text-[10px] font-normal leading-none tracking-normal',
        toneClasses[tone],
        className,
      )}
    >
      {binding !== undefined ? displayKeybinding(binding) : children}
    </kbd>
  ),
)
Kbd.displayName = 'Kbd'

/**
 * Several chips read as one gesture: `↑↓`, or `⌘[` `⌘]`. The group only owns
 * the gap so every legend spaces its chips identically.
 */
function KbdGroup({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    />
  )
}

type KbdLegendItem = {
  /** Canonical bindings (`Up`, `Space`, `Cmd+A`) or literal glyph strings. */
  keys: readonly string[]
  /** Lowercase verb: `move`, `toggle`, `back`. */
  label: string
}

/**
 * The one-line key legend for keys that have no button (H3 in the
 * keyboard-first plan). Rendered by DialogActions' `legend` slot, and by the
 * non-dialog surfaces (placement overlay, palette) that have the same need.
 *
 * WHY items are data and not free JSX: every legend in the app must look
 * identical — same chip, same gap, same verb case — and five hand-written
 * prose legends ("↑↓ choose · Enter switch · Esc cancel") are exactly what
 * this replaces. A `keys` entry that parses as a canonical binding is
 * formatted through displayKeybinding (so `Up` → ↑); anything else is shown
 * literally, which is how a range like `⌘1–9` stays expressible.
 *
 * The legend is NOT aria-hidden as a whole: unlike a chip on a labelled
 * button, here the key is the information. Each item is a single text run
 * ("↑ ↓ move") for a screen reader.
 */
function KbdLegend({
  items,
  className,
}: {
  items: readonly KbdLegendItem[]
  className?: string
}) {
  return (
    <span data-slot="kbd-legend" className={cn('inline-flex min-w-0 items-center gap-3', className)}>
      {items.map(item => (
        <span key={`${item.keys.join('+')}:${item.label}`} className="inline-flex shrink-0 items-center gap-1">
          <KbdGroup>
            {item.keys.map(key => (
              <Kbd key={key} aria-hidden={false} binding={key} />
            ))}
          </KbdGroup>
          <span>{item.label}</span>
        </span>
      ))}
    </span>
  )
}

export { Kbd, KbdGroup, KbdLegend }
export type { KbdLegendItem }
export type { KbdProps }
