import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/input. The behavior is
// intentionally native; only Agent Code's semantic tokens and density differ.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full rounded-control border border-input-border bg-input-bg px-3 py-1 font-code text-[12px] text-ink outline-none transition-colors placeholder:text-input-placeholder focus-visible:border-input-border-focus focus-visible:ring-1 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export { Input }
