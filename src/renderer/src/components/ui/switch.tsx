import * as React from 'react'

import { cn } from '@renderer/lib/utils'

/**
 * An on/off switch for a list row: a skill, an MCP server, a provider.
 *
 * WHY a primitive (UI pass, G-34): the sweep found three looks for one idea.
 * - MCP servers and Skills each hand-rolled the same 12×20 pill with no knob.
 *   Only the fill changed, so the state was carried by colour alone, and only
 *   MCP's copy had the focus ring.
 * - Provider enablement was a chip reading a lowercase "on"/"off", painted
 *   `text-ink` on the accent fill. That is the wrong foreground: `accent-fg`
 *   is the one guaranteed to read on the accent.
 *
 * The knob gives the state a POSITION as well as a fill, so it reads in
 * greyscale and to anyone who can't tell the accent from the off border.
 *
 * WHY `rounded-chip` and not `rounded-full`: the track is a corner, not a
 * circle by geometry, so it follows the user's corner style (square at the
 * Sharp tier) like every other control. The dots that stay round on purpose
 * (streaming, dictation) are circles by geometry and are documented as such.
 *
 * The settings page's row toggle is NOT this. It is a full-width row control
 * that spells out Enabled/Disabled (plan N14), a different job.
 *
 * Space and Enter toggle natively, because it is a real <button>.
 */
export const Switch = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'onChange'> & {
    checked: boolean
    onCheckedChange: (next: boolean) => void
  }
>(({ checked, onCheckedChange, className, onClick, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="switch"
    aria-checked={checked}
    data-slot="switch"
    data-state={checked ? 'on' : 'off'}
    onClick={event => {
      onClick?.(event)
      if (!event.defaultPrevented) onCheckedChange(!checked)
    }}
    className={cn(
      'inline-flex h-3.5 w-6 shrink-0 items-center rounded-chip border p-px transition-colors outline-none',
      'focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
      'disabled:cursor-not-allowed disabled:opacity-50',
      checked ? 'border-control-active-bg bg-control-active-bg' : 'border-control-border bg-transparent',
      className,
    )}
    {...props}
  >
    <span
      aria-hidden="true"
      className={cn(
        'block size-2.5 rounded-chip transition-transform',
        checked ? 'translate-x-2.5 bg-control-active-fg' : 'translate-x-0 bg-control-border-hover',
      )}
    />
  </button>
))
Switch.displayName = 'Switch'
