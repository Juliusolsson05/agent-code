import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Settings } from '@renderer/app-state/settings/types'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Check } from '@renderer/features/mcp/ui/McpServersRow'
import {
  chosenSkillProviders,
  toggledSkillProviders,
  useSkillProviderColumns,
  useSupportedSkillProviders,
  visibleSkillProviders,
} from '@renderer/features/skills/lib/providerColumns'
import {
  applyCustomSkillsResult,
  applyInstalledSkillsResult,
  checkAllSkillsForUpdates,
  checkSkillForUpdates,
  clearSkillUpdate,
  currentSkillsRevision,
  refreshSkills,
  useSkillsStore,
  useSkillsSync,
  type SkillUpdateState,
} from '@renderer/features/skills/store'
import { UpdateReviewPanel } from '@renderer/features/skills/ui/SkillReview'
import { withVisibleControls } from '@shared/text/visibleControls'
import type { AgentCodeConventionsTargetStatus } from '@shared/types/agentCodeConventions'
import type { AgentCodeCustomSkill } from '@shared/types/agentCodeCustomSkills'
import type { AgentCodeInstalledSkill } from '@shared/types/agentCodeInstalledSkills'
import type { ExternalAgentSkill } from '@shared/types/agentSkills'
import type { AgentProviderKind } from '@shared/types/providerKind'

type Props = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

const HEALTH_LABELS: Record<AgentCodeInstalledSkill['health'], string> = {
  disabled: 'Off',
  active: 'Active',
  degraded: 'Degraded',
  conflict: 'Conflict',
  unsupported: 'Unsupported',
  'recovery-required': 'Recovery required',
}

/**
 * Settings → Skills (#1161): every personal skill the user's agents can load,
 * in ONE grid with a column per provider — the MCP grid's shape (#1143).
 *
 * WHY one grid instead of the three rows it replaces (Custom Skills,
 * Installed Skills and a GitHub-only modal): the question users actually ask
 * is "which skills do my Codex agents get?", and that needs every source side
 * by side, including the ones other tools installed. Every checkbox means the
 * same thing in every section: agents of this provider get it.
 *
 * There is no count limit anywhere on this page. The footer shows the real
 * constraint, each agent's context budget for skill descriptions.
 */
