import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/textarea. Resize policy
// stays caller-owned because a prompt editor and a fixed modal note field have
// legitimately different layout constraints.
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn(
      'min-h-20 w-full border border-input-border bg-input-bg px-3 py-2 font-code text-[12px] text-ink outline-none transition-colors placeholder:text-input-placeholder focus-visible:border-input-border-focus focus-visible:ring-1 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export { Textarea }
