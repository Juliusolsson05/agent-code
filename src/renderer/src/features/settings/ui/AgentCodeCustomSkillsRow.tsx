import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import type {
  AgentCodeCustomSkill,
  AgentCodeCustomSkillDraft,
  AgentCodeCustomSkillsMutationResult,
  AgentCodeCustomSkillsSnapshot,
} from '@shared/types/agentCodeCustomSkills.js'
import type { AgentCodeConventionsTargetStatus } from '@shared/types/agentCodeConventions.js'

const HEALTH_LABELS: Record<AgentCodeCustomSkill['health'], string> = {
  disabled: 'Draft',
  active: 'Active',
  degraded: 'Degraded',
  conflict: 'Conflict',
  unsupported: 'Unsupported',
  'recovery-required': 'Recovery required',
}

type EditorDraft = AgentCodeCustomSkillDraft & { skillId: string | null }

function emptyDraft(): EditorDraft {
  return { skillId: null, name: '', description: '', markdown: '', enabled: false }
}

function draftFromSkill(skill: AgentCodeCustomSkill): EditorDraft {
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    markdown: skill.markdown,
    enabled: skill.enabled,
  }
}

function mutationMessage(result: AgentCodeCustomSkillsMutationResult): string {
  if (result.ok) return ''
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'Custom skills changed elsewhere. Reload and retry.'
  if (result.code === 'unsupported') return 'A registered provider does not support personal skills.'
  return 'Managed skill state needs recovery before it can be changed.'
}

export function AgentCodeCustomSkillsRow() {
  const [snapshot, setSnapshot] = useState<AgentCodeCustomSkillsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setSnapshot(await window.api.auditAgentCodeCustomSkills())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load custom skills.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  if (!snapshot) {
    return <div className="text-[11px] italic text-muted">{error ?? 'Loading custom skills…'}</div>
  }
  const active = snapshot.skills.filter(skill => skill.enabled).length

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between border border-control-border bg-control-bg px-3 py-2">
        <div className="text-[11px] text-ink">
          {snapshot.skills.length === 0
            ? 'No Agent Code-authored skills'
            : `${snapshot.skills.length} skill${snapshot.skills.length === 1 ? '' : 's'} · ${active} active`}
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(true)}>
          Manage custom skills…
        </Button>
      </div>
      {error ? <div role="alert" className="text-[11px] text-danger">{error}</div> : null}
      <AgentCodeCustomSkillsModal
        open={open}
        snapshot={snapshot}
        onOpenChange={setOpen}
        onSnapshot={next => {
          setSnapshot(next)
          setError(null)
        }}
      />
    </div>
  )
}

