import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'

import { APP_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import { cn } from '@renderer/lib/utils'

// Adapted from https://ui.shadcn.com/docs/components/dialog.
//
// WHY Radix is the dependency boundary: portal placement, nested focus traps,
// focus restoration, Escape arbitration, outside interaction, and accessible
// title/description relationships are browser behavior—not feature business
// logic. The previous modals each reimplemented a different subset and leaked
// input into agent panes. We locally own the styling/composition source while
// delegating those hard interaction mechanics to the focused primitive.
const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

const DialogPortal = DialogPrimitive.Portal

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      'fixed inset-0 z-[1100] bg-overlay-scrim-strong',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  showCloseButton?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, showCloseButton = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      data-slot="dialog-content"
      {...props}
      // WHY ownership lives on the primitive rather than every feature:
      // Content is mounted for exactly the interval in which Radix traps focus.
      // Global DOM and native-IPC input routers can synchronously query this
      // marker without mirroring open state into a second modal manager.
      {...{ [APP_INTERACTION_OWNER_ATTRIBUTE]: 'app' }}
      className={cn(
        'fixed left-1/2 top-1/2 z-[1100] grid w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 border border-border-hi bg-surface text-ink shadow-2xl outline-none',
        className,
      )}
    >
      {children}
      {showCloseButton ? (
        <DialogPrimitive.Close
          className="absolute right-3 top-3 border border-transparent px-1.5 py-0.5 text-[14px] leading-none text-muted outline-none hover:border-border hover:text-ink focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          <span aria-hidden="true">×</span>
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('border-b border-border px-4 py-3', className)}
      {...props}
    />
  )
}

// forwardRef, like DialogTitle/DialogDescription below: DialogActions needs a
// node inside the footer to find its own dialog root with `closest`, so it can
// scope its Enter listener to this dialog instead of the whole document.
const DialogFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="dialog-footer"
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border px-4 py-3',
        className,
      )}
      {...props}
    />
  ),
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn('text-[13px] font-medium text-ink', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn('mt-1 text-[11px] text-muted', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
export type { DialogContentProps }
