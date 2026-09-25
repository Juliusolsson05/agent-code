import { useMemo, useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useAppStore } from '@renderer/app-state/hooks'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Input } from '@renderer/components/ui/input'
import { Kbd } from '@renderer/components/ui/kbd'
import { useSkillProviderColumns } from '@renderer/features/skills/lib/providerColumns'
import { applyInstalledSkillsResult, currentSkillsRevision, refreshSkills } from '@renderer/features/skills/store'
import { CandidateDetails } from '@renderer/features/skills/ui/SkillReview'
import { describeSkillInstallInput, parseSkillInstallInput } from '@shared/skills/installSource'
import { withVisibleControls } from '@shared/text/visibleControls'
import type { AgentCodeInstalledSkillDiscovery } from '@shared/types/agentCodeInstalledSkills'
import type { AgentProviderKind } from '@shared/types/providerKind'

/**
 * Add skills (#1161): paste the command a README or skills.sh publishes, or
 * type a source to browse it.
 *
 * WHY one input for everything instead of a URL field plus pickers: people
 * copy `npx skills add owner/repo --skill name` from documentation, and
 * making them translate that into our own form is the friction the user
 * reported. The line under the input shows what was understood before
 * anything touches the network; main re-parses the same text as the
 * authority.
 */
export function AddSkillDialog() {
  const target = useAppStore(state => state.addSkillDialog)
  const close = useAppStore(state => state.closeAddSkillDialog)
  const columns = useSkillProviderColumns()
  const [input, setInput] = useState(target?.initialInput ?? '')
  const [discovery, setDiscovery] = useState<AgentCodeInstalledSkillDiscovery | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [providers, setProviders] = useState<Set<AgentProviderKind>>(new Set(columns))
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = useMemo(() => input.trim() ? parseSkillInstallInput(input) : null, [input])
  const visible = useMemo(() => {
    if (!discovery) return []
    const needle = filter.trim().toLowerCase()
    return needle
      ? discovery.candidates.filter(candidate => candidate.name.includes(needle)
        || candidate.description.toLowerCase().includes(needle))
      : discovery.candidates
  }, [discovery, filter])

  const find = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.discoverAgentCodeGitHubSkills(input)
      if (!result.ok) {
        setError(result.message)
        setDiscovery(null)
        return
      }
      const found = result.discovery
      setDiscovery(found)
      // A command that names skills (or `--skill '*'`/`--all`) preselects them;
      // browsing preselects nothing, except the only skill a source holds.
      const preselect = found.selection.skills !== null || found.candidates.length === 1
      setSelected(new Set(preselect ? found.candidates.map(candidate => candidate.candidateId) : []))
      // `-a` naming only agents Agent Code does not run (e.g. `-a cursor`)
      // leaves no provider; fall back to every column like the agent tool
      // does, and the parser's "ignored" notice explains why (review round 1).
      const chosen = found.selection.providers
      const fromCommand = Array.isArray(chosen) ? columns.filter(kind => chosen.includes(kind)) : columns
      setProviders(new Set(fromCommand.length > 0 ? fromCommand : columns))
      setFilter('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect that source.')
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    if (!discovery || selected.size === 0 || providers.size === 0) return
    setBusy(true)
    setError(null)
    try {
      // Every column ticked means "every provider", which the record stores
      // as no restriction — so a provider enabled later gets the skill too.
      const everyColumn = columns.every(kind => providers.has(kind))
      const result = await window.api.installAgentCodeGitHubSkills({
        expectedRevision: currentSkillsRevision(),
        discoveryId: discovery.discoveryId,
        candidateIds: [...selected],
        ...(everyColumn ? {} : { providers: [...providers] }),
      })
      const message = applyInstalledSkillsResult(result)
      if (message) {
        setError(message)
        return
      }
      void refreshSkills()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not install the selected skills.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (candidateId: string) => setSelected(current => {
    const next = new Set(current)
    if (next.has(candidateId)) next.delete(candidateId)
    else next.add(candidateId)
    return next
  })

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !busy) close() }}>
      <DialogContent
        size="lg"
        className="flex max-h-[92vh] flex-col overflow-hidden font-code"
        // In flight (find or install), nothing may hide the dialog (the k3
        // rule): onOpenChange already refused while busy; Escape and outside
        // clicks now do too, and Cancel disables with its ⎋ chip.
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>Add Skills</DialogTitle>
          <DialogDescription>
            Paste an install command, a repository or a URL. Agent Code reviews the exact commit, shows every file, and never runs anything from the repository.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3 text-[11px]">
          <label className="flex flex-col gap-1">
            <span className="sr-only">Install command or source</span>
            {/* The shared Input (plan T1/T4): this field was square and had
                no focus treatment beyond the browser outline. */}
            <Input
              aria-label="Install command or source"
              autoFocus
              className="h-8 text-[11px]"
              value={input}
              disabled={busy}
              placeholder="npx skills add vercel-labs/agent-skills --skill web-design-guidelines"
              onChange={event => {
                setInput(event.target.value)
                setDiscovery(null)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && parsed?.ok) void find()
              }}
            />
          </label>
          <div className="flex items-start justify-between gap-3 text-[10px]">
            <span className={parsed && !parsed.ok ? 'text-warning' : 'text-muted'}>
              {!parsed
                ? 'Also accepts owner/repo, owner/repo@skill, github.com/…/tree/<ref>/<path> and skills.sh pages. Leave out --skill to browse a repository.'
                : parsed.ok
                  ? <>Understood: {withVisibleControls(describeSkillInstallInput(parsed.value))}</>
                  : parsed.message}
            </span>
            {/* ↩ because Enter in the source field runs exactly this. */}
            <Button size="sm" variant="outline" disabled={busy || !parsed?.ok} onClick={() => void find()}>
              {busy && !discovery ? 'Looking…' : 'Find Skills'}
              {!busy ? <Kbd binding="Enter" /> : null}
            </Button>
          </div>
          {parsed?.ok && parsed.value.notices.length > 0 ? (
            parsed.value.notices.map(notice => <div key={notice} className="text-[10px] text-muted">{notice}</div>)
          ) : null}

          {discovery ? (
            <>
              <div className="rounded-slab flex items-center justify-between gap-2 border border-border px-3 py-2 text-[10px] text-muted">
                {/* The ref is repository-controlled text; only the commit
                    hash is ours (#1049 re-review). */}
                <span className="min-w-0 truncate">
                  {withVisibleControls(discovery.repositoryUrl)} · {discovery.requestedRefType} {withVisibleControls(discovery.requestedRef)} → {discovery.resolvedCommit.slice(0, 7)}
                </span>
                <span className="shrink-0">{discovery.candidates.length} skill{discovery.candidates.length === 1 ? '' : 's'}</span>
              </div>
              {discovery.missingSkills.length > 0 ? (
                <div className="rounded-slab border border-warning p-2 text-[10px] text-warning">
                  Not found in this source: {discovery.missingSkills.map(name => withVisibleControls(name)).join(', ')}
                </div>
              ) : null}
              {discovery.notices.map(notice => (
                <div key={notice} className="rounded-slab border border-warning p-2 text-[10px] text-warning">{withVisibleControls(notice)}</div>
              ))}
              {discovery.candidates.length > 6 ? (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Filter skills"
                    className="h-7 min-w-0 flex-1 text-[11px]"
                    placeholder="Filter…"
                    value={filter}
                    onChange={event => setFilter(event.target.value)}
                  />
                  <Button size="xs" variant="outline" onClick={() => setSelected(new Set(visible.map(candidate => candidate.candidateId)))}>
                    Select All
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>None</Button>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                {visible.map(candidate => (
                  <label key={candidate.candidateId} className="rounded-slab flex items-start gap-3 border border-border p-3 hover:bg-row-hover-bg">
                    <input
                      type="checkbox"
                      aria-label={`Install ${candidate.name}`}
                      checked={selected.has(candidate.candidateId)}
                      disabled={busy}
                      onChange={() => toggle(candidate.candidateId)}
                    />
                    <CandidateDetails candidate={candidate} />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-2 text-[11px]">
                <span className="text-muted">Install for:</span>
                {columns.map(kind => (
                  <label key={kind} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      aria-label={`Install for ${getRendererProviderCapabilities(kind).shortLabel}`}
                      checked={providers.has(kind)}
                      disabled={busy}
                      onChange={() => setProviders(current => {
                        const next = new Set(current)
                        if (next.has(kind)) next.delete(kind)
                        else next.add(kind)
                        return next
                      })}
                    />
                    {getRendererProviderCapabilities(kind).shortLabel}
                  </label>
                ))}
                <span className="text-[10px] text-muted">Pinned to commit {discovery.resolvedCommit.slice(0, 7)}; updates are always reviewed first.</span>
              </div>
            </>
          ) : null}
          {error ? <div role="alert" className="rounded-slab border border-danger p-2 text-[11px] text-danger">{error}</div> : null}
        </div>

        {/* Install writes a repository's skill files into provider folders:
            a deliberate press, no commit key (Enter in the source field is
            Find's). Guards carried over (k3): Cancel and Install wait while
            busy; Install also needs a discovery, a skill and a provider. */}
        <DialogActions
          confirmLabel={`Install ${selected.size} Skill${selected.size === 1 ? '' : 's'}`}
          confirmKey={null}
          confirmDisabled={busy || !discovery || selected.size === 0 || providers.size === 0}
          onConfirm={() => void install()}
          onCancel={close}
          cancelDisabled={busy}
          escapeCancels={!busy}
        />
      </DialogContent>
    </Dialog>
  )
}
