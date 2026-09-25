import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/dropdown-menu.
//
// WHY a headless primitive (keyboard-first plan D9; B7 concurred): every menu
// in the app was hand-rolled, and the two that failed a keyboard user failed
// completely — the Skills row ⋯ menu had no keyboard handling at all and
// closed on mouseLeave, and the Appearance menu never moved focus into
// itself, so Tab walked past it into the page. A correct menu needs focus
// entry, roving focus over items, typeahead, Escape that returns focus to the
// trigger, outside-dismissal, and correct layering when it opens INSIDE a
// Radix dialog (Settings). That is the same class of browser behaviour the
// README delegates to Radix for Dialog, so it is delegated the same way.
//
// WHY exactly `2.1.20` (package.json pins it without a caret): Radix pins its
// internal packages to exact versions, and react-dialog 1.1.19 uses
// dismissable-layer 1.1.15 / focus-scope 1.1.12 / portal 1.1.13 /
// primitive 2.1.7. dropdown-menu 2.1.20 is the release on the same train. A
// newer dropdown-menu drags in SECOND copies of dismissable-layer and
// focus-scope, and those keep module-level layer and focus stacks — two
// copies means a menu inside a dialog no longer knows it is the topmost
// layer, so Escape closes the dialog under the menu. Bump dialog and
// dropdown-menu TOGETHER, and check the lockfile has one copy of each.
//
// WHY z-[1150]: Settings, where the Skills menu lives, is a Dialog at
// z-[1100]. Portaled content at the same z would paint by DOM order, which
// works today by accident; the menu must be above any dialog it opens from.
// GlobalToast stays above (z-1200).
//
// Styling: the popover chrome converges on `bg-popover-bg
// border-popover-border` + the theme shadow token (plan T7/T1) — the sweep
// found three hard-coded rgba shadows and `shadow-lg` across the old menus.
// Items are `rounded-control` option rows; the highlight is the one row
// highlight token, `bg-row-selected-bg`.

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      data-slot="dropdown-menu-content"
      sideOffset={sideOffset}
      className={cn(
        'modal-pop z-[1150] min-w-[180px] overflow-hidden rounded-float border border-popover-border bg-popover-bg p-1 font-code text-ink shadow-[0_8px_24px_var(--theme-shadow-color)] outline-none',
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const itemBase =
  'relative flex w-full cursor-default select-none items-center gap-2 rounded-control px-2 py-1 text-left text-[11px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-row-selected-bg data-[highlighted]:text-ink'

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }
>(({ className, danger = false, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-slot="dropdown-menu-item"
    className={cn(itemBase, danger ? 'text-danger data-[highlighted]:text-danger' : 'text-ink-dim', className)}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    data-slot="dropdown-menu-checkbox-item"
    className={cn(itemBase, 'justify-between text-ink-dim', className)}
    {...props}
  >
    {children}
    {/* The box is always drawn so the row does not shift when toggled; the
        indicator only fills it. */}
    <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-border-hi">
      <DropdownMenuPrimitive.ItemIndicator className="h-full w-full bg-accent" />
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    data-slot="dropdown-menu-radio-item"
    className={cn(itemBase, 'text-ink-dim data-[state=checked]:text-ink', className)}
    {...props}
  />
))
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    data-slot="dropdown-menu-label"
    className={cn('px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted', className)}
    {...props}
  />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    data-slot="dropdown-menu-separator"
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
