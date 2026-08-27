import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT,
  announceAgentCodeManagedSkillsChange,
  type AgentCodeManagedSkillsChange,
} from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import type { AgentCodeConventionsTargetStatus } from '@shared/types/agentCodeConventions.js'
import type {
  AgentCodeInstalledSkill,
  AgentCodeInstalledSkillCandidate,
  AgentCodeInstalledSkillDiscovery,
  AgentCodeInstalledSkillsMutationResult,
  AgentCodeInstalledSkillsSnapshot,
  AgentCodeInstalledSkillUpdateResult,
} from '@shared/types/agentCodeInstalledSkills.js'

const HEALTH_LABELS: Record<AgentCodeInstalledSkill['health'], string> = {
  disabled: 'Disabled',
  active: 'Active',
  degraded: 'Degraded',
  conflict: 'Conflict',
  unsupported: 'Unsupported',
  'recovery-required': 'Recovery required',
}

type UpdateReview = Extract<AgentCodeInstalledSkillUpdateResult, {
  ok: true
  kind: 'update-available'
}> & { skillId: string }

function mutationMessage(result: AgentCodeInstalledSkillsMutationResult): string {
  if (result.ok) return ''
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'Managed skills changed elsewhere. Reload and retry.'
  if (result.code === 'unsupported') return 'A registered provider does not support personal skills.'
  return 'Managed skill state needs recovery before it can be changed.'
}

export function AgentCodeInstalledSkillsRow() {
  const [snapshot, setSnapshot] = useState<AgentCodeInstalledSkillsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revisionRef = useRef(-1)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.auditAgentCodeInstalledSkills()
      revisionRef.current = next.revision
      setSnapshot(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load installed skills.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const onManagedSkillsChanged = (event: Event) => {
      const change = (event as CustomEvent<AgentCodeManagedSkillsChange>).detail
      if (!change || change.source === 'installed-skills' || change.revision <= revisionRef.current) return
      void refresh()
    }
    window.addEventListener(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, onManagedSkillsChanged)
    return () => window.removeEventListener(
      AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT,
      onManagedSkillsChanged,
    )
  }, [refresh])

  const acceptSnapshot = (next: AgentCodeInstalledSkillsSnapshot) => {
    revisionRef.current = next.revision
    setSnapshot(next)
    setError(null)
    announceAgentCodeManagedSkillsChange({ source: 'installed-skills', revision: next.revision })
  }

  if (!snapshot) {
    return <div className="text-[11px] italic text-muted">{error ?? 'Loading installed skills…'}</div>
  }
  const active = snapshot.skills.filter(skill => skill.enabled).length
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between border border-control-border bg-control-bg px-3 py-2">
        <div className="text-[11px] text-ink">
          {snapshot.skills.length === 0
            ? 'No GitHub-installed skills'
            : `${snapshot.skills.length} skill${snapshot.skills.length === 1 ? '' : 's'} · ${active} active`}
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(true)}>
          Manage installed skills…
        </Button>
      </div>
      {error ? <div role="alert" className="text-[11px] text-danger">{error}</div> : null}
      <InstalledSkillsModal
        open={open}
        snapshot={snapshot}
        onOpenChange={setOpen}
        onSnapshot={acceptSnapshot}
      />
    </div>
  )
}

