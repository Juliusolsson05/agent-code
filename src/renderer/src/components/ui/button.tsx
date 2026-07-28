import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/button.
// Agent Code keeps the familiar API but maps it onto the app's dense,
// square, semantic-token visual language instead of shadcn's default theme.
//
// WHY `outline` and `ghost` name the `control-*` tokens and not the tokens
// those happen to alias to:
//
//   styles.css defines the control family as aliases —
//   `--theme-control-bg: transparent`, `--theme-control-border:
//   var(--theme-border)`, `--theme-control-fg: var(--theme-ink-dim)`. So
//   writing `border-border bg-transparent text-ink-dim` (what this file used
//   to do) renders identically under every built-in theme, and looked fine
//   forever.
//
//   It is not fine, because customAppearance.ts exposes all seven `control-*`
//   tokens as INDEPENDENTLY user-editable, documented as button chrome
//   ("Resting button/toggle/select background", "Resting control text/icon
//   color"), and applyCustomAppearance writes them as inline custom properties
//   on <html> where they outrank the [data-mode] blocks. A user who edits
//   controlFg used to get every hand-rolled control button in the tree
//   honouring it while every <Button> silently ignored it — which made this
//   primitive LESS theme-correct than the ad-hoc markup it exists to replace,
//   and is the most plausible reason adoption stalled at 17 files.
//
//   NumberInput (number-input.tsx) already builds its steppers on `control-*`.
//   Before this change a single DialogActions footer could render a `ghost`
//   Cancel on ink-dim beside a NumberInput stepper on control-fg: two token
//   families in one control strip.
//
// WHY `default`, `destructive`, and `link` are NOT retokenized: they are accent
// and danger chrome, not control chrome, and the control family has no
// equivalent for them.
//
// WHY `secondary` is NOT retokenized: it is the filled/raised treatment, and
// there is no `control-*` token meaning "raised resting". `controlActiveBg`
// means SELECTED, which is a different state — mapping secondary onto it would
// invent a meaning the theme schema does not have.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border font-code font-medium transition-colors outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-accent bg-accent text-accent-fg hover:brightness-110',
        secondary: 'border-border bg-surface-hi text-ink hover:border-border-hi',
        // `hover:bg-control-hover-bg` is new relative to the pre-retokenization
        // `outline`, which had no hover fill. It matches what the 25
        // hand-rolled control-button call sites already paint, so migrating
        // them onto this variant converges the two looks rather than splitting
        // them again.
        outline:
          'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink',
        ghost:
          'border-transparent bg-transparent text-control-fg hover:bg-control-hover-bg hover:text-ink',
        destructive: 'border-danger bg-danger text-danger-fg hover:brightness-110',
        link: 'border-transparent bg-transparent text-accent underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 text-[12px]',
        xs: 'h-6 px-2 text-[10px]',
        sm: 'h-7 px-2.5 text-[11px]',
        lg: 'h-9 px-4 text-[13px]',
        icon: 'size-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    // WHY `asChild` is retained even though the first consumers are ordinary
    // buttons: it is part of the recognizable shadcn composition contract and
    // prevents future link-shaped actions from nesting a button inside an
    // anchor. Slot changes the host element without inventing another wrapper.
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
export type { ButtonProps }
