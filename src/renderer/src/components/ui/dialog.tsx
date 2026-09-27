import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'

import { Kbd } from '@renderer/components/ui/kbd'
import {
  PaneDialogContent,
  PaneDialogContext,
  PaneDialogHostContext,
} from '@renderer/components/ui/pane-dialog'
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
// Inside a PaneDialogHostProvider (TileLeaf's condition outlet) the dialog is
// pane-scoped and Radix is not mounted at all: see pane-dialog.tsx for why
// Radix's document-level layer cannot be used there (#713). Everywhere else
// this is exactly Radix Root, as before.
//
// Pane mode supports the CONTROLLED shape the condition modals use (`open` +
// `onOpenChange`). `open === false` renders nothing; an uncontrolled
// `defaultOpen` dialog is not a pane-dialog use and is shown open.
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const host = React.useContext(PaneDialogHostContext)
  const titleId = React.useId()
  const descriptionId = React.useId()
  const { onOpenChange } = props
  const pane = React.useMemo(
    () => ({ onOpenChange, titleId, descriptionId }),
    [onOpenChange, titleId, descriptionId],
  )
  if (!host) return <DialogPrimitive.Root {...props} />
  if (props.open === false) return null
  return <PaneDialogContext.Provider value={pane}>{props.children}</PaneDialogContext.Provider>
}
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

