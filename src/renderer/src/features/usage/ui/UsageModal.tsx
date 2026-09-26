import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '@renderer/components/ui/empty-state'
import { Alert } from '@renderer/components/ui/alert'

import type {
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSpend,
  UsageSourceId,
} from '@preload/index'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { sectionCycleTarget } from '@renderer/lib/sectionCycle'
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
    // A provider's usage error is something to act on (sign in, retry), so
    // it is a warning box, not muted body text (UI pass, G-13). Static, not
    // announced: it appears every time this provider's tab is selected.
    return <div className="px-3 py-3"><Alert tone="warning" role={undefined}>{provider.message}</Alert></div>
  }
  return (
    <div className="space-y-3 px-3 py-3">
      {provider.rows.length === 0 ? (
        <EmptyState size="inline" className="px-0">No usage windows returned.</EmptyState>
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

  // The provider rail is a vertical TABLIST (plan S34): each entry switches
  // the detail pane, so it follows the APG tabs pattern — roving tabindex
  // (one Tab stop for the whole rail), ↑↓ move AND select, Home/End jump,
  // wrap at the ends (tabs are a cycle; plan D4's clamp is for lists).
  // Before: every entry was its own Tab stop and the arrows moved the
  // selection without moving focus, so the focus ring and the selection
  // sat on different providers.
  const railRefs = useRef(new Map<string, HTMLButtonElement>())
  const activeIndex = Math.max(0, railEntries.findIndex(entry => entry.id === activeId))
  const selectRailIndex = (index: number, focus: boolean) => {
    const entry = railEntries[((index % railEntries.length) + railEntries.length) % railEntries.length]
    if (!entry) return
    setSelected(entry.id)
    if (focus) railRefs.current.get(entry.id)?.focus()
  }
  const onRailKeyDown = (event: React.KeyboardEvent) => {
    if (railEntries.length === 0) return
    const next =
      event.key === 'ArrowDown' ? activeIndex + 1
        : event.key === 'ArrowUp' ? activeIndex - 1
          : event.key === 'Home' ? 0
            : event.key === 'End' ? railEntries.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    selectRailIndex(next, true)
  }
  // ⌘[ / ⌘] from ANYWHERE in the dialog (plan D5), without moving focus.
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    const target = sectionCycleTarget(event, activeIndex, railEntries.length)
    if (target === null) return
    event.preventDefault()
    selectRailIndex(target, false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        size="lg"
        className="flex max-h-[86vh] flex-col"
        // No footer, so the standard corner `× ⎋` is the exit (plan H5) — it
        // replaces the lowercase "close" button that sat in the header.
        showCloseButton
        onKeyDown={onDialogKeyDown}
      >
        <DialogHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <DialogTitle>Usage</DialogTitle>
            <DialogDescription className="mt-0.5">
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
              variant="ghost"
              size="sm"
              className="disabled:cursor-wait"
            >
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <div className="overflow-auto px-4 py-3">
          {error ? (
            <Alert className="mb-3">{error}</Alert>
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
              <div
                className="flex flex-col gap-1 border-r border-border pr-3"
                role="tablist"
                aria-orientation="vertical"
                aria-label="Providers"
                onKeyDown={onRailKeyDown}
              >
                {railEntries.map(entry => {
                  const isActive = entry.id === activeId
                  const percent = entry.provider ? worstPercent(entry.provider) : null
                  return (
                    <button
                      key={entry.id}
                      ref={element => {
                        if (element) railRefs.current.set(entry.id, element)
                        else railRefs.current.delete(entry.id)
                      }}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => setSelected(entry.id)}
                      // rounded-control, not rounded-chip: these are interactive
                      // option rows (radius table), and at the Round corner tier
                      // `chip` rendered each 200px entry as a stadium.
                      className={
                        isActive
                          ? 'rounded-control border border-transparent border-l-2 border-l-accent bg-row-selected-bg px-2 py-1.5 text-left text-[11px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-focus-ring'
                          : 'rounded-control border border-transparent border-l-2 px-2 py-1.5 text-left text-[11px] text-muted outline-none hover:bg-row-hover-bg focus-visible:ring-1 focus-visible:ring-focus-ring'
                      }
                    >
                      <span className="font-medium">{providerLabel(entry.id)}</span>
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
