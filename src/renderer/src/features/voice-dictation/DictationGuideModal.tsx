import { useEffect, useState } from 'react'

import { DialogActions } from '@renderer/components/ui/dialog-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

// Modal walking the user through Deepgram signup + key configuration.
//
// WHY the guide is a modal (not a full-screen route):
//
//   Agent Code's routing surface is the tile tree, not a browser router.
//   Adding a top-level "page" concept purely for this guide would make
//   the tile tree grow accidental sibling states. A modal is dismissible,
//   fully local, and reuses the same overlay stack every other Agent Code
//   command modal uses.
//
// WHY this is a `DialogContent` and no longer a hand-rolled overlay:
//
//   This file used to implement its own Escape handler, its own Tab focus
//   trap, its own `fixed inset-0` backdrop, its own focus restoration, and it
//   copied `data-agent-code-interaction-owner="app"` onto its root by hand.
//   components/ui/README.md forbids every one of those by name — they are
//   properties of DialogContent, not properties each feature reinterprets, and
//   this was the last hand-rolled app modal in the tree.
//
//   The hand-rolled trap was also subtly wrong in a way Radix's FocusScope is
//   not: it queried focusable nodes once per keydown off a static selector, so
//   the `<a>` links inside the guide body participated but anything mounted
//   into a nested portal would not have. Deleting it removes the divergence
//   rather than fixing it twice.
//
//   The one behaviour deliberately NOT carried over is the window-capture
//   swallow of Cmd/Option chords. That existed because a hand-rolled overlay
//   has no way to tell the workspace shortcut router "an app surface owns the
//   turn". DialogContent mounts the ownership marker for exactly its own
//   lifetime, and the router already checks that marker synchronously, so the
//   chord suppression is now structural instead of a second listener racing
//   the first.
//
// WHY placeholder screenshots instead of committed assets:
//
//   The user has final say on which screenshots ship — they will match a
//   specific Deepgram UI snapshot, and swapping them later is a one-file
//   asset change under `docs/screenshots/dictation/`. Placeholder frames
//   keep the layout obviously incomplete instead of "silently missing".
export function DictationGuideModal() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener('agent-code:open-dictation-guide', onOpen)
    return () => window.removeEventListener('agent-code:open-dictation-guide', onOpen)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Wider than the 520px default and height-capped: this is three
          illustrated steps rather than a confirm prompt, so the body scrolls
          inside the dialog instead of letting the surface grow past the
          viewport. */}
      <DialogContent className="w-[min(672px,92vw)] max-h-[88vh] grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>Configure Voice Dictation</DialogTitle>
          <DialogDescription>
            Agent Code's inline dictation streams audio to Deepgram for
            transcription. New Deepgram accounts get $200 in free credits, which
            is generally enough for very long-term personal use.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-4 py-4 text-[12px] leading-relaxed">
          <GuideStep
            number={1}
            title="Create a Deepgram account"
            body={
              <>
                Open{' '}
                <a
                  href="https://console.deepgram.com/signup"
                  className="text-accent underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  console.deepgram.com/signup
                </a>{' '}
                and finish the signup — the $200 credit is applied automatically.
              </>
            }
            screenshotAlt="Screenshot: Deepgram signup page with the sign-up form highlighted"
          />

          <GuideStep
            number={2}
            title="Create a project API key"
            body={
              <>
                From the console, open <span className="font-mono">API Keys</span>{' '}
                in the sidebar, click <span className="font-mono">Create a New API Key</span>,
                give it the scope <span className="font-mono">Member</span> or
                broader, copy the string that appears once (Deepgram will never
                show it again).
              </>
            }
            screenshotAlt="Screenshot: Deepgram API Keys page with the Create Key modal open"
          />

          <GuideStep
            number={3}
            title="Paste the key into Settings"
            body={
              <>
                In Agent Code, open{' '}
                <span className="font-mono">Settings → Voice Dictation</span>,
                paste the key into the <span className="font-mono">Deepgram API Key</span>{' '}
                row, and press <span className="font-mono">Save</span>. Your key
                is encrypted with your system keyring — Agent Code never writes
                it to disk in plaintext.
              </>
            }
            screenshotAlt="Screenshot: Agent Code Voice Dictation settings row with a masked API key"
          />

          <div className="rounded-slab border border-border bg-panel/40 px-3 py-2 text-[11px] text-muted">
            <p className="mb-1 font-semibold text-ink">A note on the hotkey.</p>
            <p>
              Dictation is triggered with{' '}
              <span className="font-mono">Cmd+Shift+D</span> by default: press once
              to record and again to finish, with no OS permission required. If
              you prefer holding <span className="font-mono">Fn</span>{' '}
              like macOS system dictation, switch the shortcut in Settings; macOS
              will then prompt for Accessibility permission the first time you
              enable dictation.
            </p>
          </div>
        </div>

        {/* Acknowledgement-only footer: there is nothing to cancel, so this is
            the confirm-only shape DialogActions supports via omitting
            onCancel. confirmOnEnter stays on — the body is prose and links,
            nothing in it owns Enter. */}
        <DialogActions confirmLabel="Done" onConfirm={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function GuideStep({
  number,
  title,
  body,
  screenshotAlt,
}: {
  number: number
  title: string
  body: React.ReactNode
  screenshotAlt: string
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="rounded-control flex h-5 w-5 items-center justify-center border border-accent bg-accent/10 text-[11px] text-accent">
          {number}
        </span>
        {title}
      </h3>
      <p className="text-ink/90">{body}</p>
      {/* Screenshot placeholder — replace the src with the committed asset
          once the user drops the annotated PNG under
          docs/screenshots/dictation/. Keeping this as a semantic
          placeholder means the layout is honest about the pending
          content instead of pretending completeness. */}
      <div
        role="img"
        aria-label={screenshotAlt}
        className="rounded-slab
          flex h-32 w-full items-center justify-center
          border border-dashed border-border bg-panel/40
          text-[10px] uppercase tracking-wider text-muted
        "
      >
        Screenshot placeholder — replace before release
      </div>
    </section>
  )
}
