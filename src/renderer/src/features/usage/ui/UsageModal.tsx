import { useEffect, useMemo, useState } from 'react'

import type {
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSpend,
} from '@preload/index'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  formatMoney,
  formatPercent,
  formatReset,
  providerLabel,
  severityBarStyle,
  severityTextStyle,
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
                  <div className="flex-shrink-0" style={severityTextStyle(row.severity)}>
                    {formatPercent(row.percent)}
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden bg-surface-hi">
                  <div className="h-full" style={{ width: `${width}%`, ...severityBarStyle(row.severity) }} />
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

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent className="flex max-h-[88vh] w-[min(760px,calc(100vw-2rem))] flex-col">
        <DialogHeader className="flex-row items-center justify-between gap-4">
          <div>
            <DialogTitle className="font-semibold">Usage</DialogTitle>
            <DialogDescription className="mt-0.5 text-[10px]">
              {fetchedLabel ?? 'Claude and Codex provider quotas'}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={loading}
              onClick={() => void refresh(true)}
              variant="secondary"
              size="sm"
              className="disabled:cursor-wait"
            >
              refresh
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="secondary" size="sm">
                close
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  )
}