export function SkillsGrid({ settings, onChange }: Props) {
  useSkillsSync()
  const installed = useSkillsStore(state => state.installed)
  const custom = useSkillsStore(state => state.custom)
  const external = useSkillsStore(state => state.external)
  const updates = useSkillsStore(state => state.updates)
  const loadError = useSkillsStore(state => state.loadError)
  const openAddSkill = useAppStore(state => state.openAddSkillDialog)
  const updateCheckRequest = useAppStore(state => state.skillUpdateCheckRequest)
  const columns = useSkillProviderColumns()
  const supported = useSupportedSkillProviders()
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [externalOpen, setExternalOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [blockedDelete, setBlockedDelete] = useState<{ skillId: string; targets: AgentCodeConventionsTargetStatus[] } | null>(null)
  const handledCheckRequest = useRef(updateCheckRequest)

  // "Check Skill Updates" bumps a counter; the grid owns running the checks.
  useEffect(() => {
    if (updateCheckRequest === handledCheckRequest.current) return
    handledCheckRequest.current = updateCheckRequest
    void (async () => {
      if (!useSkillsStore.getState().installed) await refreshSkills()
      await checkAllSkillsForUpdates()
    })()
  }, [updateCheckRequest])

  const run = async (operation: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    try {
      setError(await operation())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const matches = (name: string, description: string) =>
    !needle || name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)
  const productSkills = (custom?.skills ?? []).filter(skill => skill.managedBy)
  const yourSkills = (custom?.skills ?? []).filter(skill => !skill.managedBy && matches(skill.name, skill.description))
  const installedSkills = (installed?.skills ?? []).filter(skill => matches(skill.name, skill.description))
  const hidden = new Set(settings.hiddenExternalSkills)
  const externalSkills = (external?.skills ?? []).filter(skill => matches(skill.name, skill.description))
  const isHidden = (skill: ExternalAgentSkill) =>
    skill.locations.every(location => hidden.has(`${location.targetId}:${location.folder}`))
  const shownExternal = showHidden ? externalSkills : externalSkills.filter(skill => !isHidden(skill))
  const hiddenCount = externalSkills.length - externalSkills.filter(skill => !isHidden(skill)).length
  const updatesAvailable = Object.values(updates).filter(update => update.kind === 'update-available').length

  const gridColumns = `minmax(0,1fr) repeat(${columns.length}, 56px) 96px`
  const budget = useMemo(() => descriptionBudget(custom?.skills ?? [], installed?.skills ?? [], external?.skills ?? []), [custom, installed, external])

  const setInstalledProviders = (skill: AgentCodeInstalledSkill, kind: AgentProviderKind, on: boolean) => {
    const next = toggledSkillProviders(skill.providers, supported, kind, on)
    if (next === 'empty') {
      setError(`Turn ${skill.name} off instead of removing its last provider.`)
      return
    }
    void run(async () => applyInstalledSkillsResult(await window.api.setAgentCodeInstalledSkillProviders({
      expectedRevision: currentSkillsRevision(),
      skillId: skill.id,
      providers: next,
    })))
  }
  const setCustomProviders = (skill: AgentCodeCustomSkill, kind: AgentProviderKind, on: boolean) => {
    const next = toggledSkillProviders(skill.providers, supported, kind, on)
    if (next === 'empty') {
      setError(`Turn ${skill.name} off instead of removing its last provider.`)
      return
    }
    void run(async () => applyCustomSkillsResult(await window.api.setAgentCodeCustomSkillProviders({
      expectedRevision: currentSkillsRevision(),
      skillId: skill.id,
      providers: next,
    })))
  }
  const toggleInstalled = async (skill: AgentCodeInstalledSkill) => {
    if (skill.enabled && !(await requestConfirm({
      title: `Turn ${skill.name} off?`,
      description: 'Agent Code removes its copies from the provider folders.',
      confirmLabel: 'Turn Off',
      tone: 'danger',
    }))) return
    // Not `danger`: turning a skill ON removes nothing. It is still a
    // deliberate review gate, so it asks — but Enter-to-confirm is fine here.
    if (!skill.enabled && skill.pendingReview && !(await requestConfirm({
      title: `An agent proposed ${skill.name}.`,
      description: 'Review its source and files (⋯ → Source) before turning it on. Turn it on now?',
      confirmLabel: 'Turn On',
    }))) return
    void run(async () => applyInstalledSkillsResult(await window.api.setAgentCodeInstalledSkillEnabled({
      expectedRevision: currentSkillsRevision(),
      skillId: skill.id,
      enabled: !skill.enabled,
    })))
  }
  const toggleCustom = async (skill: AgentCodeCustomSkill) => {
    if (skill.enabled && !(await requestConfirm({
      title: `Turn ${skill.name} off?`,
      description: 'Managed provider copies will be removed.',
      confirmLabel: 'Turn Off',
      tone: 'danger',
    }))) return
    void run(async () => applyCustomSkillsResult(await window.api.setAgentCodeCustomSkillEnabled({
      expectedRevision: currentSkillsRevision(),
      skillId: skill.id,
      enabled: !skill.enabled,
    })))
  }
  const removeInstalled = async (
    skill: AgentCodeInstalledSkill,
    abandonTargets?: Array<{ targetId: string; expectedConflictFingerprint: string }>,
  ) => {
    const wording = abandonTargets
      ? `Leave ${abandonTargets.length} external folder${abandonTargets.length === 1 ? '' : 's'} untouched and forget ${skill.name}?`
      : `Remove ${skill.name}? Agent Code removes its copies from the provider folders and its stored source.`
    if (!(await requestConfirm({
      title: wording,
      confirmLabel: abandonTargets ? 'Forget Skill' : 'Remove Skill',
      tone: 'danger',
    }))) return
    void run(async () => {
      const result = await window.api.deleteAgentCodeInstalledSkill({
        expectedRevision: currentSkillsRevision(),
        skillId: skill.id,
        abandonTargets,
      })
      if (!result.ok && result.code === 'delete-blocked') setBlockedDelete({ skillId: skill.id, targets: result.targets })
      else if (result.ok) {
        setBlockedDelete(null)
        clearSkillUpdate(skill.id)
      }
      return applyInstalledSkillsResult(result)
    })
  }
  const applyUpdate = (skill: AgentCodeInstalledSkill, update: Extract<SkillUpdateState, { kind: 'update-available' }>) => {
    void run(async () => {
      const message = applyInstalledSkillsResult(await window.api.applyAgentCodeInstalledSkillUpdate({
        expectedRevision: currentSkillsRevision(),
        skillId: skill.id,
        discoveryId: update.discovery.discoveryId,
        candidateId: update.candidate.candidateId,
      }))
      if (!message) clearSkillUpdate(skill.id)
      return message
    })
  }
  const setHidden = (skill: ExternalAgentSkill, hide: boolean) => {
    const keys = skill.locations.map(location => `${location.targetId}:${location.folder}`)
    const next = hide
      ? [...new Set([...settings.hiddenExternalSkills, ...keys])]
      : settings.hiddenExternalSkills.filter(key => !keys.includes(key))
    onChange({ hiddenExternalSkills: next })
  }

  return (
    <div className="rounded-slab border border-border bg-surface text-[11px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <input
          aria-label="Filter skills"
          className="min-w-[160px] flex-1 border border-input-border bg-input-bg px-2 py-1 text-ink"
          placeholder="Filter skills…"
          value={filter}
          onChange={event => setFilter(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={busy || (installed?.skills.length ?? 0) === 0}
          onClick={() => void checkAllSkillsForUpdates()}
        >
          Check updates{updatesAvailable > 0 ? ` (${updatesAvailable})` : ''}
        </Button>
        <Button size="xs" onClick={() => openAddSkill()}>+ Add Skill…</Button>
      </div>

      <div className="grid items-center gap-2 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wider text-muted" style={{ gridTemplateColumns: gridColumns }}>
        <span>Skill</span>
        {columns.map(kind => (
          <span key={kind} className="text-center">{getRendererProviderCapabilities(kind).shortLabel}</span>
        ))}
        <span />
      </div>

      {installed?.recovery ? (
        <div role="alert" className="flex flex-col gap-2 border-b border-danger px-3 py-2 text-[10px] text-danger">
          <span>{installed.recovery.message}</span>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => void window.api.revealAgentCodeInstalledSkillsRecoveryFile()}>Reveal state file</Button>
            <Button size="xs" variant="outline" onClick={async () => {
              if (!(await requestConfirm({
                title: 'Reset all Agent Code-managed skill state?',
                description: 'Existing provider folders are left untouched.',
                confirmLabel: 'Reset State',
                tone: 'danger',
              }))) return
              void run(async () => applyInstalledSkillsResult(await window.api.resetAgentCodeInstalledSkillsRecovery()))
            }}>Reset managed skill state</Button>
          </div>
        </div>
      ) : null}

      {productSkills.length > 0 ? (
        <>
          <SectionHeading>Agent Code</SectionHeading>
          {productSkills.map(skill => (
            <div key={skill.id} className="grid items-center gap-2 px-3 py-1.5" style={{ gridTemplateColumns: gridColumns }}>
              <div className="min-w-0">
                <span className="text-ink">{skill.name}</span>
                <span className="ml-2 rounded-chip border border-border px-1 text-[9px] text-muted">managed</span>
                <div className="truncate text-[10px] text-muted">
                  Follows the {skill.managedBy === 'goal' ? 'Goal' : 'TLDR'} MCP server for each agent.
                </div>
              </div>
              {columns.map(kind => <div key={kind} className="text-center text-[10px] text-muted">auto</div>)}
              <span />
            </div>
          ))}
        </>
      ) : null}

      <SectionHeading>Your skills <span className="normal-case tracking-normal">· written in Agent Code; create and edit them under Custom Skills below</span></SectionHeading>
      {custom && yourSkills.length === 0 ? <Empty>{needle ? 'No matches.' : 'None yet.'}</Empty> : null}
      {yourSkills.map(skill => (
        <SkillRow
          key={skill.id}
          name={skill.name}
          description={skill.description}
          enabled={skill.enabled}
          columns={columns}
          gridColumns={gridColumns}
          chosen={chosenSkillProviders(skill.providers, supported)}
          visible={visibleSkillProviders(skill.targets)}
          disabled={busy}
          onToggle={() => void toggleCustom(skill)}
          onProvider={(kind, on) => setCustomProviders(skill, kind, on)}
          status={skill.health === 'active' || skill.health === 'disabled' ? null : `${HEALTH_LABELS[skill.health] ?? skill.health}`}
          targets={skill.targets}
        />
      ))}

      <SectionHeading>Installed <span className="normal-case tracking-normal">· from sources, pinned to a reviewed commit</span></SectionHeading>
      {!installed ? <Empty>{loadError ?? 'Loading…'}</Empty> : null}
      {installed && installedSkills.length === 0 ? (
        <Empty>{needle ? 'No matches.' : 'Nothing installed yet. Paste an `npx skills add …` command from a README or skills.sh.'}</Empty>
      ) : null}
      {installedSkills.map(skill => {
        const update = updates[skill.id]
        const blocked = blockedDelete?.skillId === skill.id ? blockedDelete.targets : []
        return (
          <SkillRow
            key={skill.id}
            name={skill.name}
            description={skill.description}
            enabled={skill.enabled}
            columns={columns}
            gridColumns={gridColumns}
            chosen={chosenSkillProviders(skill.providers, supported)}
            visible={visibleSkillProviders(skill.targets)}
            disabled={busy || skill.health === 'recovery-required'}
            onToggle={() => void toggleInstalled(skill)}
            onProvider={(kind, on) => setInstalledProviders(skill, kind, on)}
            badge={skill.pendingReview ? 'proposed by an agent · review' : undefined}
            source={`${skill.source.owner}/${skill.source.repository}${skill.source.path ? ` · ${skill.source.path}` : ''} @ ${skill.source.resolvedCommit.slice(0, 7)}`}
            status={skill.health === 'active' || skill.health === 'disabled' ? null : HEALTH_LABELS[skill.health]}
            warnings={skill.warnings}
            targets={skill.targets}
            menu={(
              <SkillMenu
                label={skill.name}
                items={[
                  { label: 'Check for update', onSelect: () => void checkSkillForUpdates(skill.id) },
                  { label: 'Reveal source', onSelect: () => void window.api.revealAgentCodeInstalledSkillSource(skill.id).then(result => { if (!result.ok) setError(result.message ?? 'Could not reveal the source.') }) },
                  ...skill.targets.filter(target => target.state === 'installed' || target.state === 'conflict').map(target => ({
                    label: `Reveal in ${target.displayPath}`,
                    onSelect: () => void window.api.revealAgentCodeInstalledSkillTarget(skill.id, target.id).then(result => { if (!result.ok) setError(result.message ?? 'Could not reveal that folder.') }),
                  })),
                  { label: 'Copy install command', onSelect: () => void navigator.clipboard?.writeText(installCommandFor(skill)) },
                  { label: 'Remove…', danger: true, onSelect: () => void removeInstalled(skill) },
                ]}
              />
            )}
          >
            <UpdateLine
              update={update}
              onApply={review => applyUpdate(skill, review)}
              onDismiss={() => clearSkillUpdate(skill.id)}
              disabled={busy}
            />
            {blocked.length > 0 ? (
              <div className="mt-1 flex flex-col gap-1 border border-danger p-2 text-[10px] text-danger">
                <span>External or historical copies were preserved. Review them before Agent Code forgets this skill.</span>
                {blocked.every(target => target.conflictFingerprint) ? (
                  <Button size="xs" variant="outline" className="self-start" onClick={() => removeInstalled(
                    skill,
                    blocked.map(target => ({ targetId: target.id, expectedConflictFingerprint: target.conflictFingerprint! })),
                  )}>Leave external copies and forget skill</Button>
                ) : null}
              </div>
            ) : null}
          </SkillRow>
        )
      })}

      <button
        type="button"
        onClick={() => setExternalOpen(open => !open)}
        className="flex w-full items-center justify-between border-t border-border px-3 py-2 text-left text-[10px] uppercase tracking-wider text-muted outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
        aria-expanded={externalOpen}
      >
        <span>{externalOpen ? '▾' : '▸'} Also found on this machine (not managed by Agent Code)</span>
        <span>{external ? externalSkills.length - hiddenCount : '…'}{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}</span>
      </button>
      {externalOpen ? (
        <>
          {shownExternal.length === 0 ? <Empty>No other personal skills found.</Empty> : (
            // The ● / — cells explained themselves only in hover titles on
            // non-focusable cells (K2-18). One visible key for the whole list.
            <div className="px-3 pb-1 text-[10px] text-muted">● agents of that provider load it · — not in a folder that provider reads</div>
          )}
          {shownExternal.map(skill => (
            <ExternalRow
              key={skill.name}
              skill={skill}
              columns={columns}
              gridColumns={gridColumns}
              hidden={isHidden(skill)}
              onReveal={location => void window.api.revealExternalAgentSkill(location.targetId, location.folder).then(result => { if (!result.ok) setError(result.message ?? 'Could not reveal that folder.') })}
              onHide={hide => setHidden(skill, hide)}
              onManage={() => openAddSkill(skill.provenance ? `npx skills add ${skill.provenance.source} --skill ${skill.name}` : '')}
            />
          ))}
          {hiddenCount > 0 ? (
            <div className="px-3 pb-2">
              <Button size="xs" variant="ghost" onClick={() => setShowHidden(value => !value)}>{showHidden ? 'Hide hidden skills' : `Show ${hiddenCount} hidden`}</Button>
            </div>
          ) : null}
          {external?.notices.map(notice => <div key={notice} className="px-3 py-1 text-[10px] text-warning">{notice}</div>)}
        </>
      ) : null}

      {error ? <div role="alert" className="border-t border-border px-3 py-2 text-[10px] text-danger">{error}</div> : null}

      <div className="border-t border-border px-3 py-2 text-[10px] text-muted">
        {budget.count} skill{budget.count === 1 ? '' : 's'} on · about {budget.tokens.toLocaleString()} tokens of names and descriptions per agent.
        {' '}There is no limit on how many skills you keep: Claude budgets about 1% of its context for this list and Codex about 2%, and both shorten descriptions rather than drop skills.
        {' '}New agents get changes; Claude and OpenCode also notice them live.
      </div>
    </div>
  )
}

function SkillRow({
  name,
  description,
  enabled,
  columns,
  gridColumns,
  chosen,
  visible,
  disabled,
  onToggle,
  onProvider,
  badge,
  source,
  status,
  warnings = [],
  targets,
  menu,
  children,
}: {
  name: string
  description: string
  enabled: boolean
  columns: AgentProviderKind[]
  gridColumns: string
  chosen: Set<AgentProviderKind>
  visible: Set<AgentProviderKind>
  disabled: boolean
  onToggle: () => void
  onProvider: (kind: AgentProviderKind, on: boolean) => void
  badge?: string
  source?: string
  status?: string | null
  warnings?: string[]
  targets: AgentCodeConventionsTargetStatus[]
  menu?: React.ReactNode
  children?: React.ReactNode
}) {
  const problems = targets.filter(target => target.state === 'conflict' || target.state === 'error' || target.state === 'retired')
  return (
    <div role="group" aria-label={`Skill ${name}`} className={`border-t border-border/50 px-3 py-1.5 ${enabled ? '' : 'opacity-70'}`}>
      <div className="grid items-center gap-2" style={{ gridTemplateColumns: gridColumns }}>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`${name} on or off`}
            disabled={disabled}
            onClick={onToggle}
            className={`h-3 w-5 shrink-0 rounded-full border disabled:opacity-50 ${enabled ? 'border-control-active-bg bg-control-active-bg' : 'border-control-border bg-transparent'}`}
          />
          <div className="min-w-0">
            <span className="text-ink">{name}</span>
            {badge ? <span className="ml-2 rounded-chip border border-warning px-1 text-[9px] text-warning">{badge}</span> : null}
            {status ? <span className="ml-2 text-[10px] text-warning">{status}</span> : null}
            {/* Descriptions and paths are repository-controlled (#1049). */}
            <div className="truncate text-[10px] text-muted" title={description}>{withVisibleControls(description)}</div>
            {source ? <div className="truncate text-[10px] text-muted">{withVisibleControls(source)}</div> : null}
          </div>
        </div>
        {columns.map(kind => {
          const shortLabel = getRendererProviderCapabilities(kind).shortLabel
          const sharedOnly = !chosen.has(kind) && enabled && visible.has(kind)
          return (
            <div key={kind} className="flex flex-col items-center">
              {/* Editable while OFF too (review round 1): the user must be able
                  to adjust an agent's proposed provider choice BEFORE turning
                  it on, and a disabled skill only records the field (D7). */}
              <Check
                checked={chosen.has(kind)}
                label={`${name} for ${shortLabel} agents`}
                disabled={disabled}
                onChange={on => onProvider(kind, on)}
              />
              {sharedOnly ? (
                // "shared" meant nothing without its hover title (K2-18); the
                // explanation is now its accessible name as well.
                <span className="text-[9px] text-muted" title={`${shortLabel} reads a folder this skill is installed in`} aria-label={`shared: ${shortLabel} reads a folder this skill is installed in`}>shared</span>
              ) : null}
            </div>
          )
        })}
        <div className="flex justify-end">{menu}</div>
      </div>
      {warnings.length > 0 ? (
        <ul className="mt-0.5 list-disc pl-11 text-[10px] text-warning">
          {warnings.map(warning => <li key={warning}>{withVisibleControls(warning)}</li>)}
        </ul>
      ) : null}
      {problems.map(target => (
        <div key={target.id} className="mt-0.5 pl-7 text-[10px] text-warning">
          ⚠ {withVisibleControls(target.displayPath)} — {target.message ?? target.state}
        </div>
      ))}
      {children ? <div className="pl-7">{children}</div> : null}
    </div>
  )
}

function UpdateLine({
  update,
  onApply,
  onDismiss,
  disabled,
}: {
  update: SkillUpdateState | undefined
  onApply: (review: Extract<SkillUpdateState, { kind: 'update-available' }>) => void
  onDismiss: () => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!update) return null
  if (update.kind === 'checking') return <div className="text-[10px] text-muted">Checking for an update…</div>
  if (update.kind === 'up-to-date') return <div className="text-[10px] text-muted">Up to date.</div>
  if (update.kind === 'error') return <div className="text-[10px] text-warning">Update check failed: {update.message}</div>
  const changed = update.changes.added.length + update.changes.changed.length + update.changes.removed.length
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[10px] text-accent">
        {/* ↑, not ⟳: ⟳ is the app's "loading" spinner (the pocket strip spins
            it), so it read as "checking…" here (UI pass, G-25). */}
        <span>↑ Update available · {changed} file{changed === 1 ? '' : 's'} changed</span>
        <Button size="xs" variant="outline" onClick={() => setOpen(value => !value)}>{open ? 'Hide Review' : 'Review…'}</Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
      {open ? (
        <div className="border border-panel-border p-2">
          <UpdateReviewPanel review={update} />
          <div className="mt-2 flex justify-end">
            <Button size="xs" disabled={disabled} onClick={() => onApply(update)}>Apply Reviewed Update</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ExternalRow({
  skill,
  columns,
  gridColumns,
  hidden,
  onReveal,
  onHide,
  onManage,
}: {
  skill: ExternalAgentSkill
  columns: AgentProviderKind[]
  gridColumns: string
  hidden: boolean
  onReveal: (location: ExternalAgentSkill['locations'][number]) => void
  onHide: (hide: boolean) => void
  onManage: () => void
}) {
  const visible = new Set(skill.locations.flatMap(location => location.providers))
  return (
    <div className={`border-t border-border/50 px-3 py-1.5 ${hidden ? 'opacity-50' : ''}`}>
      <div className="grid items-center gap-2" style={{ gridTemplateColumns: gridColumns }}>
        <div className="min-w-0 pl-7">
          <span className="text-ink">{skill.name}</span>
          {skill.provenance ? <span className="ml-2 text-[10px] text-muted">{skill.provenance.installer} · {withVisibleControls(skill.provenance.source)}</span> : null}
          <div className="truncate text-[10px] text-muted" title={skill.description}>{withVisibleControls(skill.description)}</div>
          <div className="truncate text-[10px] text-muted">
            {skill.locations.map(location => `${location.displayPath}${location.linked ? ' (link)' : ''}`).join(' · ')}
          </div>
        </div>
        {columns.map(kind => (
          <div key={kind} className="text-center text-muted" title={visible.has(kind) ? 'Agents of this provider can load it' : 'Not in a folder this provider reads'}>
            {/* The glyph is decoration for assistive tech; the words are the
                cell's content (K2-18). */}
            <span aria-hidden="true">{visible.has(kind) ? '●' : '—'}</span>
            <span className="sr-only">{visible.has(kind) ? 'loaded by' : 'not read by'} {getRendererProviderCapabilities(kind).shortLabel}</span>
          </div>
        ))}
        <div className="flex justify-end">
          <SkillMenu
            label={skill.name}
            items={[
              ...skill.locations.map(location => ({ label: `Reveal ${location.displayPath}`, onSelect: () => onReveal(location) })),
              {
                label: 'Manage with Agent Code…',
                onSelect: () => {
                  // Adopting the folder is not possible (it has no ownership
                  // record), so managing means reinstalling after it is gone.
                  void requestConfirm({
                    title: `Agent Code can only manage ${skill.name} after the existing folder is removed.`,
                    description: `${skill.provenance ? `For example: npx skills remove -g ${skill.name}. ` : ''}Open Add skills with its source?`,
                    confirmLabel: 'Open Add Skills',
                  }).then(confirmed => {
                    if (confirmed) onManage()
                  })
                },
              },
              { label: hidden ? 'Show' : 'Hide', onSelect: () => onHide(!hidden) },
            ]}
          />
        </div>
      </div>
    </div>
  )
}

// WHY the shared DropdownMenu (keyboard-first plan M2): this menu was a
// hand-rolled `role="menu"` div with NO keyboard handling — no focus entry,
// no arrows, no Escape — and it closed on `mouseLeave`, so a keyboard user
// who opened it with Enter had nothing to move to, and a mouse user who
// drifted one pixel outside lost it mid-aim. Radix owns focus entry, roving
// items, typeahead, Escape back to ⋯, and layering above Settings.
function SkillMenu({ label, items }: { label: string; items: Array<{ label: string; onSelect: () => void; danger?: boolean }> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" aria-label={`Actions for ${label}`}>⋯</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px] max-w-[360px]">
        {items.map(item => (
          <DropdownMenuItem
            key={item.label}
            danger={item.danger}
            // onSelect runs after Radix closes the menu and restores focus to
            // ⋯ — so a confirm opened by the item (Remove…) returns focus to
            // the row's own trigger when it closes, not to the page top.
            onSelect={() => item.onSelect()}
          >
            <span className="truncate">{item.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider text-muted">{children}</div>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-[10px] text-muted">{children}</div>
}

/**
 * The line that reproduces this install with `npx skills` elsewhere.
 *
 * WHY `#ref` is always included (review round 1): without it `npx skills`
 * resolves the default branch, so a skill installed from a tag or another
 * branch would copy as a command for a different package. Including the ref
 * even when it is the default branch is harmless and needs no guess about
 * which branch is the default.
 */
function installCommandFor(skill: AgentCodeInstalledSkill): string {
  const source = `${skill.source.owner}/${skill.source.repository}${skill.source.path ? `/${skill.source.path}` : ''}`
  return `npx skills add ${source}#${skill.source.requestedRef} --skill ${skill.name}`
}

/**
 * An estimate of what the skill listing costs each agent, from the enabled
 * skills' names and descriptions at ~4 characters per token.
 *
 * WHY an estimate is shown instead of a cap: the CLIs themselves decide what
 * fits and shorten descriptions when the list is long. The number tells the
 * user when that is starting to happen; refusing skills would not.
 */
function descriptionBudget(
  custom: AgentCodeCustomSkill[],
  installed: AgentCodeInstalledSkill[],
  external: ExternalAgentSkill[],
): { count: number; tokens: number } {
  const entries = [
    ...custom.filter(skill => skill.enabled),
    ...installed.filter(skill => skill.enabled),
    ...external,
  ]
  const characters = entries.reduce((total, skill) => total + skill.name.length + skill.description.length + 8, 0)
  return { count: entries.length, tokens: Math.round(characters / 4) }
}
