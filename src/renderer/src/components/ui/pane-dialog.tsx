import * as React from 'react'
import { createPortal } from 'react-dom'

import { PANE_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import { cn } from '@renderer/lib/utils'

// Pane-scoped dialogs (#713, keyboard-first plan X1).
//
// THE PROBLEM. Provider condition modals (trust this folder, permission
// prompts, OpenCode/Grok questions) rendered through the app's Radix Dialog.
// That means a body portal, a full-app scrim, focus trapped app-wide, the rest
// of the DOM aria-hidden, and the app interaction-owner marker, which stops
// every global router. So ONE background agent hitting a trust prompt took the
// whole application hostage: every other pane, the tab bar, the palette.
//
// THE SHAPE. The same `Dialog` / `DialogContent` / `DialogTitle` /
// `DialogDescription` the modals already use switch to a pane-scoped rendering
// when they are mounted inside a `PaneDialogHostProvider`. TileLeaf provides
// one around its condition outlet and nowhere else, so:
//   - no provider modal had to be rewritten, and a future condition view gets
//     pane scoping by being mounted in the outlet;
//   - the phone client, which mounts the same outlet with no host, keeps its
//     full-screen modal; on a phone the modal IS the whole screen.
//
// WHY NOT RADIX `modal={false}` (the first design): Radix's DismissableLayer
// listens for Escape on the DOCUMENT and calls `event.preventDefault()`
// whenever its layer is the topmost one, before it even asks whether the key
// was meant for it. A trust prompt in a BACKGROUND pane would then mark every
// Escape in the app as handled, and the active composer's key handler bails
// on `defaultPrevented` (useComposerKeybinds), so Escape-to-interrupt would
// silently die everywhere. Non-modal Radix also dismisses on focus-outside,
// which here means DECLINING the trust prompt the moment the user clicks
// another pane. Neither is patchable from outside the layer, so pane mode
// renders its own small dialog element with ONLY element-level handlers, and
// nothing listens at the document.
//
// KEYBOARD CONTRACT in pane mode:
//   - Escape closes (calls onOpenChange(false)) only while focus is INSIDE
//     the dialog, and it is handled on the element, so it can never be taken
//     from another pane.
//   - Focus moves in only when the owning pane is active (`active`), and
//     again whenever that pane becomes active later (the user navigated to
//     it). A background pane never steals focus. React's `autoFocus` would
//     steal it on mount regardless, which is why the modals mark their
//     initial control `data-autofocus` instead.
//   - When the dialog goes away while holding focus, focus returns through
//     `restoreFocus` (the pane's composer), not to <body>.
//   - Tab is not trapped. The rest of the app is live, and Tab out of the
//     dialog is how a keyboard user leaves a prompt unanswered, the way a
//     mouse user clicks another pane.
//   - The PANE interaction-owner marker (not the app one) tells this pane's
//     own routers (type-to-focus, paste-to-focus, composer Enter, and the
//     workspace router for unmodified keys) that a key aimed inside the
//     dialog belongs to the dialog. Modified chords stay live, so ⌥↓ still
//     leaves the pane.

/**
 * The pane's stacking levels while a pane dialog is up, as literal Tailwind
 * classes (Tailwind only emits classes it can see spelled out). ONE table so
 * the order cannot drift between files:
 *   scrim   covers the pane, including the composer it must not let you type into;
 *   content the dialog itself;
 *   feedback  the pane's own status toast. #713's second half was a refusal
 *           toast painted UNDER the modal scrim, so the one message that
 *           explained a failed click was unreadable. Feedback therefore sits
 *           above both. It occupies only its own strip, so the covered
 *           composer stays covered.
 */
export const PANE_DIALOG_LAYERS = {
  scrim: 'z-[60]',
  content: 'z-[61]',
  feedback: 'z-[62]',
} as const

export type PaneDialogHost = {
  /** The pane root the dialog portals into. It must be `position: relative`.
   *  Null until the pane has mounted. */
  container: HTMLElement | null
  /** True while the owning pane owns the workspace keyboard. */
  active: boolean
  /** Where focus goes when a focused pane dialog closes. */
  restoreFocus?: () => void
}

export const PaneDialogHostContext = React.createContext<PaneDialogHost | null>(null)

export function PaneDialogHostProvider({ children, ...host }: PaneDialogHost & { children: React.ReactNode }) {
  const value = React.useMemo<PaneDialogHost>(
    () => ({ container: host.container, active: host.active, restoreFocus: host.restoreFocus }),
    [host.container, host.active, host.restoreFocus],
  )
  return <PaneDialogHostContext.Provider value={value}>{children}</PaneDialogHostContext.Provider>
}

/** Per-dialog state the pane-mode Root hands its Content/Title/Description. */
export type PaneDialogState = {
  onOpenChange?: (open: boolean) => void
  titleId: string
  descriptionId: string
}

export const PaneDialogContext = React.createContext<PaneDialogState | null>(null)

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusInitial(root: HTMLElement) {
  const target =
    root.querySelector<HTMLElement>('[data-autofocus]')
    ?? root.querySelector<HTMLElement>(TABBABLE)
    ?? root
  target.focus()
}

type PaneDialogContentProps = React.HTMLAttributes<HTMLDivElement> & {
  host: PaneDialogHost
  pane: PaneDialogState
  sizeClassName: string
}

export const PaneDialogContent = React.forwardRef<HTMLDivElement, PaneDialogContentProps>(
  function PaneDialogContent({ host, pane, sizeClassName, className, children, onKeyDown, ...props }, forwardedRef) {
    const contentRef = React.useRef<HTMLDivElement | null>(null)
    const setRef = React.useCallback((node: HTMLDivElement | null) => {
      contentRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }, [forwardedRef])

    // Read through refs inside the rAF: the pane can lose ownership between
    // scheduling and the frame (a pane switch commits in between), and a stale
    // `active` would pull focus back into a pane the user just left.
    const activeRef = React.useRef(host.active)
    activeRef.current = host.active
    const restoreRef = React.useRef(host.restoreFocus)
    restoreRef.current = host.restoreFocus

    React.useEffect(() => {
      if (!host.active) return
      // rAF, not synchronous: TileLeaf's own "pane became focused → focus the
      // composer" effect runs AFTER this child effect in the same commit, and
      // would otherwise immediately take focus back to the composer that sits
      // under this dialog's scrim.
      const frame = requestAnimationFrame(() => {
        const el = contentRef.current
        if (!activeRef.current || !el || el.contains(document.activeElement)) return
        focusInitial(el)
      })
      return () => cancelAnimationFrame(frame)
    }, [host.active])

    // Whether focus is inside, tracked from focus events rather than read
    // from document.activeElement at unmount. A passive-effect cleanup runs
    // AFTER React has detached the node, so activeElement is already <body>
    // there (the first version checked contains() in the cleanup and never
    // restored anything). Browsers fire no blur when a focused node is
    // removed, so the flag still says true at that point.
    const holdsFocusRef = React.useRef(false)
    React.useEffect(() => () => {
      // Unmount while holding focus (the prompt was answered): hand focus to
      // the pane instead of letting it fall to <body>, where the next Tab
      // restarts from the top of the window.
      if (holdsFocusRef.current) restoreRef.current?.()
    }, [])

    if (!host.container) return null

    return createPortal(
      <>
        <div
          aria-hidden="true"
          data-slot="pane-dialog-scrim"
          // Inside the pane only. It sits over the composer so the prompt
          // cannot be typed past, while every other pane stays usable.
          className={cn('absolute inset-0 bg-overlay-scrim-strong', PANE_DIALOG_LAYERS.scrim)}
        />
        <div
          ref={setRef}
          role="dialog"
          aria-labelledby={pane.titleId}
          aria-describedby={pane.descriptionId}
          tabIndex={-1}
          data-slot="dialog-content"
          data-pane-dialog=""
          {...{ [PANE_INTERACTION_OWNER_ATTRIBUTE]: 'pane' }}
          {...props}
          onFocus={event => {
            holdsFocusRef.current = true
            props.onFocus?.(event)
          }}
          onBlur={event => {
            holdsFocusRef.current = contentRef.current?.contains(event.relatedTarget as Node | null) ?? false
            props.onBlur?.(event)
          }}
          onKeyDown={event => {
            onKeyDown?.(event)
            if (event.defaultPrevented || event.key !== 'Escape') return
            // Element-level, so this only ever sees an Escape pressed with
            // focus inside this dialog (see the header for why nothing here
            // may listen at the document).
            event.preventDefault()
            event.stopPropagation()
            pane.onOpenChange?.(false)
          }}
          className={cn(
            // Centred in the PANE (absolute, not fixed), and capped to it so a
            // narrow lane still shows the whole prompt, scrolling if it must.
            PANE_DIALOG_LAYERS.content,
            'absolute left-1/2 top-1/2 grid max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-float border border-border-hi bg-surface text-ink shadow-2xl outline-none',
            sizeClassName,
            className,
          )}
        >
          {children}
        </div>
      </>,
      host.container,
    )
  },
)
