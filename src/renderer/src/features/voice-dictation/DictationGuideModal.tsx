import { useCallback, useEffect, useRef, useState } from 'react'

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
// WHY placeholder screenshots instead of committed assets:
//
//   The user has final say on which screenshots ship — they will match a
//   specific Deepgram UI snapshot, and swapping them later is a one-file
//   asset change under `docs/screenshots/dictation/`. Placeholder frames
//   keep the layout obviously incomplete instead of "silently missing".
export function DictationGuideModal() {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener('agent-code:open-dictation-guide', onOpen)
    return () => window.removeEventListener('agent-code:open-dictation-guide', onOpen)
  }, [])

  const close = useCallback(() => setOpen(false), [])
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusFrame = requestAnimationFrame(() => dialogRef.current?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
        if (focusable.length === 0) {
          event.preventDefault()
          dialog.focus()
          return
        }
        const current = focusable.indexOf(document.activeElement as HTMLElement)
        const next = event.shiftKey
          ? current <= 0 ? focusable.length - 1 : current - 1
          : current === -1 || current === focusable.length - 1 ? 0 : current + 1
        event.preventDefault()
        event.stopPropagation()
        focusable[next]?.focus()
        return
      }
      // The workspace shortcut router listens on document capture. Capturing
      // app-owned Cmd/Option chords one level earlier (window) prevents a guide
      // opened above the workspace from splitting/closing panes underneath it.
      // Ordinary keys continue to the dialog; type/paste ingress is blocked by
      // the explicit ownership marker on the dialog root below.
      if (event.metaKey || event.altKey) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKey, { capture: true })
      previouslyFocused?.focus()
    }
  }, [open, close])

  if (!open) return null
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dictation-guide-title"
      data-agent-code-interaction-owner="app"
      className="
        fixed inset-0 z-[60] flex items-center justify-center
        bg-canvas/80 backdrop-blur-sm p-6
      "
      onClick={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="max-h-full w-full max-w-2xl overflow-y-auto border border-border bg-canvas text-ink shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="dictation-guide-title" className="text-[14px] font-semibold">
            Configure Voice Dictation
          </h2>
          <button
            type="button"
            onClick={close}
            className="text-[12px] text-muted hover:text-ink"
            aria-label="Close guide"
          >
            Close
          </button>
        </header>

        <div className="flex flex-col gap-6 px-4 py-4 text-[12px] leading-relaxed">
          <p>
            Agent Code's inline dictation streams audio to{' '}
            <span className="font-semibold">Deepgram</span> for transcription. New
            Deepgram accounts get $200 in free credits, which is generally enough
            for very long-term personal use. Follow the three steps below to get
            up and running.
          </p>

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

          <div className="border border-border bg-panel/40 px-3 py-2 text-[11px] text-muted">
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

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={close}
            className="border border-control-border bg-control-bg px-3 py-1 text-[12px] text-control-fg hover:text-ink"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
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
        <span className="flex h-5 w-5 items-center justify-center border border-accent bg-accent/10 text-[11px] text-accent">
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
        className="
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
