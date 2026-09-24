import { useMemo, useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useAppStore } from '@renderer/app-state/hooks'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useSkillProviderColumns } from '@renderer/features/skills/lib/providerColumns'
import { applyInstalledSkillsResult, refreshSkills, useSkillsStore } from '@renderer/features/skills/store'
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
  const installed = useSkillsStore(state => state.installed)
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
      const chosen = found.selection.providers
      setProviders(new Set(Array.isArray(chosen) ? columns.filter(kind => chosen.includes(kind)) : columns))
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
        expectedRevision: installed?.revision ?? 0,
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
      <DialogContent className="flex max-h-[92vh] w-[min(860px,96vw)] flex-col overflow-hidden font-code">
        <DialogHeader>
          <DialogTitle>Add skills</DialogTitle>
          <DialogDescription>
            Paste an install command, a repository or a URL. Agent Code reviews the exact commit, shows every file, and never runs anything from the repository.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3 text-[11px]">
          <label className="flex flex-col gap-1">
            <span className="sr-only">Install command or source</span>
            <input
              aria-label="Install command or source"
              autoFocus
              className="border border-input-border bg-input-bg px-2 py-1.5 text-ink"
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
            <Button size="sm" variant="outline" disabled={busy || !parsed?.ok} onClick={() => void find()}>
              {busy && !discovery ? 'Looking…' : 'Find skills'}
            </Button>
          </div>
          {parsed?.ok && parsed.value.notices.length > 0 ? (
            parsed.value.notices.map(notice => <div key={notice} className="text-[10px] text-muted">{notice}</div>)
          ) : null}

          {discovery ? (
            <>
              <div className="flex items-center justify-between gap-2 border border-panel-border px-3 py-2 text-[10px] text-muted">
                {/* The ref is repository-controlled text; only the commit
                    hash is ours (#1049 re-review). */}
                <span className="min-w-0 truncate">
                  {withVisibleControls(discovery.repositoryUrl)} · {discovery.requestedRefType} {withVisibleControls(discovery.requestedRef)} → {discovery.resolvedCommit.slice(0, 7)}
                </span>
                <span className="shrink-0">{discovery.candidates.length} skill{discovery.candidates.length === 1 ? '' : 's'}</span>
              </div>
              {discovery.missingSkills.length > 0 ? (
                <div className="border border-warning p-2 text-[10px] text-warning">
                  Not found in this source: {discovery.missingSkills.map(name => withVisibleControls(name)).join(', ')}
                </div>
              ) : null}
              {discovery.notices.map(notice => (
                <div key={notice} className="border border-warning p-2 text-[10px] text-warning">{withVisibleControls(notice)}</div>
              ))}
              {discovery.candidates.length > 6 ? (
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Filter skills"
                    className="min-w-0 flex-1 border border-input-border bg-input-bg px-2 py-1 text-ink"
                    placeholder="Filter…"
                    value={filter}
                    onChange={event => setFilter(event.target.value)}
                  />
                  <Button size="xs" variant="outline" onClick={() => setSelected(new Set(visible.map(candidate => candidate.candidateId)))}>
                    Select all
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>None</Button>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                {visible.map(candidate => (
                  <label key={candidate.candidateId} className="flex items-start gap-3 border border-panel-border p-3">
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
          {error ? <div role="alert" className="border border-danger p-2 text-[10px] text-danger">{error}</div> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>
          <Button
            disabled={busy || !discovery || selected.size === 0 || providers.size === 0}
            onClick={() => void install()}
          >
            Install {selected.size} skill{selected.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
