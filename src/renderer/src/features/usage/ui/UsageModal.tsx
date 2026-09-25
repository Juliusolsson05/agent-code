import { useEffect, useMemo, useState } from 'react'

import type {
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSpend,
  UsageSourceId,
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
import { useAppStore } from '@renderer/app-state/hooks'
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

function SpendPill({ label, spend }: { label: string; spend: UsageSpend | null }) {
  if (!spend) return null
  return (
    <div className="rounded-slab border border-border bg-surface-hi px-2 py-1 text-[10px] leading-none">
      <span className="text-muted">{label}</span>{' '}
      <span className="text-ink">{formatMoney(spend.amount, spend.currency)}</span>
    </div>
  )
}

/** Headline percent for the rail: the worst (highest) non-null row percent. */
function worstPercent(provider: UsageProviderSnapshot): number | null {
  if (provider.status !== 'ok') return null
  let worst: number | null = null
  for (const row of provider.rows) {
    if (row.percent === null) continue
    if (worst === null || row.percent > worst) worst = row.percent
  }
  return worst
}

function railToneClass(provider: UsageProviderSnapshot): string {
  if (provider.status !== 'ok') return 'text-danger'
  const worst = worstPercent(provider)
  if (worst === null) return 'text-muted'
  if (worst >= 95) return 'text-danger'
  if (worst >= 75) return 'text-warning'
  return 'text-accent'
}

function UsageProviderDetail({ provider }: { provider: UsageProviderSnapshot }) {
  if (provider.status === 'error') {
    return <div className="px-3 py-4 text-[11px] leading-snug text-muted">{provider.message}</div>
  }
  return (
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
              <div className="h-2 w-full overflow-hidden rounded-chip bg-surface-hi">
                <div
                  className="h-full"
                  style={{ width: `${width}%`, ...severityBarStyle(row.severity) }}
                />
              </div>
              {reset || row.detail ? (
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
  )
}

export function UsageModal({ open, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [sources, setSources] = useState<Array<{ id: UsageSourceId; label: string }>>([])
  const [selected, setSelected] = useState<UsageSourceId | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openSettingsPage = useAppStore(state => state.openSettingsPage)

  const railEntries = useMemo(() => {
    // Once a snapshot lands it owns the rail (real percents, error badges).
    // Before that, the enablement-derived source list drives a skeleton —
    // replacing the old fabricated status:'error' "Loading…" rows (#1102).
    if (snapshot) {
      return snapshot.providers.map(provider => ({
        id: provider.provider as UsageSourceId,
        provider,
      }))
    }
    return sources.map(({ id }) => ({ id, provider: null as UsageProviderSnapshot | null }))
  }, [snapshot, sources])

  const activeId = useMemo(() => {
    if (selected && railEntries.some(entry => entry.id === selected)) return selected
    return railEntries[0]?.id ?? null
  }, [selected, railEntries])

  const activeProvider = useMemo(
    () => railEntries.find(entry => entry.id === activeId)?.provider ?? null,
    [railEntries, activeId],
  )

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
    setSnapshot(null)
    setSelected(null)
    void window.api
      .getUsageSources()
      .then(setSources)
      .catch(() => setSources([]))
    void refresh(false)
  }, [open])

  // Keyboard rail navigation: ↑/↓ move the selection; the rail is the only
  // list-like element in the dialog, so the keys are unambiguous.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (railEntries.length === 0) return
    const currentIndex = railEntries.findIndex(entry => entry.id === activeId)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(railEntries[(currentIndex + 1) % railEntries.length].id)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(railEntries[(currentIndex - 1 + railEntries.length) % railEntries.length].id)
    }
  }

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
              {fetchedLabel
                ? `${railEntries.length} providers · fetched ${fetchedLabel}`
                : `${sources.length} providers`}
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

        <div className="overflow-auto p-4" onKeyDown={onKeyDown}>
          {error ? (
            <div className="rounded-slab mb-3 border border-danger bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {error}
            </div>
          ) : null}

          {railEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-3 py-8 text-center">
              <div className="text-[11px] text-muted">
                No usage sources are enabled. Enable a provider in Settings → Providers.
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  onClose()
                  openSettingsPage()
                }}
              >
                Open Settings
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-3">
              <div className="flex flex-col gap-1 border-r border-border pr-3" role="listbox">
                {railEntries.map(entry => {
                  const isActive = entry.id === activeId
                  const percent = entry.provider ? worstPercent(entry.provider) : null
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => setSelected(entry.id)}
                      className={
                        isActive
                          ? 'rounded-chip border border-border bg-surface-hi px-2 py-1.5 text-left text-[11px] text-ink'
                          : 'rounded-chip border border-transparent px-2 py-1.5 text-left text-[11px] text-muted hover:bg-surface-hi'
                      }
                    >
                      <span className="font-semibold">{providerLabel(entry.id)}</span>
                      <span
                        className={`ml-2 ${entry.provider ? railToneClass(entry.provider) : 'text-muted'}`}
                      >
                        {entry.provider
                          ? percent === null
                            ? '—'
                            : `${Math.round(percent)}%${percent >= 75 ? ' ⚠' : ''}`
                          : '…'}
                      </span>
                    </button>
                  )
                })}
              </div>
              <section className="rounded-slab border border-border bg-surface">
                {activeProvider ? (
                  <>
                    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
                      <div>
                        <div className="text-[12px] font-semibold text-ink">
                          {providerLabel(activeProvider.provider)}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted">
                          {activeProvider.sourceLabel}
                        </div>
                      </div>
                      {activeProvider.status === 'ok' ? (
                        <div className="text-right text-[10px] leading-snug">
                          <div className="uppercase text-muted">plan</div>
                          <div className="text-ink">{activeProvider.plan ?? 'unknown'}</div>
                        </div>
                      ) : (
                        <div className="text-[10px] uppercase text-muted">unavailable</div>
                      )}
                    </div>
                    <UsageProviderDetail provider={activeProvider} />
                  </>
                ) : (
                  <div className="px-3 py-4 text-[11px] text-muted">Loading usage…</div>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
