import { useMemo, useState } from 'react'

import {
  providerSupportsBuiltInMcpDomain,
  type BuiltInMcpDomain,
  type BuiltInMcpOverrides,
} from '@mcp/shared/types'
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
import { BUILT_IN_MCP_SERVERS } from '@renderer/features/mcp/lib/builtInServers'
import { useUserMcpSnapshot } from '@renderer/features/mcp/store'
import { Check } from '@renderer/features/mcp/ui/McpServersRow'
import { ROOT_MANAGEMENT_DOMAIN } from '@renderer/features/workspace/lib/rootManagement'
import { reloadSessionWithBuiltInMcpOverrides } from '@renderer/workspace/builtInMcpReload'
import { resolveSessionBuiltInMcpDomains, sessionMcpOverrides } from '@renderer/workspace/mcpDomains'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { isUserMcpProvider, userMcpOverrideKey, type UserMcpServerView } from '@shared/userMcp/types'

type Row = {
  key: BuiltInMcpDomain | `user:${string}`
  title: string
  detail: string
  /** What the agent gets from Settings alone, before its own choice. */
  inherited: boolean
  /** Why this row cannot be turned on for this agent, if it cannot. */
  blocked?: string
  /** What the running process actually has (main-reported). */
  attached: boolean
  /** Set when the server cannot attach yet (missing secret, invalid config).
   * A reload would not change anything, so it never counts as pending. */
  problem?: boolean
}

/**
 * "Agent MCP Servers…" (#1143, spec Revision 2 §5): every MCP server the
 * focused agent could have — Agent Code's own and the user's — with the
 * choices STAGED and applied in ONE reload.
 *
 * WHY staged: the MCP server list is fixed when a provider process launches,
 * so every change is a reload. The ten per-capability commands this replaces
 * each reloaded on their own, so turning three things on meant three reloads
 * of a live conversation. Here the user edits a draft and pays one.
 *
 * Choices are written as explicit overrides into the pane's existing override
 * map (user servers under `user:<id>` keys), through the one reload owner every
 * capability change already uses (reloadSessionWithBuiltInMcpOverrides).
 */
