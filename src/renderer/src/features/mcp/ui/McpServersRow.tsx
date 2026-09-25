import { Switch } from '@renderer/components/ui/switch'
import { useState } from 'react'

import { providerSupportsBuiltInMcpDomain, type BuiltInMcpDefaults } from '@mcp/shared/types'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Settings } from '@renderer/app-state/settings/types'
import { Button } from '@renderer/components/ui/button'
import { BUILT_IN_MCP_SERVERS } from '@renderer/features/mcp/lib/builtInServers'
import { applyUserMcpResult, useUserMcpSnapshot } from '@renderer/features/mcp/store'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'
import { isUserMcpProvider, USER_MCP_PROVIDERS, type NativeMcpServer, type UserMcpServerView } from '@shared/userMcp/types'

type Props = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

/**
 * Settings → MCP grid (#1143, spec Revision 2): Agent Code's built-in servers
 * and the user's own servers in ONE table with one column per enabled
 * provider. Every checkbox means the same thing — "new agents of this provider
 * get it" — whichever kind of server the row is, which is the whole reason the
 * two previously separate surfaces were merged.
 *
 * Built-in defaults live in renderer Settings (they were already there);
 * user servers live in main's document. The row writes each to its owner and
 * never mirrors one into the other.
 */
export function McpServersRow({ settings, onChange }: Props) {
  const enabledKinds = useEnabledAgentProviderKinds()
  const providers = AGENT_PROVIDER_KINDS.filter(kind => enabledKinds.has(kind))
  const snapshot = useUserMcpSnapshot()
  const openDialog = useAppStore(state => state.openMcpServerDialog)
  const [error, setError] = useState<string | null>(null)
  const [nativeOpen, setNativeOpen] = useState(false)

  const defaults = settings.defaultBuiltInMcpDomains
  const setBuiltIn = (kind: AgentProviderKind, domain: (typeof BUILT_IN_MCP_SERVERS)[number]['domain'], on: boolean) => {
    const current = defaults[kind] ?? []
    const next: BuiltInMcpDefaults = {
      ...defaults,
      [kind]: on ? [...current.filter(item => item !== domain), domain] : current.filter(item => item !== domain),
    }
    onChange({ defaultBuiltInMcpDomains: next })
  }

  const run = async (operation: Promise<Parameters<typeof applyUserMcpResult>[0]>) => {
    setError(null)
    try {
      setError(applyUserMcpResult(await operation))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const columns = `minmax(0,1fr) repeat(${providers.length}, 56px) 72px`

  return (
    <div className="rounded-slab border border-border bg-surface text-[11px]">
      <div className="grid items-center gap-2 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wider text-muted" style={{ gridTemplateColumns: columns }}>
        <span>Server</span>
        {providers.map(kind => (
          <span key={kind} className="text-center">{getRendererProviderCapabilities(kind).shortLabel}</span>
        ))}
        <span />
      </div>

      <SectionHeading>Agent Code</SectionHeading>
      {BUILT_IN_MCP_SERVERS.map(server => (
        <div key={server.domain} className="grid items-center gap-2 px-3 py-1.5" style={{ gridTemplateColumns: columns }}>
          <div className="min-w-0">
            <span className="text-ink">{server.title}</span>
            <span className="ml-2 rounded-chip border border-border px-1 text-[10px] text-muted">built-in</span>
            <div className="truncate text-[10px] text-muted">{server.description}</div>
          </div>
          {providers.map(kind => providerSupportsBuiltInMcpDomain(kind, server.domain) ? (
            <Cell key={kind}>
              <Check
                checked={(defaults[kind] ?? []).includes(server.domain)}
                label={`${server.title} for new ${getRendererProviderCapabilities(kind).shortLabel} agents`}
                onChange={on => setBuiltIn(kind, server.domain, on)}
              />
            </Cell>
          ) : (
            <Unsupported key={kind} reason={`${getRendererProviderCapabilities(kind).shortLabel} provides this natively`} />
          ))}
          <span />
        </div>
      ))}
      <div className="px-3 pb-2 pt-1 text-[10px] text-muted">
        Root Management is per agent only and always asks for confirmation — use Agent MCP Servers… on one agent.
      </div>

      <SectionHeading
        action={<Button size="xs" variant="outline" onClick={() => openDialog({ mode: 'add' })}>Add Server…</Button>}
      >
        Your servers
      </SectionHeading>
      {snapshot?.storeProblem ? <Notice tone="warn">{snapshot.storeProblem}</Notice> : null}
      {snapshot?.claudeManagedPolicy ? (
        <Notice tone="warn">Your organization's Claude MCP policy is active, so your servers are not attached to Claude agents.</Notice>
      ) : null}
      {!snapshot ? <div className="px-3 py-2 text-muted">Loading…</div> : null}
      {snapshot && snapshot.servers.length === 0 ? (
        <div className="px-3 py-2 text-muted">
          No servers yet. Add one by pasting the config from its README — for example Beeper Desktop&apos;s.
        </div>
      ) : null}
      {snapshot?.servers.map(server => (
        <UserServerRow
          key={server.id}
          server={server}
          providers={providers}
          columns={columns}
          onToggleEnabled={() => void run(window.api.userMcpSetEnabled(server.id, !server.enabled))}
          onToggleProvider={(kind, on) => void run(window.api.userMcpSetProvider(server.id, kind, on))}
          onEdit={() => openDialog({ mode: 'edit', serverId: server.id })}
        />
      ))}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {snapshot && snapshot.native.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setNativeOpen(open => !open)}
            className="flex w-full items-center justify-between border-t border-border px-3 py-2 text-left text-[10px] uppercase tracking-wider text-muted outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
            aria-expanded={nativeOpen}
          >
            <span>{nativeOpen ? '▾' : '▸'} Also loaded by the CLIs directly (read-only)</span>
            <span>{snapshot.native.length}</span>
          </button>
          {nativeOpen ? snapshot.native.map(server => (
            <NativeServerRow
              key={`${server.provider}:${server.name}`}
              server={server}
              onCopyIn={() => void run(window.api.userMcpCopyNative(server.provider, server.name))}
            />
          )) : null}
        </>
      ) : null}

      <div className="border-t border-border px-3 py-2 text-[10px] text-muted">
        {/* The provider-wide "—" (a provider that cannot take user servers
            at all) is the same on every row, so it is explained once here
            rather than in a hover title per cell (K2-16). */}
        “—” means that provider cannot use the server. Changes apply to new agents, and to existing agents when they reload. Secrets are encrypted on this computer and passed to agents through environment variables — the agent itself can read them, like any tool it runs.
      </div>
    </div>
  )
}

