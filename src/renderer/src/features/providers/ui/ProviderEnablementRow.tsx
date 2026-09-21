import { useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useProviderEnablementStore } from '@renderer/features/providers/store'

import type { ProviderEnablementEntry } from '@shared/types/providerEnablement'

function hintFor(entry: ProviderEnablementEntry): string {
  if (entry.because === 'user') return 'set by you'
  return entry.installed ? 'detected' : 'not detected on PATH'
}

function EntryRow({ entry }: { entry: ProviderEnablementEntry }) {
  const capabilities = getRendererProviderCapabilities(entry.kind)
  const [pending, setPending] = useState(false)

  const toggle = async () => {
    setPending(true)
    try {
      // The returned snapshot also arrives via the push channel; applying it
      // here too keeps the switch snappy instead of waiting a broadcast hop.
      const snapshot = await window.api.providerEnablementSet(entry.kind, !entry.enabled)
      useProviderEnablementStore.getState().setSnapshot(snapshot)
    } finally {
      setPending(false)
    }
  }

  const reset = async () => {
    setPending(true)
    try {
      const snapshot = await window.api.providerEnablementReset(entry.kind)
      useProviderEnablementStore.getState().setSnapshot(snapshot)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-ink">{capabilities.shortLabel}</div>
        <div className="mt-0.5 text-[10px] text-muted">
          {hintFor(entry)}
          {entry.because === 'user' ? (
            <>
              {' · '}
              <button
                type="button"
                className="underline decoration-dotted"
                disabled={pending}
                onClick={() => void reset()}
              >
                reset to detection
              </button>
            </>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={entry.enabled}
        aria-label={`Enable ${capabilities.shortLabel}`}
        disabled={pending}
        onClick={() => void toggle()}
        className={
          entry.enabled
            ? 'rounded-chip border border-border bg-accent px-2 py-1 text-[10px] text-ink'
            : 'rounded-chip border border-border bg-surface-hi px-2 py-1 text-[10px] text-muted'
        }
      >
        {entry.enabled ? 'on' : 'off'}
      </button>
    </div>
  )
}

/** Settings → Providers row (#1102). Self-subscribing marker row in the
 *  cli-updates shape: the value lives in main's setup.json, this component
 *  only mirrors the pushed snapshot and writes through the API. */
export function ProviderEnablementRow() {
  const snapshot = useProviderEnablementStore(state => state.snapshot)

  if (!snapshot) {
    return <div className="px-3 py-3 text-[11px] text-muted">Loading provider state…</div>
  }
  return (
    <div className="rounded-slab border border-border bg-surface">
      {snapshot.entries.map(entry => (
        <EntryRow key={entry.kind} entry={entry} />
      ))}
      <div className="px-3 py-2 text-[10px] text-muted">
        Turning a provider off hides it from pickers and usage. Running agents are never closed.
        The OpenCode usage-source selector arrives with z.ai usage support.
      </div>
    </div>
  )
}
