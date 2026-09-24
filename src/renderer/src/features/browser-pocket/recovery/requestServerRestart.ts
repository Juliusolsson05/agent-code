import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/hook'
import type { SessionId } from '@renderer/workspace/types'
import { useLanePortsStore } from '../state/lanePortsStore'
import { usePocketLiveStore } from '../state/pocketLiveStore'
import { canRequestRestart, restartContext, restartOwner } from './policy'
import { restartPrompt } from './prompt'
import { useRecoveryStore, type RecoveryStatus } from './recoveryStore'

/** A human action submitting one task through the existing provider boundary.
 * Do not route this through composer insertion, raw PTY input, or a browser
 * MCP tool: those either edit the user's draft or require unrelated setup.
 * A live workspace reader matters across wake; a captured render snapshot
 * could otherwise deliver after the user moved/replaced the agent. */
export async function requestServerRestart(getWorkspace: () => Workspace, sessionId: SessionId, pocketId: string): Promise<void> {
  const ownerNow = () => {
    // React may not have committed another render when wake resolves. Read
    // the authoritative store directly, not even the latest-rendered ref.
    const s = useAppStore.getState()
    return restartOwner({ state: s.workspaceState, runtimes: s.workspaceRuntimes }, sessionId, pocketId)
  }
  const read = () => {
    const live = usePocketLiveStore.getState().live[pocketId]
    const owner = ownerNow()
    if (!useAppStore.getState().settings.browserPocketEnabled || !owner || !live?.failed || live.loading || live.crashedOut || !canRequestRestart(live.failed)) return null
    return { owner, failure: live.failed }
  }
  const target = read()
  if (!target) return
  const store = useRecoveryStore.getState()
  const token = store.begin(pocketId, target.failure.url)
  if (!token) return
  const isCurrent = () => {
    const current = read()
    return useRecoveryStore.getState().requests[pocketId]?.token === token && current?.owner.identity === target.owner.identity && current?.failure === target.failure
  }
  const finish = (status: RecoveryStatus) => {
    // A same-id worktree/provider change need not unmount the host. Recheck
    // ownership on the return path too, while allowing an ordinary failed
    // reload of this same URL to retain the original receipt/send guard.
    if (!useAppStore.getState().settings.browserPocketEnabled || ownerNow()?.identity !== target.owner.identity) {
      store.clear(pocketId, token)
      return
    }
    store.finish(pocketId, token, status)
  }
  let invoked = false
  try {
    await getWorkspace().ensureSessionLive(sessionId, 'browser-pocket.restart-request')
    if (!isCurrent()) { store.clear(pocketId, token); return }
    const context = restartContext(target.failure, target.owner.worktree, useLanePortsStore.getState().bySession[sessionId] ?? [])
    invoked = true
    const delivery = await window.api.deliverPrompt(sessionId, restartPrompt(context), undefined, undefined, { requireEmptyNativeComposer: true })
    // The user may have navigated or closed the pocket AFTER the write. We
    // cannot retract that task, and must neither replay it nor report success
    // into a replacement view. finish() checks the surviving operation token.
    if (delivery.ok) finish({ kind: delivery.acceptance.kind === 'queue' ? 'queued' : 'sent' })
    // Retry permission and delivery certainty are independent. OpenCode/Grok
    // explicitly refuse some submissions before writing but forbid replay;
    // preserve that reason without treating a known rejection as a lost ACK.
    else if (delivery.promptWritten || delivery.enterWritten || (!delivery.retrySafe && delivery.stage !== 'before-write' && delivery.stage !== 'reservation')) finish({ kind: 'uncertain' })
    else finish({
      kind: 'refused', message: delivery.message,
      retryable: delivery.retrySafe && delivery.disposition === 'retry-same-session',
    })
  } catch (error) {
    // An IPC rejection after invocation may have lost only the ACK. A local
    // timeout/retry would duplicate a queued task, so there is no watchdog or
    // automatic resend. Wake failures occurred before this feature wrote.
    finish(invoked ? { kind: 'uncertain' } : {
      kind: 'refused', retryable: true,
      message: error instanceof Error ? error.message : 'Could not wake the agent. Try again.',
    })
  }
}