function UserServerRow({
  server,
  providers,
  columns,
  onToggleEnabled,
  onToggleProvider,
  onEdit,
}: {
  server: UserMcpServerView
  providers: AgentProviderKind[]
  columns: string
  onToggleEnabled: () => void
  onToggleProvider: (kind: 'claude' | 'codex', on: boolean) => void
  onEdit: () => void
}) {
  const unsetSecrets = Object.values(server.secrets).filter(secret => !secret.set).length
  const setSecrets = Object.values(server.secrets).length - unsetSecrets
  return (
    <div className={`border-t border-border/50 px-3 py-1.5 ${server.enabled ? '' : 'opacity-60'}`}>
      <div className="grid items-center gap-2" style={{ gridTemplateColumns: columns }}>
        <div className="flex min-w-0 items-center gap-2">
          <Switch
            checked={server.enabled}
            aria-label={`${server.name} on or off everywhere`}
            onCheckedChange={() => onToggleEnabled()}
          />
          <div className="min-w-0">
            <span className="text-ink">{server.name}</span>
            {server.transport ? <span className="ml-2 text-[10px] text-muted">{server.transport}</span> : null}
            <div className="truncate text-[10px] text-muted" title={server.summary}>{server.summary}</div>
          </div>
        </div>
        {providers.map(kind => {
          if (!isUserMcpProvider(kind)) return <Unsupported key={kind} reason="Not supported yet" />
          const support = server.support[kind]
          if (!support.ok) return <Unsupported key={kind} reason={support.reason} />
          return (
            <Cell key={kind}>
              <Check
                checked={server.providers[kind]}
                label={`${server.name} for new ${getRendererProviderCapabilities(kind).shortLabel} agents`}
                disabled={!server.enabled}
                onChange={on => onToggleProvider(kind, on)}
              />
            </Cell>
          )
        })}
        <Button size="xs" variant="ghost" onClick={onEdit}>Edit…</Button>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 pl-7 text-[10px]">
        {setSecrets > 0 ? <span className="text-muted">🔑 {setSecrets} secret{setSecrets === 1 ? '' : 's'} set</span> : null}
        {server.problems.map(problem => (
          <span key={`${problem.kind}:${problem.message}`} className="text-warning">⚠ {problem.message}</span>
        ))}
        {/* Why a provider column shows "—" for THIS server (K2-16). It was
            only in the cell's hover title; the cell is not focusable, so a
            keyboard user could not learn it at all. */}
        {USER_MCP_PROVIDERS.flatMap(kind => {
          const support = server.support[kind]
          // Only for columns on screen: a provider switched off in Settings
          // has no "—" to explain.
          return support.ok || !providers.includes(kind) ? [] : [
            <span key={`unsupported:${kind}`} className="text-muted">
              — {getRendererProviderCapabilities(kind).shortLabel}: {support.reason}
            </span>,
          ]
        })}
      </div>
    </div>
  )
}

function NativeServerRow({ server, onCopyIn }: { server: NativeMcpServer; onCopyIn: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <span className="text-ink">{server.name}</span>
        <span className="ml-2 text-[10px] text-muted">{getRendererProviderCapabilities(server.provider).shortLabel} · {server.source}</span>
        <div className="truncate text-[10px] text-muted">{server.summary}</div>
        {/* The disabled Copy in's reason, visible (it was the button's hover
            title, and a disabled button is out of the Tab order). */}
        {!server.copyable ? (
          <div className="text-[10px] text-muted">Cannot be copied: not a standard MCP config.</div>
        ) : null}
      </div>
      <Button
        size="xs"
        variant="outline"
        disabled={!server.copyable}
        title={server.copyable ? 'Manage a copy here and share it with the other provider' : undefined}
        onClick={onCopyIn}
      >
        Copy In
      </Button>
    </div>
  )
}

function SectionHeading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider text-muted">
      <span>{children}</span>
      {action}
    </div>
  )
}

function Notice({ children, tone }: { children: React.ReactNode; tone: 'warn' | 'danger' }) {
  return <div className={`px-3 py-1.5 text-[10px] ${tone === 'danger' ? 'text-danger' : 'text-warning'}`}>{children}</div>
}

function Cell({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-center">{children}</div>
}

function Unsupported({ reason }: { reason: string }) {
  return <div className="text-center text-muted" title={reason} aria-label={reason}>—</div>
}

export function Check({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-3.5 w-3.5 items-center justify-center border text-[10px] leading-none disabled:opacity-40 ${
        checked ? 'border-control-active-bg bg-control-active-bg text-control-active-fg' : 'border-control-border-hover bg-transparent'
      }`}
    >
      {checked ? '✓' : ''}
    </button>
  )
}