function InstalledSkillsModal({
  open,
  snapshot,
  onOpenChange,
  onSnapshot,
}: {
  open: boolean
  snapshot: AgentCodeInstalledSkillsSnapshot
  onOpenChange: (open: boolean) => void
  onSnapshot: (snapshot: AgentCodeInstalledSkillsSnapshot) => void
}) {
  const [current, setCurrent] = useState(snapshot)
  const [url, setUrl] = useState('')
  const [discovery, setDiscovery] = useState<AgentCodeInstalledSkillDiscovery | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [updateReview, setUpdateReview] = useState<UpdateReview | null>(null)
  const [blockedDelete, setBlockedDelete] = useState<{
    skillId: string
    targets: AgentCodeConventionsTargetStatus[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setCurrent(snapshot)
    setUrl('')
    setDiscovery(null)
    setSelected(new Set())
    setUpdateReview(null)
    setBlockedDelete(null)
    setError(null)
    setNotice(null)
  }, [open, snapshot])

  useEffect(() => {
    if (open && wasOpen.current && snapshot.revision > current.revision) setCurrent(snapshot)
  }, [current.revision, open, snapshot])

  const replaceSnapshot = (next: AgentCodeInstalledSkillsSnapshot) => {
    setCurrent(next)
    onSnapshot(next)
  }

  const applyResult = (result: AgentCodeInstalledSkillsMutationResult): boolean => {
    if ('snapshot' in result) replaceSnapshot(result.snapshot)
    setError(mutationMessage(result) || null)
    return result.ok
  }

  const discover = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.discoverAgentCodeGitHubSkills(url)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setDiscovery(result.discovery)
      setSelected(new Set(result.discovery.candidates.map(candidate => candidate.candidateId)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect that GitHub repository.')
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    if (!discovery || selected.size === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.installAgentCodeGitHubSkills({
        expectedRevision: current.revision,
        discoveryId: discovery.discoveryId,
        candidateIds: [...selected],
      })
      if (applyResult(result)) {
        setDiscovery(null)
        setSelected(new Set())
        setUrl('')
        setNotice('The reviewed skills were installed. New agent sessions will discover them.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not install the reviewed skills.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (skill: AgentCodeInstalledSkill) => {
    if (skill.enabled
      && !window.confirm(`Disable ${skill.name}? Agent Code-owned provider package files will be removed.`)) return
    setBusy(true)
    setError(null)
    try {
      applyResult(await window.api.setAgentCodeInstalledSkillEnabled({
        expectedRevision: current.revision,
        skillId: skill.id,
        enabled: !skill.enabled,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the installed skill.')
    } finally {
      setBusy(false)
    }
  }

  const checkUpdate = async (skill: AgentCodeInstalledSkill) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.checkAgentCodeInstalledSkillForUpdates(skill.id)
      if (!result.ok) setError(result.message)
      else if (result.kind === 'up-to-date') setNotice(`${skill.name} is up to date.`)
      else setUpdateReview({ ...result, skillId: skill.id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check the GitHub source.')
    } finally {
      setBusy(false)
    }
  }

  const applyUpdate = async () => {
    if (!updateReview) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.applyAgentCodeInstalledSkillUpdate({
        expectedRevision: current.revision,
        skillId: updateReview.skillId,
        discoveryId: updateReview.discovery.discoveryId,
        candidateId: updateReview.candidate.candidateId,
      })
      if (applyResult(result)) {
        setNotice(`${updateReview.candidate.name} was updated to the reviewed snapshot.`)
        setUpdateReview(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply the reviewed update.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (
    skill: AgentCodeInstalledSkill,
    abandonTargets?: Array<{ targetId: string; expectedConflictFingerprint: string }>,
  ) => {
    const wording = abandonTargets
      ? `Leave ${abandonTargets.length} external package${abandonTargets.length === 1 ? '' : 's'} untouched and forget ${skill.name}?`
      : `Remove ${skill.name}? Agent Code-owned provider files and its immutable source snapshot will be removed.`
    if (!window.confirm(wording)) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.deleteAgentCodeInstalledSkill({
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
      setError(cause instanceof Error ? cause.message : 'Could not remove the installed skill.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="flex max-h-[92vh] w-[min(940px,96vw)] flex-col overflow-hidden font-code">
        <DialogHeader>
          <DialogTitle>{updateReview ? `Review update for ${updateReview.candidate.name}` : discovery ? 'Review GitHub skills' : 'Installed Skills'}</DialogTitle>
          <DialogDescription>
            GitHub packages remain source-managed and separate from skills authored in Agent Code. Discovery never executes repository content; updates are always manual.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
          {updateReview ? (
            <UpdateReviewPanel review={updateReview} />
          ) : discovery ? (
            <DiscoveryReview
              discovery={discovery}
              selected={selected}
              disabled={busy}
              onToggle={candidateId => setSelected(currentSelected => {
                const next = new Set(currentSelected)
                if (next.has(candidateId)) next.delete(candidateId)
                else next.add(candidateId)
                return next
              })}
            />
          ) : (
            <>
              <div className="flex flex-col gap-2 border border-panel-border p-3">
                <label className="flex flex-col gap-1 text-[11px]">
                  <span>Public GitHub repository or skill directory URL</span>
                  <input
                    aria-label="GitHub skill URL"
                    className="border border-input-border bg-input-bg px-2 py-1.5 text-ink"
                    value={url}
                    disabled={busy}
                    placeholder="https://github.com/owner/repository/tree/main/skills/example"
                    onChange={event => setUrl(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && url.trim()) void discover()
                    }}
                  />
                </label>
                <div className="flex items-center justify-between gap-3 text-[10px] text-muted">
                  <span>Public repositories only. No checkout, scripts, submodules, or automatic updates.</span>
                  <Button variant="outline" size="sm" disabled={busy || !url.trim()} onClick={() => void discover()}>
                    {busy ? 'Inspecting…' : 'Discover skills'}
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted">{current.skills.length} GitHub-installed skill{current.skills.length === 1 ? '' : 's'}</span>
                <button type="button" disabled={busy} className="border border-control-border px-2 py-1 text-[10px] disabled:opacity-50" onClick={() => {
                  void window.api.auditAgentCodeInstalledSkills().then(replaceSnapshot).catch(cause => {
                    setError(cause instanceof Error ? cause.message : 'Could not refresh installed skills.')
                  })
                }}>Refresh deployment</button>
              </div>
              {current.skills.length === 0 ? (
                <div className="border border-panel-border p-4 text-[11px] text-muted">
                  Install a reviewed, commit-pinned Agent Skills package from GitHub. Custom and project-local skills stay outside this list.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {current.skills.map(skill => (
                    <InstalledSkillRow
                      key={skill.id}
                      skill={skill}
                      busy={busy}
                      blockedTargets={blockedDelete?.skillId === skill.id ? blockedDelete.targets : []}
                      onToggle={() => void toggle(skill)}
                      onCheckUpdate={() => void checkUpdate(skill)}
                      onRemove={approvals => void remove(skill, approvals)}
                      onError={setError}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {current.recovery ? (
            <div role="alert" className="flex flex-col gap-2 border border-danger p-3 text-[10px] text-danger">
              <span>{current.recovery.message}</span>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="border border-danger px-2 py-1" onClick={() => void window.api.revealAgentCodeInstalledSkillsRecoveryFile()}>Reveal state file</button>
                <button type="button" className="border border-danger px-2 py-1" onClick={() => {
                  if (!window.confirm('Reset all Agent Code-managed skill state? Existing external files are left untouched.')) return
                  void window.api.resetAgentCodeInstalledSkillsRecovery().then(applyResult)
                }}>Reset managed skill state</button>
              </div>
            </div>
          ) : null}
          {notice ? <div role="status" className="border border-accent p-2 text-[10px] text-accent">{notice}</div> : null}
          {error ? <div role="alert" className="border border-danger p-2 text-[10px] text-danger">{error}</div> : null}
        </div>

        <DialogFooter>
          {updateReview ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setUpdateReview(null)}>Cancel</Button>
              <Button disabled={busy} onClick={() => void applyUpdate()}>Apply reviewed update</Button>
            </>
          ) : discovery ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => {
                setDiscovery(null)
                setSelected(new Set())
              }}>Back</Button>
              <Button disabled={busy || selected.size === 0} onClick={() => void install()}>
                Install {selected.size} selected skill{selected.size === 1 ? '' : 's'}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DiscoveryReview({
  discovery,
  selected,
  disabled,
  onToggle,
}: {
  discovery: AgentCodeInstalledSkillDiscovery
  selected: Set<string>
  disabled: boolean
  onToggle: (candidateId: string) => void
}) {
  return (
    <>
      <div className="border border-panel-border p-3 text-[10px] text-muted">
        <div>{discovery.repositoryUrl}</div>
        <div className="mt-1">Ref {discovery.requestedRef} · commit {discovery.resolvedCommit.slice(0, 12)}</div>
      </div>
      {discovery.notices.map(notice => (
        <div key={notice} className="border border-warning p-2 text-[10px] text-warning">{notice}</div>
      ))}
      {discovery.candidates.map(candidate => (
        <div key={candidate.candidateId} className="flex items-start gap-3 border border-panel-border p-3">
          <input
            type="checkbox"
            aria-label={`Install ${candidate.name}`}
            checked={selected.has(candidate.candidateId)}
            disabled={disabled}
            onChange={() => onToggle(candidate.candidateId)}
          />
          <CandidateDetails candidate={candidate} />
        </div>
      ))}
    </>
  )
}

function CandidateDetails({ candidate }: { candidate: AgentCodeInstalledSkillCandidate }) {
  return (
    <div className="min-w-0 flex-1 text-[10px]">
      <div className="text-[12px] text-ink">{candidate.name}</div>
      <div className="mt-1 text-muted">{candidate.description}</div>
      <div className="mt-1 text-muted">
        {candidate.source.path || 'repository root'} · {candidate.files.length} files · {formatBytes(candidate.totalBytes)}
      </div>
      {candidate.warnings.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-warning">
          {candidate.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-muted">Review package files</summary>
        <ul className="mt-1 max-h-40 overflow-auto border border-panel-border p-2 text-muted">
          {candidate.files.map(file => (
            <li key={file.path}>{file.executable ? 'executable · ' : ''}{file.path} · {formatBytes(file.bytes)}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

function UpdateReviewPanel({ review }: { review: UpdateReview }) {
  return (
    <>
      <div className="border border-panel-border p-3 text-[10px] text-muted">
        <div>{review.candidate.source.repositoryUrl}</div>
        <div className="mt-1">New commit {review.candidate.source.resolvedCommit.slice(0, 12)}</div>
      </div>
      <div className="grid grid-cols-1 gap-2 text-[10px] md:grid-cols-3">
        <ChangeList title="Added" paths={review.changes.added} />
        <ChangeList title="Changed" paths={review.changes.changed} />
        <ChangeList title="Removed" paths={review.changes.removed} />
      </div>
      <CandidateDetails candidate={review.candidate} />
    </>
  )
}

function ChangeList({ title, paths }: { title: string; paths: string[] }) {
  return (
    <div className="border border-panel-border p-2">
      <div className="text-ink">{title} · {paths.length}</div>
      {paths.length > 0 ? <ul className="mt-1 space-y-1 text-muted">{paths.map(path => <li key={path}>{path}</li>)}</ul> : null}
    </div>
  )
}

function InstalledSkillRow({
  skill,
  busy,
  blockedTargets,
  onToggle,
  onCheckUpdate,
  onRemove,
  onError,
}: {
  skill: AgentCodeInstalledSkill
  busy: boolean
  blockedTargets: AgentCodeConventionsTargetStatus[]
  onToggle: () => void
  onCheckUpdate: () => void
  onRemove: (approvals?: Array<{ targetId: string; expectedConflictFingerprint: string }>) => void
  onError: (message: string) => void
}) {
  const approvals = blockedTargets.flatMap(target => target.conflictFingerprint
    ? [{ targetId: target.id, expectedConflictFingerprint: target.conflictFingerprint }]
    : [])
  return (
    <div role="group" aria-label={`Installed skill ${skill.name}`} className="flex flex-col gap-2 border border-panel-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[10px]">
          <div className="text-[12px] text-ink">{skill.name}</div>
          <div className="mt-1 text-muted">{skill.description}</div>
          <div className="mt-1 break-all text-muted">{skill.source.skillUrl}</div>
          <div className="mt-1 text-muted">
            {HEALTH_LABELS[skill.health]} · commit {skill.source.resolvedCommit.slice(0, 12)} · {skill.files.length} files · {formatBytes(skill.totalBytes)}
          </div>
        </div>
        <div className="flex max-w-[360px] flex-wrap justify-end gap-2">
          <Button aria-label={`Reveal source for ${skill.name}`} variant="outline" size="sm" disabled={busy} onClick={() => {
            void window.api.revealAgentCodeInstalledSkillSource(skill.id).then(result => {
              if (!result.ok) onError(result.message ?? 'Could not reveal source snapshot.')
            })
          }}>Source</Button>
          <Button aria-label={`Check ${skill.name} for updates`} variant="outline" size="sm" disabled={busy} onClick={onCheckUpdate}>Check updates</Button>
          <Button aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`} variant="outline" size="sm" disabled={busy || skill.health === 'recovery-required' || skill.health === 'unsupported'} onClick={onToggle}>
            {skill.enabled ? 'Disable' : 'Enable'}
          </Button>
          <button type="button" aria-label={`Remove ${skill.name}`} disabled={busy} className="border border-danger px-2 py-1 text-[10px] text-danger disabled:opacity-50" onClick={() => onRemove()}>Remove</button>
        </div>
      </div>
      {skill.warnings.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4 text-[10px] text-warning">
          {skill.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      <TargetList skill={skill} onError={onError} />
      {blockedTargets.length > 0 ? (
        <div className="flex flex-col gap-2 border border-danger p-2 text-[10px] text-danger">
          <span>External or historical package files were preserved. Review the targets before forgetting ownership.</span>
          {approvals.length === blockedTargets.length ? (
            <button type="button" disabled={busy} className="self-start border border-danger px-2 py-1" onClick={() => onRemove(approvals)}>
              Leave external packages and forget skill
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TargetList({
  skill,
  onError,
}: {
  skill: AgentCodeInstalledSkill
  onError: (message: string) => void
}) {
  if (skill.targets.length === 0) return null
  return (
    <div className="flex flex-col gap-1 text-[10px] text-muted">
      {skill.targets.map(target => (
        <div key={target.id} className="flex items-center justify-between gap-2 border border-control-border px-2 py-1">
          <span className="min-w-0 break-all">{target.providers.join(' + ') || 'Historical'} · {target.state} · {target.displayPath}</span>
          {target.state === 'installed' || target.state === 'conflict' ? (
            <button type="button" className="shrink-0 border border-control-border px-2 py-0.5" onClick={() => {
              void window.api.revealAgentCodeInstalledSkillTarget(skill.id, target.id).then(result => {
                if (!result.ok) onError(result.message ?? 'Could not reveal installed target.')
              })
            }}>Reveal</button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
