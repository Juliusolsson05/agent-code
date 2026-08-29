import { useCallback, useEffect, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'

// Dismissible "Configure Voice Dictation" card shown above the tab bar
// when dictation is unconfigured — regardless of whether the user has
// toggled it on. The card exists so packaged-app users learn a
// discoverable path from "app just opened" to "dictation works",
// without us dropping an Accessibility permission prompt on first launch
// or requiring the user to know about the DEEPGRAM_API_KEY env var.
//
// WHY the card lives here and not in the SetupGate:
//
//   SetupGate is a hard gate — the app is unusable until it passes. That
//   is correct for missing Claude/Codex binaries; it is not correct for
//   a missing Deepgram key. The user must be able to open Agent Code
//   without a Deepgram account, and only see this card as a soft nudge.
//
// WHY the dismissal state lives in localStorage keyed by
// `agent-code:dictation-configure-card:v1`:
//
//   The settings blob is the source of truth for actual behaviour
//   (enabled/disabled/shortcut/provider); it is not the right home for
//   UI dismissal noise. Bundling this dismissal into settings would make
//   every "reset to defaults" un-dismiss the card, which is confusing.
//   Bumping the `:v1` suffix on a future material update re-shows the
//   card exactly once per user, without needing a migration.

const DISMISSAL_KEY = 'agent-code:dictation-configure-card:v1'
type DismissalMode = 'never' | 'this-run' | 'shown-when-unconfigured'

function readDismissal(): DismissalMode {
  try {
    const raw = window.localStorage.getItem(DISMISSAL_KEY)
    if (raw === 'never') return 'never'
  } catch {
    // Restricted contexts: fall through — the card renders every launch,
    // which is exactly the "we cannot remember your choice" degrade.
  }
  return 'shown-when-unconfigured'
}

function persistDismissal(mode: 'never' | 'this-run'): void {
  if (mode === 'never') {
    try {
      window.localStorage.setItem(DISMISSAL_KEY, 'never')
    } catch {
      /* best-effort */
    }
  }
}

export function ConfigureDictationCard() {
  const settings = useAppStore(state => state.settings)
  const [status, setStatus] = useState<'unknown' | 'configured' | 'unconfigured'>(
    'unknown',
  )
  const [dismissed, setDismissed] = useState<DismissalMode>(() => readDismissal())
  const [runDismissed, setRunDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api
      .getDictationApiKeyStatus()
      .then(result => {
        if (cancelled) return
        setStatus(result.configured ? 'configured' : 'unconfigured')
      })
      .catch(() => {
        if (cancelled) return
        // Treat an IPC failure as 'unconfigured' — worst case the card
        // shows and the user can still click into settings.
        setStatus('unconfigured')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openGuide = useCallback(() => {
    // Dispatch a well-known custom event the shell listens for; the shell
    // owns the modal stack so a feature module cannot break the app-wide
    // z-order contract. See handleOpenDictationGuide in App.tsx.
    window.dispatchEvent(new CustomEvent('agent-code:open-dictation-guide'))
  }, [])

  if (status !== 'unconfigured') return null
  if (dismissed === 'never') return null
  if (runDismissed) return null
  // Once dictation is toggled OFF explicitly by the user we don't re-nag
  // unless they haven't dismissed the card yet. Wispr-Flow-style pestering
  // in an IDE is worse than silence.
  if (!settings.dictationEnabled && dismissed !== 'shown-when-unconfigured') return null

  return (
    <div
      role="status"
      className="
        flex items-start gap-3 px-3 py-2
        border-b border-border bg-accent/10 text-ink
        text-[11px] leading-snug font-code
        flex-shrink-0
      "
    >
      <span className="font-semibold uppercase tracking-wide text-accent">
        Voice dictation
      </span>
      <span className="flex-1 text-ink/90">
        Add a Deepgram API key to enable inline voice dictation. Deepgram gives
        every new account $200 in free credits — enough to last most users a long time.
      </span>
      <button
        type="button"
        onClick={openGuide}
        className="rounded-control border border-accent px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
      >
        Show me how
      </button>
      <button
        type="button"
        onClick={() => setRunDismissed(true)}
        className="text-muted hover:text-ink"
        title="Hide until next launch"
      >
        Later
      </button>
      <button
        type="button"
        onClick={() => {
          persistDismissal('never')
          setDismissed('never')
        }}
        className="text-muted hover:text-ink"
        title="Don't show this again"
      >
        Don't show again
      </button>
    </div>
  )
}
