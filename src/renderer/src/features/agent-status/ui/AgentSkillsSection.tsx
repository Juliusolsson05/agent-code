import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT } from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import { isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionKind } from '@shared/types/providerKind'
import type { AgentSkillSource, AgentSkillsSnapshot } from '@shared/types/agentSkills'

const sourceLabels: Record<AgentSkillSource, string> = {
  'agent-code': 'Agent Code',
  personal: 'Personal',
  project: 'Project',
  system: 'System',
  plugin: 'Plugin',
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: AgentSkillsSnapshot }

export function AgentSkillsSection(props: { sessionId: string; kind: SessionKind; cwd: string }) {
  // Remount on identity changes, before effects run, so even the first paint
  // for a newly focused agent cannot contain the previous agent's inventory.
  return <SkillInventory key={JSON.stringify([props.sessionId, props.kind, props.cwd])} kind={props.kind} cwd={props.cwd} />
}

function SkillInventory({ kind, cwd }: { kind: SessionKind; cwd: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [revision, setRevision] = useState(0)
  const agent = isAgentProviderKind(kind)

  useEffect(() => {
    if (!isAgentProviderKind(kind)) return
    let cancelled = false
    setState({ status: 'loading' })
    // The wrapper keys this section by session/provider/cwd. The cancellation fence
    // additionally handles refreshes while an earlier filesystem scan is still
    // pending: a slower response must never replace a newer inventory.
    void (async () => {
      try {
        const snapshot = await window.api.listAgentSkills({ provider: kind, cwd })
        if (!cancelled) setState({ status: 'ready', snapshot })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    })()
    return () => { cancelled = true }
  }, [kind, cwd, revision])

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, refresh)
  }, [])

  return (
    <section className="rounded-slab border border-border bg-canvas" aria-label="Installed Skills">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
          Installed Skills{agent && state.status === 'ready' ? ` · ${state.snapshot.skills.length}` : ''}
        </div>
        {agent ? (
          <Button variant="ghost" size="xs" onClick={() => setRevision(value => value + 1)} aria-label="Refresh installed skills">
            Refresh
          </Button>
        ) : null}
      </div>
      {!agent ? (
        <p className="px-2 py-2 text-muted">Shell terminals do not have agent skills.</p>
      ) : (
        <>
          <p className="px-2 py-2 text-muted">
            Installed skills for this provider and project. Provider settings control availability; a running agent may need a reload after changes.
          </p>
          {state.status === 'loading' ? <p role="status" className="px-2 pb-2 text-muted">Loading installed skills…</p> : null}
          {state.status === 'error' ? <p role="alert" className="px-2 pb-2 text-danger">Could not load installed skills. Refresh to try again.</p> : null}
          {state.status === 'ready' ? (
            <>
              {state.snapshot.skills.length === 0 ? <p className="px-2 pb-2 text-muted">No installed skills found in the checked locations.</p> : (
                <ul className="divide-y divide-border/70">
                  {state.snapshot.skills.map(skill => (
                    <li key={skill.path} className="min-w-0 px-2 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words font-code text-ink">{skill.name}</span>
                        <span className="shrink-0 text-[10px] text-muted">{sourceLabels[skill.source]}</span>
                      </div>
                      {skill.sourceLabel ? <div className="break-words text-ink-dim">{skill.sourceLabel}</div> : null}
                      {skill.description ? <p className="mt-1 break-words text-ink-dim">{skill.description}</p> : null}
                      <details className="mt-1 text-muted">
                        <summary className="cursor-pointer">Location</summary>
                        <p className="mt-1 break-all font-code">{skill.path}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              {state.snapshot.notices.length > 0 ? (
                <div className="border-t border-border px-2 py-2 text-warning">
                  {state.snapshot.notices.map(notice => <p key={notice} className="break-words [&+p]:mt-2">{notice}</p>)}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  )
}
