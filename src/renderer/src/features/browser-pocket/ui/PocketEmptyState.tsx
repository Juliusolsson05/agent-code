import type { LanePort } from '@shared/browserPocket/types'

/**
 * What an empty pocket shows (spec §4.5). No guest exists yet — nothing is
 * rendered by Chromium until the user or the agent picks a page — so this is
 * plain DOM inside the slot.
 *
 * This lane's own dev servers come first: telling worktrees apart is the
 * whole reason the pocket is attached to a lane.
 */
export function PocketEmptyState({ ports, onOpen }: { ports: LanePort[]; onOpen: (url: string) => void }) {
  const html = ports.filter(p => p.kind === 'html')
  const other = ports.filter(p => p.kind !== 'html')
  return (
    <div className="absolute inset-0 flex flex-col gap-3 overflow-auto p-4 text-[12px] text-ink-dim">
      {ports.length > 0 ? (
        <div>
          <div className="mb-1 text-ink">This lane is serving</div>
          {[...html, ...other].map(p => (
            <button key={`${p.pid}:${p.port}`} type="button" className="block py-0.5 text-left font-code hover:text-ink" onClick={() => onOpen(p.url)}>
              ▸ localhost:{p.port} <span className="text-muted">pid {p.pid}{p.kind === 'html' ? '' : ' · not a page at /'}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-muted">Nothing in this lane is serving a page yet.</div>
      )}
      <div>Type a URL or just a port above, or start a dev server in this lane.</div>
    </div>
  )
}
