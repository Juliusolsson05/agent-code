import { memo } from 'react'
import type { UsageLimitNotice } from '@shared/types/usageLimitNotice'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import { USAGE_URLS, usageLimitResetLabel, type UsageLimitActions } from './model'

/** Shared presentation only: adapters own admission and meaning, the ledger
 * owns identity/order, and the host owns session actions. Keeping the desktop
 * store out of this component also makes previews, remote Feed, and headless
 * registry consumers safe without pretending those hosts can switch agents. */
export const UsageLimitNoticeView = memo(function UsageLimitNoticeView({
  notice, sessionRunId, actions,
}: { notice: UsageLimitNotice; sessionRunId?: string; actions?: UsageLimitActions }) {
  const resetLabel = usageLimitResetLabel(notice)
  const canSwitch = actions?.canSwitchProvider(notice, sessionRunId) ?? false
  const actionClass = 'rounded-control border border-border px-2 py-1 text-[12px] text-ink-dim hover:border-border-hi hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
  return (
    <section aria-label={`${notice.provider === 'claude' ? 'Claude Code' : 'Codex'} usage notice`}
      data-renderer-id="shared.usage-limit"
      className="min-w-0 rounded-slab border border-border bg-surface px-4 py-3 text-[13px] text-ink">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="text-accent">◷</span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-muted">{notice.provider === 'claude' ? 'Claude Code' : 'Codex'}</div>
          <h3 className="font-semibold break-words">{notice.title}</h3>
          {notice.detail && <p className="mt-1 whitespace-pre-wrap break-words text-ink-dim">{notice.detail}</p>}
          {resetLabel && <p className="mt-1 break-words text-ink-dim">{resetLabel}</p>}
          {notice.category === 'spend-cap' && notice.reset?.subject === 'session-window' && (
            <p className="mt-1 text-muted">The session reset does not raise the monthly spend cap.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {notice.remedy === 'manage-usage' && <SafeMarkdownLink className={actionClass} href={USAGE_URLS[notice.provider]}>Manage usage ↗</SafeMarkdownLink>}
            {actions && <button type="button" className={actionClass} onClick={actions.openUsage}>Usage overview</button>}
            {canSwitch && <button type="button" className={actionClass} onClick={() => actions?.switchProvider(notice, sessionRunId)}>Switch provider…</button>}
          </div>
          {/* Provider text stays plain and selectable. Markdown/link parsing
              here would turn an error payload into active UI. Native details
              gives keyboard expansion without per-row state or a portal. */}
          <details className="mt-3 text-[12px] text-muted">
            <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Original provider message</summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-code">{notice.originalMessage}</pre>
          </details>
        </div>
      </div>
    </section>
  )
})
