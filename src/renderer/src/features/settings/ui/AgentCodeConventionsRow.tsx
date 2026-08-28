import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT,
  announceAgentCodeManagedSkillsChange,
  type AgentCodeManagedSkillsChange,
} from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import type {
  AgentCodeConventionsMutationResult,
  AgentCodeConventionsSnapshot,
} from '@shared/types/agentCodeConventions.js'
import { AgentCodeConventionsEditorModal } from './AgentCodeConventionsEditorModal'

// See docs/design/agent-code-conventions.md. This row displays main-owned
// desired state and deployment health; it must never persist a shadow toggle.

const HEALTH_LABELS: Record<AgentCodeConventionsSnapshot['health'], string> = {
  disabled: 'Disabled',
  active: 'Active',
  degraded: 'Degraded',
  conflict: 'Conflict',
  unsupported: 'Unsupported',
  'recovery-required': 'Recovery required',
}

function resultMessage(result: AgentCodeConventionsMutationResult): string {
  if (result.ok) return ''
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'Conventions changed elsewhere. Reload the editor.'
  if (result.code === 'target-conflict') return 'An installation path needs review.'
  if (result.code === 'clear-blocked') return 'External changes must be resolved before clearing.'
  if (result.code === 'unsupported') return 'A registered provider does not support personal skills.'
  return 'Conventions state needs recovery before it can be changed.'
}

export function AgentCodeConventionsRow() {
  const [snapshot, setSnapshot] = useState<AgentCodeConventionsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const revisionRef = useRef(-1)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.auditAgentCodeConventions()
      revisionRef.current = next.revision
      setSnapshot(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load conventions status.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const onManagedSkillsChanged = (event: Event) => {
      const change = (event as CustomEvent<AgentCodeManagedSkillsChange>).detail
      if (!change || change.source === 'conventions' || change.revision <= revisionRef.current) return
      void refresh()
    }
    window.addEventListener(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, onManagedSkillsChanged)
    return () => window.removeEventListener(
      AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT,
      onManagedSkillsChanged,
    )
  }, [refresh])

  const acceptSnapshot = useCallback((next: AgentCodeConventionsSnapshot) => {
    revisionRef.current = next.revision
    setSnapshot(next)
    announceAgentCodeManagedSkillsChange({ source: 'conventions', revision: next.revision })
  }, [])

  const applyResult = useCallback((result: AgentCodeConventionsMutationResult) => {
    if ('snapshot' in result) acceptSnapshot(result.snapshot)
    setError(resultMessage(result) || null)
    return result.ok
  }, [acceptSnapshot])

  const toggle = useCallback(async () => {
    if (!snapshot || busy) return
    if (snapshot.health === 'recovery-required' || snapshot.health === 'unsupported') return
    if (snapshot.enabled) {
      if (!window.confirm('Disable conventions? Managed skill copies will be removed, but your saved rules will remain.')) return
      setBusy(true)
      try {
        applyResult(await window.api.disableAgentCodeConventions(snapshot.revision))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not disable conventions.')
      } finally {
        setBusy(false)
      }
      return
    }
    if (!snapshot.markdown.trim()) {
      setEditorOpen(true)
      return
    }
    setBusy(true)
    try {
      applyResult(await window.api.saveAgentCodeConventions({
        expectedRevision: snapshot.revision,
        enabled: true,
        markdown: snapshot.markdown,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not enable conventions.')
    } finally {
      setBusy(false)
    }
  }, [applyResult, busy, snapshot])

  if (!snapshot) {
    return <div className="text-[11px] italic text-muted">{error ?? 'Loading conventions…'}</div>
  }

  const lines = snapshot.markdown ? snapshot.markdown.split('\n').length : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-control flex items-center justify-between border border-control-border bg-control-bg px-3 py-2">
        <div>
          <div className="text-[11px] text-ink">Status: {HEALTH_LABELS[snapshot.health]}</div>
          <div className="mt-1 text-[10px] text-muted">
            {lines > 0 ? `${lines} lines saved` : 'No rules saved'}
          </div>
        </div>
        {/* The button's own chrome carries no state conditional — only the
            indicator span does — so this is a plain control, same shape as the
            toggle row in SettingsList. */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || snapshot.health === 'recovery-required' || snapshot.health === 'unsupported'}
          onClick={() => void toggle()}
        >
          <span>{snapshot.enabled ? 'On' : 'Off'}</span>
          <span className={`h-3.5 w-3.5 border ${snapshot.enabled ? 'border-control-active-bg bg-control-active-bg' : 'border-control-border-hover'}`} />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditorOpen(true)}>
          Edit conventions…
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          Refresh status
        </Button>
      </div>

      {snapshot.targets.length > 0 ? (
        <div className="rounded-slab flex flex-col gap-1 border border-panel-border px-2 py-2">
          {snapshot.targets.map(target => (
            <div key={target.id} className="flex items-start justify-between gap-3 text-[10px]">
              <span className="text-muted">
                {target.providers.length > 0 ? target.providers.join(', ') : 'Retired target'}
              </span>
              <button
                type="button"
                title={target.message}
                onClick={() => void window.api.revealAgentCodeConventionsTarget(target.id)}
                className="min-w-0 truncate text-right text-control-fg hover:text-ink"
              >
                {target.displayPath || target.state} · {target.state}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {snapshot.health === 'unsupported' ? (
        <div role="status" className="rounded-slab border border-warning px-2 py-1 text-[10px] text-warning">
          Personal Agent Skills are unavailable for: {snapshot.unsupportedProviders.join(', ')}.
        </div>
      ) : null}

      {snapshot.recovery ? (
        <div className="rounded-slab flex flex-col gap-2 border border-danger px-2 py-2 text-[10px] text-danger">
          <span>{snapshot.recovery.message}</span>
          <div className="flex gap-2">
            <button type="button" className="rounded-control border border-danger px-2 py-1" onClick={() => void window.api.revealAgentCodeConventionsRecoveryFile()}>
              Reveal state file
            </button>
            <button
              type="button"
              className="rounded-control border border-danger px-2 py-1"
              onClick={() => {
                if (!window.confirm('Reset all unreadable Agent Code-managed skill state? The shared state file will be removed, and any existing provider copies will be left untouched.')) return
                void window.api.resetAgentCodeConventionsRecovery().then(applyResult)
              }}
            >
              Reset state
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div role="alert" className="text-[11px] text-danger">{error}</div> : null}

      <AgentCodeConventionsEditorModal
        open={editorOpen}
        snapshot={snapshot}
        onOpenChange={setEditorOpen}
        onSnapshot={next => {
          acceptSnapshot(next)
          setError(null)
        }}
      />
    </div>
  )
}
