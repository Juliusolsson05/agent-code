import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/button.
// Agent Code keeps the familiar API but maps it onto the app's dense,
// square, semantic-token visual language instead of shadcn's default theme.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border font-code font-medium transition-colors outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-accent bg-accent text-accent-fg hover:brightness-110',
        secondary: 'border-border bg-surface-hi text-ink hover:border-border-hi',
        outline: 'border-border bg-transparent text-ink-dim hover:border-border-hi hover:text-ink',
        ghost: 'border-transparent bg-transparent text-ink-dim hover:bg-control-hover-bg hover:text-ink',
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
