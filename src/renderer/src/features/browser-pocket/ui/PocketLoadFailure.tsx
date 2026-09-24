import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/hook'
import type { SessionId } from '@renderer/workspace/types'
import { setPocketView } from '../actions'
import { canRequestRestart, restartOwner } from '../recovery/policy'
import { requestServerRestart } from '../recovery/requestServerRestart'
import { useRecoveryStore } from '../recovery/recoveryStore'
import { requestPocket } from '../state/pocketBus'
import { usePocketLive } from '../state/pocketLiveStore'
import { useSpotlightPocketMode } from '../state/spotlightPocketMode'

const BUTTON = 'rounded-control border border-border px-2 py-1 hover:border-border-hi hover:text-ink disabled:cursor-default disabled:opacity-60'

export function PocketLoadFailure({ pocketId, sessionId, getWorkspace }: {
  pocketId: string
  sessionId: SessionId
  getWorkspace: () => Workspace
}) {
  const live = usePocketLive(pocketId)
  const enabled = useAppStore(s => s.settings.browserPocketEnabled)
  const request = useRecoveryStore(s => s.requests[pocketId])
  if (!live.failed || live.loading || live.crashedOut) return null
  const failure = live.failed
  const owner = restartOwner(getWorkspace(), sessionId, pocketId)
  const eligible = enabled && owner && canRequestRestart(failure)
  const status = request?.url === failure.url ? request.status : undefined
  const maySend = !status || (status.kind === 'refused' && status.retryable)
  const label = status?.kind === 'sending' ? 'Sending request…' : status?.kind === 'queued' ? 'Queued for agent' : status?.kind === 'sent' ? 'Request sent' : 'Try to restart'
  const viewAgent = () => {
    const ws = getWorkspace()
    if (!restartOwner(ws, sessionId, pocketId)) return
    // Spotlight can still be narrow. Collapsing the browser guarantees the
    // actual agent is visible, without destroying its guest or losing login.
    ws.updateBrowserPocket(s => setPocketView(s, sessionId, 'collapsed'))
    useSpotlightPocketMode.getState().set(false)
    ws.setSpotlightTarget(sessionId)
  }
  return <div className="absolute inset-0 overflow-auto bg-canvas p-4 text-center text-[12px] text-ink-dim">
    <div className="flex min-h-full flex-col items-center justify-center gap-3">
      <div className="max-w-full break-words text-[14px] text-ink">Can't connect to {hostOf(failure.url)}</div>
      <div className="max-w-full break-words font-code text-muted">{failure.description}</div>
      {eligible && <p>Ask this agent to start or restart the local server.</p>}
      <div role="status" aria-live="polite">
        {status?.kind === 'uncertain' && 'Could not confirm delivery. Check the agent before sending again.'}
        {status?.kind === 'refused' && status.message}
        {status && ['sending', 'queued', 'sent'].includes(status.kind) && label}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {eligible && (maySend || status?.kind === 'sending') && <button type="button" className={BUTTON} disabled={!maySend} onClick={() => void requestServerRestart(getWorkspace, sessionId, pocketId)}>{label}</button>}
        <button type="button" className={BUTTON} onClick={() => {
          // getURL()/reload() can still refer to the previous committed page
          // when this destination failed before commit. Retry the attempted
          // URL through the host's existing native navigation path instead.
          requestPocket(pocketId, { type: 'navigate', url: failure.url })
        }}>Reload page</button>
        {owner && <button type="button" className={BUTTON} onClick={viewAgent}>View agent</button>}
      </div>
    </div>
  </div>
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return 'this page' }
}