function AgentCodeCustomSkillsModal({
  open,
  snapshot,
  onOpenChange,
  onSnapshot,
}: {
  open: boolean
  snapshot: AgentCodeCustomSkillsSnapshot
  onOpenChange: (open: boolean) => void
  onSnapshot: (snapshot: AgentCodeCustomSkillsSnapshot) => void
}) {
  const [current, setCurrent] = useState(snapshot)
  const [draft, setDraft] = useState<EditorDraft | null>(null)
  const [baseDraft, setBaseDraft] = useState<EditorDraft | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflictTargets, setConflictTargets] = useState<AgentCodeConventionsTargetStatus[]>([])
  const [blockedDelete, setBlockedDelete] = useState<{
    skillId: string
    targets: AgentCodeConventionsTargetStatus[]
  } | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setCurrent(snapshot)
    setDraft(null)
    setBaseDraft(null)
    setPreview(null)
    setWarnings([])
    setError(null)
    setConflictTargets([])
    setBlockedDelete(null)
  }, [open, snapshot])

  const dirty = useMemo(() => draft !== null && JSON.stringify(draft) !== JSON.stringify(baseDraft), [baseDraft, draft])

  const replaceSnapshot = (next: AgentCodeCustomSkillsSnapshot) => {
    setCurrent(next)
    onSnapshot(next)
  }

  const applyResult = (result: AgentCodeCustomSkillsMutationResult): boolean => {
    if ('snapshot' in result) replaceSnapshot(result.snapshot)
    setError(mutationMessage(result) || null)
    if (!result.ok && (result.code === 'target-conflict' || result.code === 'delete-blocked')) {
      setConflictTargets(result.targets)
    } else {
      setConflictTargets([])
    }
    return result.ok
  }

  const requestClose = (nextOpen: boolean) => {
    if (!nextOpen && dirty && !window.confirm('Discard unsaved custom skill changes?')) return
    onOpenChange(nextOpen)
  }

  const edit = (next: EditorDraft) => {
    setDraft(next)
    setBaseDraft(next)
    setPreview(null)
    setWarnings([])
    setError(null)
    setConflictTargets([])
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const result = draft.skillId
        ? await window.api.updateAgentCodeCustomSkill({
            expectedRevision: current.revision,
            skillId: draft.skillId,
            description: draft.description,
            markdown: draft.markdown,
            enabled: draft.enabled,
          })
        : await window.api.createAgentCodeCustomSkill({
            expectedRevision: current.revision,
            name: draft.name,
            description: draft.description,
            markdown: draft.markdown,
            enabled: draft.enabled,
          })
      applyResult(result)
      if (result.ok) {
        const saved = draft.skillId
          ? result.snapshot.skills.find(skill => skill.id === draft.skillId)
          : result.snapshot.skills.find(skill => skill.name === draft.name.trim())
        if (saved) edit(draftFromSkill(saved))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the custom skill.')
    } finally {
      setBusy(false)
    }
  }

  const showPreview = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.previewAgentCodeCustomSkill(draft)
      if (result.ok) {
        setPreview(result.renderedSkill)
        setWarnings(result.warnings)
      } else setError(result.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not preview the custom skill.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (skill: AgentCodeCustomSkill) => {
    if (busy) return
    if (skill.enabled && !window.confirm(`Disable ${skill.name}? Managed provider copies will be removed.`)) return
    setBusy(true)
    setError(null)
    try {
      applyResult(await window.api.setAgentCodeCustomSkillEnabled({
        expectedRevision: current.revision,
        skillId: skill.id,
        enabled: !skill.enabled,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the custom skill.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (
    skill: AgentCodeCustomSkill,
    abandonTargets?: Array<{ targetId: string; expectedConflictFingerprint: string }>,
  ) => {
    const wording = abandonTargets
      ? `Leave ${abandonTargets.length} external file${abandonTargets.length === 1 ? '' : 's'} untouched and forget ${skill.name}?`
      : `Delete ${skill.name}? Managed copies will be removed first.`
    if (!window.confirm(wording)) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.deleteAgentCodeCustomSkill({
        expectedRevision: current.revision,
        skillId: skill.id,
        abandonTargets,
      })
      if (!result.ok && result.code === 'delete-blocked') {
        setBlockedDelete({ skillId: skill.id, targets: result.targets })
      } else if (result.ok) {
        setBlockedDelete(null)
      }
      applyResult(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the custom skill.')
    } finally {
      setBusy(false)
    }
  }

  const shownSkill = draft?.skillId
    ? current.skills.find(skill => skill.id === draft.skillId)
    : undefined

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="flex max-h-[90vh] w-[min(880px,95vw)] flex-col overflow-hidden font-code">
        <DialogHeader>
          <DialogTitle>{draft ? (draft.skillId ? `Edit ${draft.name}` : 'New custom skill') : 'Custom Skills'}</DialogTitle>
          <DialogDescription>
            Only personal skills created here are listed. External and project-local skills remain outside Agent Code management.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
          {draft ? (
            <>
              <label className="flex flex-col gap-1 text-[11px]">
                <span>Name {draft.skillId ? '(immutable)' : ''}</span>
                <input
                  aria-label="Skill name"
                  className="border border-input-border bg-input-bg px-2 py-1.5 text-ink"
                  value={draft.name}
                  readOnly={draft.skillId !== null}
                  placeholder="review-pull-request"
                  onChange={event => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px]">
                <span>Description</span>
                <input
                  aria-label="Skill description"
                  className="border border-input-border bg-input-bg px-2 py-1.5 text-ink"
                  value={draft.description}
                  placeholder="Review a pull request when the user asks for code review."
                  onChange={event => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <label className="flex items-center justify-between border border-control-border px-3 py-2 text-[11px]">
                <span>Enable for new agent sessions</span>
                <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
              </label>
              {preview !== null ? (
                <div className="flex min-h-0 flex-col gap-2">
                  <div className="flex items-center justify-between text-[11px] text-muted">
                    <span>Generated SKILL.md preview</span>
                    <button type="button" className="border border-control-border px-2 py-1" onClick={() => setPreview(null)}>Back to editor</button>
                  </div>
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap border border-input-border bg-input-bg p-3 text-[11px] text-ink">{preview}</pre>
                </div>
              ) : (
                <Textarea
                  aria-label="Skill instructions"
                  className="min-h-[280px] resize-y"
                  value={draft.markdown}
                  placeholder="# Workflow\n\nExplain what the agent should do and why."
                  onChange={event => {
                    setDraft({ ...draft, markdown: event.target.value })
                    setWarnings([])
                  }}
                />
              )}
              {warnings.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4 text-[10px] text-warning">
                  {warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} className="border border-control-border px-2 py-1 text-[11px] disabled:opacity-50" onClick={() => void showPreview()}>
                  Preview generated skill
                </button>
                <button type="button" className="border border-control-border px-2 py-1 text-[11px]" onClick={() => {
                  if (dirty && !window.confirm('Discard unsaved custom skill changes?')) return
                  setDraft(null)
                  setBaseDraft(null)
                  setConflictTargets([])
                  setError(null)
                }}>Back to skills</button>
              </div>
              {shownSkill?.targets.length ? <TargetList skill={shownSkill} targets={shownSkill.targets} /> : null}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted">{current.skills.length} Agent Code-authored skill{current.skills.length === 1 ? '' : 's'}</span>
                <Button variant="outline" size="sm" onClick={() => edit(emptyDraft())}>New skill…</Button>
              </div>
              {current.skills.length === 0 ? (
                <div className="border border-panel-border p-4 text-[11px] text-muted">Create an instruction-only personal skill. Installed and project-local skills are intentionally not imported here.</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {current.skills.map(skill => {
                    const blocked = blockedDelete?.skillId === skill.id ? blockedDelete.targets : []
                    const abandon = blocked.flatMap(target => target.conflictFingerprint
                      ? [{ targetId: target.id, expectedConflictFingerprint: target.conflictFingerprint }]
                      : [])
                    return (
                      <div key={skill.id} className="flex flex-col gap-2 border border-panel-border p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[12px] text-ink">{skill.name}</div>
                            <div className="mt-1 text-[10px] text-muted">{skill.description}</div>
                            <div className="mt-1 text-[10px] text-muted">{HEALTH_LABELS[skill.health]}</div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => edit(draftFromSkill(skill))}>Edit</Button>
                            <Button variant="outline" size="sm" disabled={busy || skill.health === 'recovery-required' || skill.health === 'unsupported'} onClick={() => void toggle(skill)}>
                              {skill.enabled ? 'Disable' : 'Enable'}
                            </Button>
                            <button type="button" disabled={busy} className="border border-danger px-2 py-1 text-[10px] text-danger disabled:opacity-50" onClick={() => void remove(skill)}>Delete</button>
                          </div>
                        </div>
                        {skill.targets.length ? <TargetList skill={skill} targets={skill.targets} /> : null}
                        {abandon.length > 0 ? (
                          <div className="flex items-center justify-between gap-2 border border-danger p-2 text-[10px] text-danger">
                            <span>Modified or historical files were preserved.</span>
                            <button type="button" className="border border-danger px-2 py-1" onClick={() => void remove(skill, abandon)}>
                              Leave files and forget skill
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {conflictTargets.length > 0 ? (
            <div className="border border-danger p-2 text-[10px] text-danger">
              {conflictTargets.map(target => <div key={target.id}>{target.displayPath || target.id} · {target.state}</div>)}
            </div>
          ) : null}
          {current.recovery ? (
            <div className="flex flex-col gap-2 border border-danger p-2 text-[10px] text-danger">
              <span>{current.recovery.message}</span>
              <div className="flex gap-2">
                <button type="button" className="border border-danger px-2 py-1" onClick={() => void window.api.revealAgentCodeCustomSkillsRecoveryFile()}>Reveal state file</button>
                <button type="button" className="border border-danger px-2 py-1" onClick={() => {
                  if (!window.confirm('Reset all unreadable Agent Code-managed skill state? Existing provider copies will be left untouched.')) return
                  void window.api.resetAgentCodeCustomSkillsRecovery().then(applyResult)
                }}>Reset state</button>
              </div>
            </div>
          ) : null}
          {error ? <div role="alert" className="border border-danger px-2 py-1 text-[11px] text-danger">{error}</div> : null}
        </div>

        <DialogFooter>
          <button type="button" className="border border-control-border px-2 py-1 text-[11px]" onClick={() => requestClose(false)}>Close</button>
          {draft ? (
            <button type="button" disabled={busy} className="border border-control-active-bg bg-control-active-bg px-3 py-1 text-[11px] text-control-active-fg disabled:opacity-50" onClick={() => void save()}>
              {draft.enabled ? 'Save & Enable' : 'Save draft'}
            </button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TargetList({ skill, targets }: {
  skill: AgentCodeCustomSkill
  targets: AgentCodeConventionsTargetStatus[]
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-panel-border pt-2 text-[10px]">
      {targets.map(target => (
        <div key={target.id} className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 truncate text-muted">{target.displayPath || target.id} · {target.state}</span>
          {!target.id.startsWith('unsupported:') ? (
            <button type="button" className="border border-control-border px-1.5 py-0.5" onClick={() => void window.api.revealAgentCodeCustomSkillTarget(skill.id, target.id)}>Reveal</button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
