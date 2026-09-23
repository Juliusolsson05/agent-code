import { useEffect, useRef } from 'react'
import { DEVICE_PRESETS, type DevicePresetId } from '@shared/browserPocket/devices'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { setPocketColorScheme, setPocketProfile, setPocketViewport, setPocketZoom } from '../actions'
import { requestPocket } from '../state/pocketBus'
import { usePocketLive } from '../state/pocketLiveStore'
import { detachAndForget } from './detach'

/** The OS owns menu placement, keyboard navigation and dismissal. Only the
 * selected app action returns here; durable preferences still have one owner
 * in workspace state, rather than drifting into a second main-process copy. */
export function PocketMenu({ sessionId, workspace, buttonClass }: { sessionId: SessionId; workspace: Workspace; buttonClass: string }) {
  const latest = useRef(workspace)
  latest.current = workspace
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pocket = workspace.state.sessions[sessionId]?.browserPocket
  const live = usePocketLive(pocket?.pocketId)
  const { showToast } = useGlobalToast()
  if (!pocket) return null
  const open = async () => {
    try {
      const action = await window.api.showPocketMenu({
        viewport: pocket.viewport?.mode === 'preset' ? pocket.viewport.preset : pocket.viewport?.mode === 'free' ? 'custom' : 'fill',
        colorScheme: pocket.colorScheme ?? 'system', zoom: pocket.zoom ?? 1,
        profile: pocket.profile, hasPage: Boolean(pocket.url), canGoBack: live.canGoBack, canGoForward: live.canGoForward,
      })
      // A native menu can outlive this component (agent moved or closed).
      // Never apply a selection to a replacement pocket with a new identity.
      if (!action || !mounted.current || latest.current.state.sessions[sessionId]?.browserPocket?.pocketId !== pocket.pocketId) return
      const update = workspace.updateBrowserPocket
      if (action.startsWith('device:')) {
        const preset = action.slice(7)
        if (preset === 'fill') update(s => setPocketViewport(s, sessionId, { mode: 'fill' }))
        else if (preset in DEVICE_PRESETS) update(s => setPocketViewport(s, sessionId, { mode: 'preset', preset: preset as DevicePresetId }))
      } else if (action === 'rotate' && pocket.viewport?.mode === 'preset') {
        const viewport = pocket.viewport
        update(s => setPocketViewport(s, sessionId, { ...viewport, landscape: !viewport.landscape }))
      } else if (action === 'scheme:system' || action === 'scheme:light' || action === 'scheme:dark') {
        update(s => setPocketColorScheme(s, sessionId, action.slice(7) as 'system' | 'light' | 'dark'))
      } else if (action === 'profile:lane' || action === 'profile:project') {
        update(s => setPocketProfile(s, sessionId, action === 'profile:lane' ? 'lane' : 'project'))
      } else if (action.startsWith('zoom-')) {
        update(s => setPocketZoom(s, sessionId, action === 'zoom-reset' ? null : (pocket.zoom ?? 1) + (action === 'zoom-in' ? 0.1 : -0.1)))
      } else if (action === 'clear-storage') {
        await window.api.clearPocketStorage({ pocketId: pocket.pocketId, profile: pocket.profile, projectId: workspace.state.sessions[sessionId]?.projectId })
        showToast('Cookies and storage cleared')
        requestPocket(pocket.pocketId, { type: 'reload' })
      } else if (action === 'detach') detachAndForget(workspace, sessionId)
      else if (action === 'setup') useAppStore.getState().openAgentMcpServers(sessionId)
      else if (action === 'external') requestPocket(pocket.pocketId, { type: 'open-external' })
      else if (action === 'reload') requestPocket(pocket.pocketId, { type: 'reload', hard: true })
      else if (action === 'back' || action === 'pick' || action === 'devtools' || action === 'forward') requestPocket(pocket.pocketId, { type: action })
    } catch { showToast('Could not complete the browser action. Try again.') }
  }
  return <button type="button" className={buttonClass} aria-label="Browser pocket menu" title="Browser controls" aria-haspopup="menu" onClick={() => void open()}>⋯</button>
}
