import { useDictationOverlayState } from '@renderer/features/voice-dictation/dictationStatusStore'

// VoiceDictationOverlay — terminal-mode floating chip rendered at App root.
// Rendered Agent mode keeps the old inline composer mic affordance; only
// AgentTerminalLeaf publishes visible state to this store.
//
// WHY `rounded-float` and not the sharp rectangle this used to be: the
// original comment here explained that agent-code's design language banned
// border-radius app-wide, so flow-electron's rounded MicPill was flattened to
// match the chrome. That ban is gone — radius now marks DETACHMENT (styles.css
// hard rule 1), and a fixed-position chip floating over the terminal is the
// textbook case: it shares an edge with nothing and already carries a drop
// shadow saying so. At the Sharp tier it renders exactly as it always did.
//
// The chip keeps its information shape (energy bars, dots, short status text,
// optional preview) and every color stays `var(--theme-*)` via Tailwind
// utility classes — dark, light, custom, high-contrast all just work because
// the overlay never embeds raw hex.
//
// WHY position:fixed at bottom-center: matches the Whispr-Flow muscle memory
// the user asked for, and `position: fixed` escapes AgentTerminalLeaf's
// overflow-hidden xterm wrappers. We sit BELOW the command palette in z-index
// because the palette is a hard-modal that should always win when both are
// somehow open.

export function VoiceDictationOverlay() {
  const { status, levels, previewText, errorMessage, holdToTalk } = useDictationOverlayState()

  // Idle is the steady state. Rendering nothing keeps the DOM cost at zero
  // when the user isn't dictating; mounting empty would still cost a node
  // and one render per state transition on every App re-render.
  if (status === 'idle') return null

  const isRecording = status === 'recording'
  const isStarting = status === 'starting'
  const isStopping = status === 'stopping'
  const isError = status === 'error'

  const labelText = isError
    ? truncateError(errorMessage)
    : isStopping
      ? 'transcribing…'
      : isStarting
        ? 'starting…'
        : holdToTalk
          ? 'hold to dictate · release to paste'
          : 'press shortcut again to finish'

  return (
    <div
      className={`
        pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2
        flex items-center gap-3 rounded-float border bg-surface px-3 py-2
        font-code text-[11px] leading-none
        ${isError ? 'border-danger' : 'border-border'}
      `}
      style={{
        // Hand-tuned drop shadow so the chip reads as floating chrome over
        // both the dark code slab AND the warm light canvas. The 22% opacity
        // is the lowest value where the chip still has a clear edge on the
        // light-soft theme; anything subtler and it disappears into the
        // surface above.
        boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
      }}
      aria-live="polite"
      aria-label={
        isError
          ? 'Dictation error'
          : isRecording
            ? 'Listening'
            : isStarting
              ? 'Starting dictation'
              : 'Transcribing'
      }
    >
      <div className="flex h-5 items-center" aria-hidden>
        {isRecording ? <DictationBars levels={levels} /> : <DictationDots />}
      </div>
      <div className="flex flex-col items-start gap-1 min-w-0">
        <span className={isError ? 'text-danger' : 'text-ink'}>
          {labelText}
        </span>
        {previewText && !isError ? (
          <span className="text-muted truncate max-w-[44ch]">
            {previewText}
          </span>
        ) : null}
      </div>
    </div>
  )
}

// 7-band energy bars. Math lifted verbatim from the standalone flow-electron
// MicPill — each band index maps to one of VOICE_BANDS_HZ in
// useComposerDictation, and the sine curve adds a small organic bend so the
// chip doesn't look frozen during a quiet pause. Voice energy comes from the
// real analyser tick, not a decorative animation.
function DictationBars({ levels }: { levels: number[] }) {
  const phases = [0, 0.11, 0.23, 0.37, 0.52, 0.68, 0.84]
  const t = (Date.now() % 700) / 700
  return (
    <div className="flex h-5 items-center gap-[3px] text-accent">
      {phases.map((phase, i) => {
        const voice = levels[i] ?? 0
        const wave = 0.86 + 0.14 * Math.abs(Math.sin((t + phase) * Math.PI * 2))
        const responsive = Math.max(voice, 0.025) * wave
        const height = Math.max(3, Math.round(responsive * 18))
        return (
          <span
            key={phase}
            className="w-[3px] bg-current"
            style={{
              height,
              opacity: 0.62 + Math.min(0.38, voice * 0.7),
              // 28ms = roughly two frame intervals at 60Hz. Short enough that
              // the bars feel responsive to the analyser tick; long enough
              // to smooth visible jitter between adjacent frames.
              transition: 'height 28ms linear',
            }}
          />
        )
      })}
    </div>
  )
}

// Three-dot pulse for starting/stopping states. Distinct from the streaming
// dot animation (1.3s pulse, see styles.css cc-pulse) because this is a
// short-lived transition indicator, not a long-running "I am thinking"
// signal — the cycle is faster (1.1s) and the dots are aligned in a row
// rather than the single centered dot pattern.
function DictationDots() {
  return (
    <div className="flex h-5 items-center gap-1 text-ink-dim">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          // rounded-full sits OUTSIDE the corner-style system on purpose:
          // these are circles by geometry, not corners by policy, so they
          // must stay round even at the Sharp tier. Same exception the
          // streaming dot has — the dictation dots ARE the equivalent
          // affordance for the dictation pipeline.
          className="h-1.5 w-1.5 rounded-full bg-current"
          style={{
            animation: `voice-dictation-pulse 1.1s ${i * 0.18}s ease-in-out infinite`,
          }}
        />
      ))}
      {/*
        Inline keyframes so a fresh App render does not have to bring a
        separate stylesheet along just for this. Same approach the old
        ComposerDictationDots used; we keep the keyframe name distinct
        (voice-dictation-pulse) from composer-dictation-pulse to leave no
        legacy collision when the old inline composer UI gets removed.
      */}
      <style>{`@keyframes voice-dictation-pulse { 0%,80%,100%{opacity:.2;transform:scale(.85)} 40%{opacity:1;transform:scale(1)} }`}</style>
    </div>
  )
}

// Short-form error text. The full provider message can be long ("Deepgram
// returned 401: api key missing or expired"); the chip is intentionally
// narrow and auto-dismisses after ~1.6s, so we keep the message to a single
// scannable line.
function truncateError(message: string | null): string {
  if (!message) return 'error'
  if (message.length <= 56) return message
  return `${message.slice(0, 53)}…`
}
