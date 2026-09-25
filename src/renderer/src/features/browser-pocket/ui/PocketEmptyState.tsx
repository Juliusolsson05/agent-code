import type { LanePort } from '@shared/browserPocket/types'

/** Discovery belongs beside the page. Show this agent's own servers first so
 * identical ports in different worktrees cannot silently point at a different
 * agent's work. Process ids remain in tooltips for diagnosis, not primary UI. */
export function PocketEmptyState({ ports, onOpen }: { ports: LanePort[]; onOpen: (url: string) => void }) {
  const html = ports.filter(p => p.kind === 'html')
  const other = ports.filter(p => p.kind !== 'html')
  return (
    <div className="absolute inset-0 overflow-auto p-4 text-[12px] text-ink-dim">
      <div className="mx-auto flex w-full max-w-md flex-col gap-3">
        <div>
          <h3 className="font-medium text-ink">{ports.length ? 'Local servers' : 'Open a page'}</h3>
          <p className="mt-1 leading-relaxed">{ports.length ? 'Choose a server from this agent’s lane, or enter a URL above.' : 'Enter a URL or port above. Start a dev server in this lane and it will appear here.'}</p>
        </div>
        {[...html, ...other].map(p => (
          <button key={`${p.pid}:${p.port}`} type="button" className="flex items-center justify-between gap-2 rounded-control border border-border bg-surface p-2 text-left hover:border-accent hover:text-ink" title={`${p.url} · process ${p.pid}`} onClick={() => onOpen(p.url)}>
            <span className="min-w-0 truncate"><span className="font-code text-ink">localhost:{p.port}</span>{p.kind !== 'html' && <span className="block text-[11px] text-muted">No page at the root URL</span>}</span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </div>
  )
}
