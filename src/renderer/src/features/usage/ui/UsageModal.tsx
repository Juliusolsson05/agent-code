import { useEffect, useMemo, useState } from 'react'

import type {
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSpend,
} from '@preload/index'
import {
  formatMoney,
  formatPercent,
  formatReset,
  providerLabel,
  severityClass,
  severityTextClass,
} from '@renderer/features/usage/model/formatUsage'

type Props = {
  open: boolean
  onClose: () => void
}

function LoadingSnapshot(): UsageSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    cache: { hit: false, ttlMs: 30_000 },
    providers: [
      {
        provider: 'claude',
        status: 'error',
        sourceLabel: 'Claude Code Keychain',
        message: 'Loading Claude usage...',
      },
      {
        provider: 'codex',
        status: 'error',
        sourceLabel: '~/.codex/auth.json',
        message: 'Loading Codex usage...',
      },
    ],
  }
}

function SpendPill({ label, spend }: { label: string; spend: UsageSpend | null }) {
  if (!spend) return null
  return (
    <div className="border border-border bg-surface-hi px-2 py-1 text-[10px] leading-none">
      <span className="text-muted">{label}</span>{' '}
      <span className="text-ink">{formatMoney(spend.amount, spend.currency)}</span>
    </div>
  )
}

function UsageProviderSection({ provider }: { provider: UsageProviderSnapshot }) {
  const title = providerLabel(provider.provider)
  if (provider.status === 'error') {
    return (
      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div>
            <div className="text-[12px] font-semibold text-ink">{title}</div>
            <div className="mt-0.5 text-[10px] text-muted">{provider.sourceLabel}</div>
          </div>
          <div className="text-[10px] uppercase text-muted">unavailable</div>
        </div>
        <div className="px-3 py-4 text-[11px] leading-snug text-muted">
          {provider.message}
        </div>
      </section>
    )
  }

  return (
    <section className="border border-border bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <div className="text-[12px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-[10px] text-muted">{provider.sourceLabel}</div>
        </div>
        <div className="text-right text-[10px] leading-snug">
          <div className="uppercase text-muted">plan</div>
          <div className="text-ink">{provider.plan ?? 'unknown'}</div>
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        {provider.rows.length === 0 ? (
          <div className="text-[11px] text-muted">No usage windows returned.</div>
        ) : (
          provider.rows.map(row => {
            const width = row.percent === null ? 0 : Math.max(0, Math.min(100, row.percent))
            const reset = formatReset(row.resetsAt)
            return (
              <div key={row.id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-[11px]">
                  <div className="min-w-0 truncate text-ink">{row.label}</div>
                  <div className={`flex-shrink-0 ${severityTextClass(row.severity)}`}>
                    {formatPercent(row.percent)}
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden bg-surface-hi">
                  <div className={`h-full ${severityClass(row.severity)}`} style={{ width: `${width}%` }} />
                </div>
                {(reset || row.detail) ? (
                  <div className="flex items-center justify-between gap-3 text-[10px] text-muted">
                    <div className="min-w-0 truncate">{row.detail}</div>
                    <div className="flex-shrink-0">{reset}</div>
                  </div>
                ) : null}
              </div>
            )
          })
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <SpendPill label="spend" spend={provider.spend} />
          <SpendPill label="extra" spend={provider.extraUsage} />
          <SpendPill label="credits" spend={provider.credits} />
        </div>
      </div>
    </section>
  )
}

export function UsageModal({ open, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visibleSnapshot = snapshot ?? (loading ? LoadingSnapshot() : null)

  const fetchedLabel = useMemo(() => {
    if (!snapshot) return null
    const date = new Date(snapshot.fetchedAt)
    if (Number.isNaN(date.getTime())) return null
    return `${date.toLocaleTimeString()}${snapshot.cache.hit ? ' cached' : ''}`
  }, [snapshot])

  const refresh = async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await window.api.getUsageSnapshot({ force }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load usage.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void refresh(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-canvas/80 p-4">
      <button
        type="button"
        aria-label="Close usage modal"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative flex max-h-[88vh] w-full max-w-[760px] flex-col border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-ink">Usage</div>
            <div className="mt-0.5 text-[10px] text-muted">
              {fetchedLabel ?? 'Claude and Codex provider quotas'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void refresh(true)}
              className="
                border border-border bg-surface-hi px-2.5 py-1
                text-[11px] text-ink transition-colors
                hover:border-accent disabled:cursor-wait disabled:text-muted
              "
            >
              refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="
                border border-border bg-surface-hi px-2.5 py-1
                text-[11px] text-muted transition-colors hover:text-ink
              "
            >
              close
            </button>
          </div>
        </header>

        <div className="overflow-auto p-4">
          {error ? (
            <div className="mb-3 border border-danger bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {error}
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            {visibleSnapshot?.providers.map(provider => (
              <UsageProviderSection key={provider.provider} provider={provider} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