// WHY width presets (keyboard-first plan T2): the sweep found ~20 distinct
// dialog widths (360, 380, 420, 440, 460, 500, 520, 560, 620, 640, 672, 720,
// 760, 780, 860, 880, 1040, 1240, 1360 px) plus `max-w-md/lg/xl/2xl` classes
// that silently did NOTHING against the base width — McpServerDialog asked
// for max-w-2xl and rendered at 520. Nobody chose twenty widths; each author
// picked a number. Four presets cover every real need:
//   sm      a question or a short form (confirmations, title prompt)
//   default the historical 520 — single-column pickers and forms
//   md      a list with detail (switch provider, history, prompt lists)
//   lg      a wide list/table (close old agents, bulk switch, skills)
//   xl      a workspace-sized surface (conversations, analytics)
// Full-viewport takeovers (Settings, Performance) still pass an explicit
// width with a WHY at the call site — they are sized to the window, not to
// content. Each preset carries a viewport cap (92vw for the narrow ones,
// 94vw for lg, 96vw for xl) that keeps it inside a narrow window.
// SHADOW (UI pass): the theme's shadow colour at a deeper spread than menus
// (16/48 vs 8/24), so a dialog reads as the higher layer. It was Tailwind's
// fixed black `shadow-2xl` while every menu and popover used the theme's.
// HEIGHT (UI pass, G-20): a dialog that scrolls inside caps itself at
// `max-h-[86vh]`, one value. The sweep found eight caps between 80 and 92vh,
// each picked by eye, so dialogs of the same kind ended at different heights.
// Not a DialogContent default: a dialog with no scrolling body would clip.
const dialogSizes = {
  sm: 'w-[min(440px,92vw)]',
  default: 'w-[min(520px,92vw)]',
  md: 'w-[min(640px,92vw)]',
  lg: 'w-[min(860px,94vw)]',
  xl: 'w-[min(1240px,96vw)]',
} as const

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  showCloseButton?: boolean
  size?: keyof typeof dialogSizes
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, showCloseButton = false, size = 'default', ...props }, ref) => {
  const host = React.useContext(PaneDialogHostContext)
  const pane = React.useContext(PaneDialogContext)
  if (host && pane) {
    // Radix-only props have no meaning without Radix's layer: outside
    // interaction never dismisses a pane dialog, Escape is element-level, and
    // initial focus follows `data-autofocus` (pane-dialog.tsx).
    const {
      onOpenAutoFocus: _openAutoFocus,
      onCloseAutoFocus: _closeAutoFocus,
      onEscapeKeyDown: _escape,
      onPointerDownOutside: _pointerOutside,
      onInteractOutside: _interactOutside,
      onFocusOutside: _focusOutside,
      forceMount: _forceMount,
      ...rest
    } = props
    return (
      <PaneDialogContent ref={ref} host={host} pane={pane} sizeClassName={dialogSizes[size]} className={className} {...rest}>
        {children}
      </PaneDialogContent>
    )
  }
  const { onOpenAutoFocus, ...contentProps } = props
  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      data-slot="dialog-content"
      {...contentProps}
      // `data-autofocus` names the initial control in BOTH modes. React's
      // `autoFocus` cannot be used by anything that may render pane-scoped:
      // it focuses on mount regardless, stealing focus from the pane the user
      // is actually in (pane-dialog.tsx). Radix's own default (first
      // tabbable) still applies when nothing is marked.
      onOpenAutoFocus={event => {
        onOpenAutoFocus?.(event)
        if (event.defaultPrevented) return
        const marked = (event.target as HTMLElement | null)?.querySelector?.<HTMLElement>('[data-autofocus]')
        if (!marked) return
        event.preventDefault()
        marked.focus()
      }}
      // WHY ownership lives on the primitive rather than every feature:
      // Content is mounted for exactly the interval in which Radix traps focus.
      // Global DOM and native-IPC input routers can synchronously query this
      // marker without mirroring open state into a second modal manager.
      {...{ [APP_INTERACTION_OWNER_ATTRIBUTE]: 'app' }}
      // WHY the column is `minmax(0,1fr)` instead of Grid's implicit `auto`:
      // dialogs routinely contain paths, command lines, and editors. An
      // unbroken descendant contributes a huge intrinsic minimum to an auto
      // track, so the direct child widens past this element's 92vw contract
      // and a nested `w-full` field faithfully follows it off-screen. Zeroing
      // the TRACK minimum lets the child shrink first; each child still owns
      // whether its content truncates, wraps, or scrolls.
      className={cn(
        'fixed left-1/2 top-1/2 z-[1100] grid grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 rounded-float border border-border-hi bg-surface text-ink shadow-[0_16px_48px_var(--theme-shadow-color)] outline-none',
        dialogSizes[size],
        // The corner `× ⎋` (below) sits over the header's right end, so the
        // header must leave room for it. Owned HERE (UI pass, G-20): five
        // dialogs reserved it by hand with pr-12 / pr-16 / pr-20, and two
        // reserved nothing, so their titles could run under the button.
        showCloseButton && '[&_[data-slot=dialog-header]]:pr-16',
        className,
      )}
    >
      {children}
      {showCloseButton ? (
        // WHY `× ⎋` and not a bare ×: the corner button is the mouse exit and
        // the chip tells a keyboard user the same exit is one key away — the
        // hint rule (plan H2) applied to the one close affordance every
        // corner-close dialog shares. rounded-control + the Button focus ring
        // (it used rounded-slab, the PLATE radius, and a hand-copied ring).
        <DialogPrimitive.Close
          className="rounded-control absolute right-3 top-2.5 inline-flex h-6 items-center gap-1.5 border border-transparent px-1.5 text-[14px] leading-none text-control-fg outline-none hover:bg-control-hover-bg hover:text-ink focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          <span aria-hidden="true">×</span>
          <Kbd binding="Escape" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPortal>
  )
})
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
>(({ className, asChild: _asChild, ...props }, ref) => {
  // Pane mode has no Radix context to register the title with, so the id the
  // pane dialog's aria-labelledby points at is applied here instead.
  const pane = React.useContext(PaneDialogContext)
  const host = React.useContext(PaneDialogHostContext)
  if (pane && host) {
    return <h2 ref={ref} id={pane.titleId} data-slot="dialog-title" className={cn('text-[13px] font-medium text-ink', className)} {...props} />
  }
  return (
    <DialogPrimitive.Title
      ref={ref}
      data-slot="dialog-title"
      className={cn('text-[13px] font-medium text-ink', className)}
      asChild={_asChild}
      {...props}
    />
  )
})
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, asChild: _asChild, ...props }, ref) => {
  const pane = React.useContext(PaneDialogContext)
  const host = React.useContext(PaneDialogHostContext)
  if (pane && host) {
    return <p ref={ref} id={pane.descriptionId} data-slot="dialog-description" className={cn('mt-1 text-[11px] text-muted', className)} {...props} />
  }
  return (
    <DialogPrimitive.Description
      ref={ref}
      data-slot="dialog-description"
      className={cn('mt-1 text-[11px] text-muted', className)}
      asChild={_asChild}
      {...props}
    />
  )
})
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
