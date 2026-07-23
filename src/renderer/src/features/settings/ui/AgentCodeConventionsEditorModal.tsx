import { useEffect, useMemo, useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  AGENT_CODE_CONVENTIONS_STARTER,
  type AgentCodeConventionsConflictResolution,
  type AgentCodeConventionsMutationResult,
  type AgentCodeConventionsSnapshot,
} from '@shared/types/agentCodeConventions.js'

type Props = {
  open: boolean
  snapshot: AgentCodeConventionsSnapshot
  onOpenChange: (open: boolean) => void
  onSnapshot: (snapshot: AgentCodeConventionsSnapshot) => void
}

function mutationMessage(result: AgentCodeConventionsMutationResult): string {
  if (result.ok) return ''
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'A newer saved version exists. Reload it or copy your draft first.'
  if (result.code === 'target-conflict') return 'Review each conflicting installation path below.'
  if (result.code === 'clear-blocked') return 'Modified external copies remain. Retry removal or explicitly leave them.'
  if (result.code === 'unsupported') return 'A registered provider cannot consume personal Agent Skills.'
  return 'The saved state must be recovered before editing.'
}

export function AgentCodeConventionsEditorModal({
  open,
  snapshot,
  onOpenChange,
  onSnapshot,
}: Props) {
  const [base, setBase] = useState(snapshot)
  const [markdown, setMarkdown] = useState(snapshot.markdown)
  const [enabled, setEnabled] = useState(snapshot.enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [warnings, setWarnings] = useState(snapshot.warnings)
  const [conflictSnapshot, setConflictSnapshot] = useState<AgentCodeConventionsSnapshot | null>(null)
  const [overwriteApprovals, setOverwriteApprovals] = useState<AgentCodeConventionsConflictResolution[]>([])
  const [abandonApprovals, setAbandonApprovals] = useState<AgentCodeConventionsConflictResolution[]>([])
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setBase(snapshot)
    setMarkdown(snapshot.markdown)
    setEnabled(snapshot.enabled)
    setError(null)
    setNotice(null)
    setPreview(null)
    setWarnings(snapshot.warnings)
    setConflictSnapshot(null)
    setOverwriteApprovals([])
    setAbandonApprovals([])
  }, [open, snapshot])

  const counts = useMemo(() => ({
    lines: markdown.length === 0 ? 0 : markdown.split('\n').length,
    characters: [...markdown].length,
    bytes: new TextEncoder().encode(markdown).byteLength,
  }), [markdown])
  const dirty = markdown !== base.markdown || enabled !== base.enabled
  const shownSnapshot = conflictSnapshot ?? base
  const conflicts = shownSnapshot.targets.filter(target =>
    (target.state === 'conflict' || target.state === 'retired') && target.conflictFingerprint)

  const requestClose = (nextOpen: boolean) => {
    if (!nextOpen && dirty && !window.confirm('Discard unsaved convention changes?')) return
    onOpenChange(nextOpen)
  }

  const applyResult = (result: AgentCodeConventionsMutationResult): boolean => {
    if (result.ok) {
      setBase(result.snapshot)
      setMarkdown(result.snapshot.markdown)
      setEnabled(result.snapshot.enabled)
      setConflictSnapshot(null)
      setOverwriteApprovals([])
      setAbandonApprovals([])
      setWarnings(result.snapshot.warnings)
      onSnapshot(result.snapshot)
      setError(null)
      return true
    }
    if ('snapshot' in result) {
      setConflictSnapshot(result.snapshot)
      onSnapshot(result.snapshot)
      if (result.code === 'clear-blocked') {
        // Disable succeeded even though clear could not. Advance the local CAS
        // revision without replacing the user's draft so the explicit
        // leave-file follow-up is based on the state main actually persisted.
        setBase(result.snapshot)
        setEnabled(false)
      }
    }
    if ('warnings' in result && result.warnings) setWarnings(result.warnings)
    setError(mutationMessage(result))
    return false
  }

  const save = async (approvals = overwriteApprovals) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.saveAgentCodeConventions({
        expectedRevision: base.revision,
        enabled,
        markdown,
        overwriteTargets: approvals,
      })
      if (applyResult(result) && enabled) {
        setNotice('Saved. Agent Code will reconcile before starting new agents; existing agents may need a restart.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save conventions.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    const clearConfirmation = abandonApprovals.length > 0
      ? `Leave ${abandonApprovals.length} selected external file${abandonApprovals.length === 1 ? '' : 's'} untouched, forget Agent Code ownership, and clear the saved rules?`
      : base.enabled
        ? 'Disable conventions and clear the saved rules? Managed copies will be removed first.'
        : 'Clear the saved convention rules?'
    if (!window.confirm(clearConfirmation)) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.clearAgentCodeConventions({
        expectedRevision: base.revision,
        abandonTargets: abandonApprovals,
      })
      if (applyResult(result)) setNotice('Saved rules cleared.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear conventions.')
    } finally {
      setBusy(false)
    }
  }

  const showPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.previewAgentCodeConventions(markdown)
      if (result.ok) {
        setPreview(result.renderedSkill)
        setWarnings(result.warnings)
      } else {
        setError(result.message)
        setWarnings(result.warnings ?? [])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not generate the skill preview.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="flex max-h-[88vh] w-[min(780px,94vw)] flex-col overflow-hidden font-code">
        <DialogHeader>
          <DialogTitle>Agent Code Conventions</DialogTitle>
          <DialogDescription>
            Global CLI skills may apply outside Agent Code and load when relevant. Do not include credentials, customer data, or other secrets.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
          <label className="flex items-center justify-between border border-control-border px-3 py-2 text-[11px]">
            <span>Enable conventions</span>
            <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          </label>

          {preview !== null ? (
            <div className="flex min-h-0 flex-col gap-2">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>Generated SKILL.md preview</span>
                <button type="button" className="border border-control-border px-2 py-1" onClick={() => setPreview(null)}>Back to editor</button>
              </div>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap border border-input-border bg-input-bg p-3 text-[11px] text-ink">{preview}</pre>
            </div>
          ) : (
            <>
              <Textarea
                aria-label="Convention rules"
                value={markdown}
                onChange={event => {
                  setMarkdown(event.target.value)
                  // Warnings come from the canonical main-process validator.
                  // Clear them on a new draft rather than showing advice for
                  // text that no longer produced it; preview/save repopulates.
                  setWarnings([])
                }}
                className="min-h-[320px] resize-y"
                placeholder="# Development practices\n\n- Read repository instructions before changing files."
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
                <span>{counts.lines} lines · {counts.characters} characters · {counts.bytes} UTF-8 bytes</span>
                <span>32 KiB maximum</span>
              </div>
              {warnings.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4 text-[10px] text-warning">
                  {warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="border border-control-border px-2 py-1 text-[11px]"
              onClick={() => {
                if (markdown.trim() && !window.confirm('Replace the current draft with the starter conventions?')) return
                setMarkdown(AGENT_CODE_CONVENTIONS_STARTER)
                setWarnings([])
                setPreview(null)
              }}
            >
              Insert starter
            </button>
            <button type="button" disabled={busy} className="border border-control-border px-2 py-1 text-[11px] disabled:opacity-50" onClick={() => void showPreview()}>
              Preview generated skill
            </button>
          </div>

          {shownSnapshot.targets.length > 0 ? (
            <div className="flex flex-col gap-1 border border-panel-border p-2 text-[10px]">
              <div className="mb-1 text-[11px] text-ink">Installations</div>
              {shownSnapshot.targets.map(target => (
                <div key={target.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-panel-border py-1 first:border-t-0">
                  <span className="min-w-0 flex-1 truncate text-muted">{target.displayPath || target.id} · {target.state}</span>
                  {(target.state === 'conflict' || target.state === 'retired') ? (
                    <>
                      <button type="button" className="border border-control-border px-1.5 py-0.5" onClick={() => void window.api.revealAgentCodeConventionsTarget(target.id)}>Reveal</button>
                      {target.canOverwrite && target.conflictFingerprint ? (
                        <button
                          type="button"
                          className="border border-danger px-1.5 py-0.5 text-danger"
                          onClick={() => {
                            if (!window.confirm(`Replace the reviewed file at ${target.displayPath}?`)) return
                            const next = [
                              ...overwriteApprovals.filter(value => value.targetId !== target.id),
                              { targetId: target.id, expectedConflictFingerprint: target.conflictFingerprint! },
                            ]
                            setOverwriteApprovals(next)
                            void save(next)
                          }}
                        >
                          Replace reviewed file
                        </button>
                      ) : null}
                      {target.conflictFingerprint ? (
                        <label className="flex items-center gap-1 text-danger">
                          <input
                            type="checkbox"
                            checked={abandonApprovals.some(value => value.targetId === target.id)}
                            onChange={event => setAbandonApprovals(current => event.target.checked
                              ? [...current.filter(value => value.targetId !== target.id), {
                                  targetId: target.id,
                                  expectedConflictFingerprint: target.conflictFingerprint!,
                                }]
                              : current.filter(value => value.targetId !== target.id))}
                          />
                          Leave external file
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {error ? <div role="alert" className="border border-danger px-2 py-1 text-[11px] text-danger">{error}</div> : null}
          {notice ? <div role="status" className="border border-accent px-2 py-1 text-[11px] text-accent">{notice}</div> : null}

          {error?.includes('newer saved version') ? (
            <div className="flex gap-2">
              <button type="button" className="border border-control-border px-2 py-1 text-[11px]" onClick={() => {
                // The conflict response is already the authoritative latest
                // snapshot. Do not depend on React finishing the parent prop
                // round-trip before this button is clicked.
                const latest = conflictSnapshot ?? snapshot
                setBase(latest)
                setMarkdown(latest.markdown)
                setEnabled(latest.enabled)
                setWarnings(latest.warnings)
                setConflictSnapshot(null)
                setError(null)
              }}>Reload latest</button>
              <button type="button" className="border border-control-border px-2 py-1 text-[11px]" onClick={() => void navigator.clipboard.writeText(markdown)}>Copy draft</button>
            </div>
          ) : null}
        </div>

        <DialogFooter className="justify-between">
          <button type="button" disabled={busy || (!base.markdown && conflicts.length === 0)} onClick={() => void clear()} className="border border-danger px-2 py-1 text-[11px] text-danger disabled:opacity-40">
            {base.enabled ? 'Disable and clear' : abandonApprovals.length > 0 ? 'Leave selected and clear' : 'Clear saved rules'}
          </button>
          <div className="flex gap-2">
            <button type="button" className="border border-control-border px-2 py-1 text-[11px]" onClick={() => requestClose(false)}>Cancel</button>
            <button type="button" disabled={busy} className="border border-control-active-bg bg-control-active-bg px-3 py-1 text-[11px] text-control-active-fg disabled:opacity-50" onClick={() => void save()}>
              {enabled && !base.enabled ? 'Save & Enable' : 'Save changes'}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
