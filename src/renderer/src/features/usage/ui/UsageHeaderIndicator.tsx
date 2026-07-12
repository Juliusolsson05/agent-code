import { useAppStore } from '@renderer/app-state/hooks'
import type { UsageHeaderLevel } from '@renderer/app-state/settings/types'
import { useUsageHeaderSnapshot } from '@renderer/features/usage/hooks/useUsageHeaderSnapshot'
import {
  headerTooltip,
  toHeaderProviders,
  worstAcross,
} from '@renderer/features/usage/model/headerRows'
import type { HeaderProvider, HeaderRow } from '@renderer/features/usage/model/headerRows'
import {
  formatPercent,
  formatResetShort,
  severityBarStyle,
  severityTextStyle,
} from '@renderer/features/usage/model/formatUsage'

/** One quota row inside a provider chip. `detailed` adds a ~28px severity
 *  micro-bar and a compact reset ("3h") — everything else is shared so the
 *  four levels can't drift apart visually. */
function RowCell({ row, detailed }: { row: HeaderRow; detailed: boolean }) {
  const width = row.percent === null ? 0 : Math.max(0, Math.min(100, row.percent))
  const reset = detailed ? formatResetShort(row.resetsAt) : null
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted">{row.shortLabel}</span>
      {detailed ? (
        <span className="inline-block h-[3px] w-7 overflow-hidden bg-surface-hi align-middle">
          <span
            className="block h-full"
            style={{ width: `${width}%`, ...severityBarStyle(row.severity) }}
          />
        </span>
      ) : null}
      <span style={severityTextStyle(row.severity)}>
        {row.percent === null ? '?%' : formatPercent(row.percent)}
      </span>
      {reset ? <span className="text-muted">{reset}</span> : null}
    </span>
  )
}

function ProviderChip({
  provider,
  level,
}: {
  provider: HeaderProvider
  level: UsageHeaderLevel
}) {
  // `worst` is null when every active row has percent: null (unknown can't
  // win "most constrained"). Falling back to the first row — which RowCell
  // renders as "?%" — instead of an empty array matters for layout too:
  // returning null here would leave the parent's "│" separator dangling
  // next to a missing chip (caught in review, PR #528). toHeaderProviders
  // guarantees rows is non-empty, so this chip always renders something.
  const rows =
    level === 'providers'
      ? [provider.worst ?? provider.rows[0]]
      : provider.rows
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold text-ink">{provider.code}</span>
      {rows.map((row, index) => (
        <span key={row.id} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span className="text-muted">·</span> : null}
          <RowCell row={row} detailed={level === 'detailed'} />
        </span>
      ))}
    </span>
  )
}

/** Ambient quota indicator for the SettingsBar. Mounted ONLY while
 *  usageHeaderEnabled is on (SettingsBar gates the mount) — that gating
 *  is what tears down the polling interval, so do not add an internal
 *  enabled check here. Click-through to the modal keeps the header
 *  glanceable: detail, refresh, and error prose all live in the modal. */
export function UsageHeaderIndicator({ level }: { level: UsageHeaderLevel }) {
  const openUsageModal = useAppStore(state => state.openUsageModal)
  const { snapshot, stale } = useUsageHeaderSnapshot()

  // First poll in flight: render nothing. No skeleton flash in chrome —
  // data arrives within ~1s and the bar reflows gracefully.
  if (!snapshot) return null

  const providers = toHeaderProviders(snapshot)
  const worst = worstAcross(providers)
  const tooltip = headerTooltip(snapshot, stale)
  const chipClass = `
    inline-flex items-center gap-2 border border-border bg-surface-hi
    px-2 py-1 text-[10px] font-code leading-none
    transition-colors hover:border-accent cursor-pointer
  `

  // Both providers errored / nothing active: a single muted chip whose
  // tooltip carries the provider error messages (spec §3.2). Still
  // clickable — the modal is where the full error text and refresh live.
  if (providers.length === 0) {
    return (
      <button type="button" onClick={openUsageModal} title={tooltip} className={chipClass}>
        <span className="text-muted">usage n/a</span>
      </button>
    )
  }

  if (level === 'minimal') {
    return (
      <button type="button" onClick={openUsageModal} title={tooltip} className={chipClass}>
        <span className="text-muted">usage</span>
        {worst ? (
          <span style={severityTextStyle(worst.severity)}>{formatPercent(worst.percent)}</span>
        ) : (
          <span className="text-muted">?%</span>
        )}
      </button>
    )
  }

  return (
    <button type="button" onClick={openUsageModal} title={tooltip} className={chipClass}>
      {providers.map((provider, index) => (
        <span key={provider.provider} className="inline-flex items-center gap-2">
          {index > 0 ? <span className="text-muted">│</span> : null}
          <ProviderChip provider={provider} level={level} />
        </span>
      ))}
    </button>
  )
}
