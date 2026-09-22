import { useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useProviderEnablementStore } from '@renderer/features/providers/store'

import { OPENCODE_USAGE_SOURCES, type OpencodeUsageSource, type ProviderEnablementEntry } from '@shared/types/providerEnablement'

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

/** The OpenCode usage-source selector (#1104, Phase 3): which configured
 *  provider's quota the usage surfaces should show. `none` is the honest
 *  default — OpenCode itself is BYO-keys with no single quota — and z.ai is
 *  the first real source. Greyed with a reason when it cannot be used: the
 *  spec pins that a selectable-but-dead source is worse than a hint. */
function OpencodeUsageSourceRow() {
  const snapshot = useProviderEnablementStore(state => state.snapshot)
  const [pending, setPending] = useState(false)
  if (!snapshot) return null
  const opencodeEnabled = snapshot.entries.some(entry => entry.kind === 'opencode' && entry.enabled)
  // Not blocked when z.ai is ALREADY selected without a credential (final
  // review #6): otherwise the user could never escape back to `none` and the
  // usage row would error forever with no Settings remedy.
  const zaiSelected = snapshot.opencodeUsageSource === 'zai'
  const blocked = !opencodeEnabled || (!snapshot.zaiCredentialPresent && !zaiSelected)
  const hint = !opencodeEnabled
    ? 'Enable OpenCode to choose its usage source.'
    : !snapshot.zaiCredentialPresent
      ? 'Connect the z.ai Coding Plan in OpenCode (/connect) to select it.'
      : 'Which quota the usage modal and header track.'

  const [choiceError, setChoiceError] = useState('')
  const choose = async (value: OpencodeUsageSource) => {
    setPending(true)
    setChoiceError('')
    try {
      const next = await window.api.providerEnablementSetOpencodeUsageSource(value)
      useProviderEnablementStore.getState().setSnapshot(next)
    } catch (error) {
      // An IPC failure must surface, not become an unhandled renderer
      // rejection with a silently unchanged dropdown (final review #7).
      setChoiceError(error instanceof Error ? error.message : 'Could not save the usage source.')
    } finally { setPending(false) }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-ink">OpenCode usage source</div>
        <div className="mt-0.5 text-[10px] text-muted">{choiceError || hint}</div>
      </div>
      <select
        aria-label="OpenCode usage source"
        disabled={pending || blocked}
        value={snapshot.opencodeUsageSource}
        onChange={event => { void choose(event.target.value as OpencodeUsageSource) }}
        className="rounded-chip border border-border bg-surface-hi px-2 py-1 text-[10px] text-ink disabled:opacity-50"
      >
        {OPENCODE_USAGE_SOURCES.map(source => (
          <option key={source} value={source}>{source === 'none' ? 'none' : 'z.ai'}</option>
        ))}
      </select>
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
      <OpencodeUsageSourceRow />
      <div className="px-3 py-2 text-[10px] text-muted">
        Turning a provider off hides it from pickers and usage. Running agents are never closed.
      </div>
    </div>
  )
}