export function AgentMcpServersModal() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.agentMcpServersSessionId)
  const close = useAppStore(state => state.closeAgentMcpServers)
  const openRootPrompt = useAppStore(state => state.openRootManagementPrompt)
  const defaults = useAppStore(state => state.settings.defaultBuiltInMcpDomains)
  const snapshot = useUserMcpSnapshot()
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  const provider = isAgentProviderKind(kind) ? kind : null

  const saved = useMemo(() => (meta ? sessionMcpOverrides(meta) : {}), [meta])
  const [draft, setDraft] = useState<BuiltInMcpOverrides | null>(null)
  const current = draft ?? saved

  const rows = useMemo((): Row[] => {
    if (!provider || !meta) return []
    const inheritedDomains = resolveSessionBuiltInMcpDomains({ provider, sessionOverrides: {}, defaultDomains: defaults })
    const builtIns: Row[] = BUILT_IN_MCP_SERVERS
      .filter(server => providerSupportsBuiltInMcpDomain(provider, server.domain))
      .map(server => ({
        key: server.domain,
        title: server.title,
        detail: server.description,
        inherited: inheritedDomains.includes(server.domain),
        attached: Boolean(meta.builtInMcpDomains?.includes(server.domain)),
      }))
    const root: Row[] = providerSupportsBuiltInMcpDomain(provider, ROOT_MANAGEMENT_DOMAIN)
      ? [{
          key: ROOT_MANAGEMENT_DOMAIN,
          title: 'Root Management',
          detail: 'Application-wide control of Agent Code. Asks for confirmation.',
          inherited: false,
          attached: Boolean(meta.builtInMcpDomains?.includes(ROOT_MANAGEMENT_DOMAIN)),
        }]
      : []
    const users: Row[] = (snapshot?.servers ?? []).map(server => userRow(server, provider, meta.userMcpServerIds ?? []))
    return [...builtIns, ...root, ...users]
  }, [defaults, meta, provider, snapshot])

  if (!sessionId || !meta || !provider) {
    return null
  }

  const effective = (row: Row) => current[row.key] ?? row.inherited
  const changed = JSON.stringify(normalize(current)) !== JSON.stringify(normalize(saved))
  // Built-in rows only. A user server can be requested and still not attach
  // for launch-time reasons the renderer cannot see (a name in the project's
  // own .codex/config.toml, a keyring hiccup): counting those would leave Apply
  // permanently armed, and every Apply would reload the conversation for
  // nothing and raise the same "wasn't attached" notice again.
  const pendingReload = rows.some(row =>
    !row.key.startsWith('user:') && !row.blocked && !row.problem && effective(row) !== row.attached)

  const toggle = (row: Row) => {
    const next = !effective(row)
    const base = { ...current }
    // An explicit choice that equals what Settings would give anyway is
    // dropped rather than stored, so this agent keeps following Settings for
    // that server — the difference between "on because I said so" and "on
    // because it is the default" is exactly what the status column shows.
    if (next === row.inherited && row.key !== ROOT_MANAGEMENT_DOMAIN) delete base[row.key]
    else base[row.key] = next
    setDraft(base)
  }

  const apply = async () => {
    const overrides = { ...current }
    const grantsRoot = overrides[ROOT_MANAGEMENT_DOMAIN] === true
      && !meta.builtInMcpDomains?.includes(ROOT_MANAGEMENT_DOMAIN)
    close()
    setDraft(null)
    // Removing Goal Loop's tools ENDS a running loop (#1045 review; this rule
    // came with the retired Goal Loop MCP command). The loop is harness-owned
    // and would survive the reload, but the reloaded agent could no longer
    // call goal_loop_complete, so every continuation would run to the cap.
    // Stopped BEFORE the reload so it names the session id the loop is filed
    // under, not the replacement's. try/catch because a preload without the
    // channel throws synchronously; the reload the user asked for still runs.
    const goalLoopRow = rows.find(row => row.key === 'goal_loop')
    const stopGoalLoop = Boolean(meta.builtInMcpDomains?.includes('goal_loop') && goalLoopRow && !effective(goalLoopRow))
    if (grantsRoot) {
      // The confirmation dialog owns every root grant (#906). It receives the
      // rest of the draft so one confirmed reload applies everything — and the
      // goal-loop stop, which must only happen if that reload really runs: a
      // declined confirmation reloads nothing, so stopping here first would
      // kill a loop whose tools the agent still has.
      const { [ROOT_MANAGEMENT_DOMAIN]: _root, ...rest } = overrides
      openRootPrompt(sessionId, rest, stopGoalLoop)
      return
    }
    if (stopGoalLoop) {
      try { await window.api.controlGoalLoop({ sessionId, action: 'stop' }) } catch { /* reload anyway */ }
    }
    void reloadSessionWithBuiltInMcpOverrides(workspace, sessionId, overrides, {
      reloaded: 'Reloaded with updated MCP servers',
      failed: 'MCP reload failed',
    })
  }

  const label = [meta.title, getRendererProviderCapabilities(provider).shortLabel].filter(Boolean).join(' · ')

  return (
    <Dialog open onOpenChange={open => { if (!open) { setDraft(null); close() } }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Agent MCP servers</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col overflow-y-auto px-4 py-2 text-[11px]">
          {rows.map(row => {
            const on = effective(row)
            const explicit = current[row.key] !== undefined
            return (
              <div key={row.key} className="flex items-center gap-3 border-b border-border/50 py-1.5 last:border-b-0">
                <Check
                  checked={on && !row.blocked}
                  disabled={Boolean(row.blocked)}
                  label={`${row.title} for this agent`}
                  onChange={() => toggle(row)}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-ink">{row.title}</span>
                  {row.key.startsWith('user:') ? null : (
                    <span className="ml-2 rounded-chip border border-border px-1 text-[9px] text-muted">built-in</span>
                  )}
                  <div className="truncate text-[10px] text-muted">{row.detail}</div>
                </div>
                <span className="shrink-0 text-[10px] text-muted">
                  {row.blocked
                    ? row.blocked
                    : explicit
                      ? `● ${on ? 'on' : 'off'} for this agent`
                      : 'default'}
                </span>
              </div>
            )
          })}
          {rows.length === 0 ? <div className="py-2 text-muted">No MCP servers apply to this agent.</div> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDraft({})} title="Clear this agent's choices so it follows Settings → MCP">
            Reset to MCP settings
          </Button>
          <span className="flex-1 text-[10px] text-muted">
            {changed ? 'Changes pending' : pendingReload ? 'Settings changed since this agent started' : ''}
          </span>
          <Button variant="outline" onClick={() => { setDraft(null); close() }}>Cancel</Button>
          <Button disabled={!changed && !pendingReload} onClick={() => void apply()}>Apply &amp; reload agent</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function userRow(server: UserMcpServerView, provider: string, attachedIds: readonly string[]): Row {
  const key = userMcpOverrideKey(server.id)
  const base = {
    key,
    title: server.name,
    detail: server.summary,
    attached: attachedIds.includes(server.id),
  }
  if (!isUserMcpProvider(provider)) return { ...base, inherited: false, blocked: 'not supported yet' }
  if (!server.enabled) return { ...base, inherited: false, blocked: 'off in Settings → MCP' }
  const support = server.support[provider]
  if (!support.ok) return { ...base, inherited: false, blocked: support.reason }
  // A structural problem or missing secret does not block the choice — the
  // user may be about to fix it — but it is shown so "on" is not mistaken for
  // "attached".
  const problem = server.problems[0]
  return {
    ...base,
    inherited: server.providers[provider],
    ...(problem ? { detail: `⚠ ${problem.message}`, problem: true } : {}),
  }
}

function normalize(overrides: BuiltInMcpOverrides): [string, boolean][] {
  return Object.entries(overrides)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    .sort(([a], [b]) => a.localeCompare(b))
}
