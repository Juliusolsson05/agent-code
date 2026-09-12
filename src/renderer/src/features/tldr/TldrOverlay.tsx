import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { TldrRecord } from '@shared/types/tldr'
import { TldrFreshness } from './TldrFreshness'
import { isPreviewVisible, useTldrView } from './viewState'
import type { PreviewKind } from './viewState'

// What differs between the TLDR and Goal peeks is only where the text comes
// from and what it is called. Sharing the overlay keeps the subscription race
// handling, pane ownership, and enforcement note identical for both.
const SOURCES = {
  tldr: {
    label: 'TLDR', missing: 'No TLDR yet', writtenLabel: 'Note written', ariaLabel: 'Agent TLDR',
    read: (identities: string[]) => window.api.readTldrs(identities),
    subscribe: (listener: Parameters<typeof window.api.onTldrChanged>[0]) => window.api.onTldrChanged(listener),
  },
  goal: {
    label: 'Goal', missing: 'No goal yet', writtenLabel: 'Goal set', ariaLabel: 'Agent goal',
    read: (identities: string[]) => window.api.readGoals(identities),
    subscribe: (listener: Parameters<typeof window.api.onGoalChanged>[0]) => window.api.onGoalChanged(listener),
  },
} as const

// Providers whose launchers inject TLDR turn hooks (#917). OpenCode reports on
// instructions alone, so it has no enforcement to report as inactive.
const ENFORCED_PROVIDERS = new Set(['claude', 'codex'])

function newest(previous: TldrRecord | null, next: TldrRecord | undefined): TldrRecord | null {
  return next && (!previous || next.revision > previous.revision) ? next : previous
}

export function TldrOverlay({ kind = 'tldr', identity, enabled, runtime, provider }: { kind?: PreviewKind; identity: string; enabled: boolean; runtime?: SessionRuntime; provider?: string }) {
  const source = SOURCES[kind]
  const visible = useTldrView(state => isPreviewVisible(state, kind))
  const [snapshot, setSnapshot] = useState<{ identity: string; record: TldrRecord | null; error: boolean }>({ identity, record: null, error: false })
  const [hookContact, setHookContact] = useState<{ identity: string; seen: boolean } | null>(null)
  const enforced = enabled && ENFORCED_PROVIDERS.has(provider ?? '')
  // A turn that ran and ENDED in this renderer run. The prompt hook fires when
  // a turn starts, so by the time one has ended a working provider has made
  // contact; a turn that is merely submitted may still be ahead of its hook.
  const turnEnded = Boolean(runtime && runtime.phaseChangedAt !== null && runtime.streamPhase === 'idle')
  const turnMarker = runtime?.phaseChangedAt ?? null
  useEffect(() => {
    if (!visible || !enforced) return
    let current = true
    // Advisory only: if the status cannot be read, say nothing rather than
    // claim enforcement is broken. Re-read on every phase change: a latched
    // peek can stay open across a whole turn, and a status read before that
    // turn's first hook would otherwise leave a false warning on screen.
    void Promise.resolve()
      .then(() => window.api.readTldrEnforcement([identity]))
      .then(status => { if (current) setHookContact({ identity, seen: Boolean(status[identity]?.hookContactAt) }) })
      .catch(() => {})
    return () => { current = false }
  }, [identity, enforced, visible, turnMarker])
  useEffect(() => {
    if (!visible || !enabled) return
    let current = true
    setSnapshot({ identity, record: null, error: false })
    // Subscribe before reading. The revision prevents a slower disk snapshot
    // from overwriting a newer MCP event received during the initial request.
    // Only visible previews subscribe: thousands of detached agents impose no
    // listeners, polling or model calls while the user is doing normal work.
    const unsubscribe = source.subscribe(update => {
      if (current && update.identity === identity) setSnapshot(previous => ({
        identity, record: newest(previous.identity === identity ? previous.record : null, update.record), error: false,
      }))
    })
    void source.read([identity]).then(records => {
      if (current) setSnapshot(previous => ({ identity, record: newest(previous.record, records[identity]), error: false }))
    }).catch(() => {
      if (current) setSnapshot(previous => ({ ...previous, error: previous.record === null }))
    })
    return () => { current = false; unsubscribe() }
  }, [identity, enabled, visible, source])
  if (!visible) return null
  const record = snapshot.identity === identity ? snapshot.record : null
  const text = !enabled ? `${source.label} is off` : snapshot.error ? `${source.label} unavailable` : record?.text ?? source.missing
  return <div
    data-agent-code-interaction-owner="app"
    {...(kind === 'tldr' ? { 'data-tldr-overlay': '' } : { 'data-goal-overlay': '' })}
    role="note"
    aria-label={source.ariaLabel}
    className="absolute inset-0 z-50 bg-black/95 text-center text-white"
    onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => event.stopPropagation()}
  >
    <div className="absolute inset-0 flex items-center justify-center px-6 py-16">
      <p className="max-h-full max-w-xl overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere] sm:text-base">{text}</p>
    </div>
    <TldrFreshness
      runtime={runtime}
      writtenAt={enabled ? record?.updatedAt : undefined}
      writtenLabel={source.writtenLabel}
      // WHY this needs a completed turn: a freshly (re)loaded agent has had no
      // turn for its hooks to fire on, and a just-submitted one may still be
      // ahead of its first hook, so "never contacted" is not yet a failure. A
      // turn that ran to the end with no hook contact means the provider never
      // ran them — the silent failure worth showing.
      enforcementInactive={enforced && turnEnded && hookContact?.identity === identity && !hookContact.seen}
    />
  </div>
}

export function TldrPane({ identity, enabled, goalEnabled = false, runtime, provider, children }: { identity: string; enabled: boolean; goalEnabled?: boolean; runtime?: SessionRuntime; provider?: string; children: ReactNode }) {
  // Overlay instead of conditional replacement: xterm dimensions, live feed
  // subscriptions, scroll position and composer drafts remain mounted below.
  return <div className="relative h-full min-h-0 min-w-0">
    {children}
    <TldrOverlay kind="tldr" identity={identity} enabled={enabled} runtime={runtime} provider={provider} />
    <TldrOverlay kind="goal" identity={identity} enabled={goalEnabled} runtime={runtime} provider={provider} />
  </div>
}
