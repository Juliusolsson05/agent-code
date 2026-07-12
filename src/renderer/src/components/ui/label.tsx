import * as LabelPrimitive from '@radix-ui/react-label'
import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/label. Radix preserves
// native label activation while composing cleanly with custom controls.
const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    data-slot="label"
    className={cn(
      'text-[11px] leading-none text-muted peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
