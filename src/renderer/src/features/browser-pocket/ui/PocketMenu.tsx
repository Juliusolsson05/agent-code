import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DEVICE_PRESETS, type DevicePresetId } from '@shared/browserPocket/devices'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

import { setPocketColorScheme, setPocketProfile, setPocketViewport, setPocketZoom } from '../actions'
import { requestPocket } from '../state/pocketBus'

/**
 * The pocket's ⋯ menu.
 *
 * WHY a portal to document.body: the page is a <webview> in BrowserPocketHost's
 * fixed layer ABOVE the lanes. A dropdown rendered inside the lane would paint
 * under the page wherever an ancestor creates a stacking context. Portalling
 * the MENU is safe (it is ordinary DOM); it is only the <webview> that must
 * never move.
 */
export function PocketMenu({ sessionId, workspace, buttonClass }: { sessionId: SessionId; workspace: Workspace; buttonClass: string }) {
  const pocket = workspace.state.sessions[sessionId]?.browserPocket
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const { showToast } = useGlobalToast()

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // A click inside the page reaches the host only as a window blur, never
    // a mousedown; close on blur too or the menu sticks open over the page.
    const onBlur = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  if (!pocket) return null
  const rect = button.current?.getBoundingClientRect()
  const update = workspace.updateBrowserPocket
  const presetId = pocket.viewport?.mode === 'preset' ? pocket.viewport.preset : null
  const zoom = pocket.zoom ?? 1
  const item = 'flex w-full items-center justify-between rounded-control px-2 py-1 text-left text-[11px] text-ink-dim hover:bg-canvas hover:text-ink'
  const pick = (active: boolean) => `${item} ${active ? 'text-ink' : ''}`

  return (
    <>
      <button ref={button} type="button" className={buttonClass} aria-label="Browser pocket menu" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}>⋯</button>
      {open && rect && createPortal(
        <div
          ref={menu}
          role="menu"
          className="rounded-float fixed z-50 w-[230px] border border-border-hi bg-surface p-1 shadow-[0_16px_48px_rgba(0,0,0,0.4)]"
          style={{ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238)) }}
        >
          <Label>Device</Label>
          <button type="button" role="menuitemradio" aria-checked={!pocket.viewport} className={pick(!pocket.viewport)} onClick={() => update(s => setPocketViewport(s, sessionId, { mode: 'fill' }))}>Fill pane {!pocket.viewport && '✓'}</button>
          {(Object.keys(DEVICE_PRESETS) as DevicePresetId[]).map(id => (
            <button key={id} type="button" role="menuitemradio" aria-checked={presetId === id} className={pick(presetId === id)}
              onClick={() => update(s => setPocketViewport(s, sessionId, { mode: 'preset', preset: id }))}>
              {DEVICE_PRESETS[id].label} <span className="font-code text-muted">{DEVICE_PRESETS[id].width}×{DEVICE_PRESETS[id].height}{presetId === id ? ' ✓' : ''}</span>
            </button>
          ))}
          {pocket.viewport?.mode === 'preset' && (
            <button type="button" className={item} onClick={() => update(s => setPocketViewport(s, sessionId, { mode: 'preset', preset: presetId!, landscape: !(pocket.viewport as { landscape?: boolean }).landscape }))}>Rotate</button>
          )}
          <Divider />
          <Label>Appearance</Label>
          {(['system', 'light', 'dark'] as const).map(scheme => {
            const active = (pocket.colorScheme ?? 'system') === scheme
            return <button key={scheme} type="button" role="menuitemradio" aria-checked={active} className={pick(active)} onClick={() => update(s => setPocketColorScheme(s, sessionId, scheme))}>{scheme[0]!.toUpperCase() + scheme.slice(1)} {active && '✓'}</button>
          })}
          <Divider />
          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-ink-dim">
            <span>Zoom</span>
            <span className="flex items-center gap-1">
              <button type="button" className="rounded-control px-1.5 hover:bg-canvas" aria-label="Zoom out" onClick={() => update(s => setPocketZoom(s, sessionId, zoom - 0.1))}>−</button>
              <button type="button" className="w-10 rounded-control font-code hover:bg-canvas" aria-label="Reset zoom" onClick={() => update(s => setPocketZoom(s, sessionId, null))}>{Math.round(zoom * 100)}%</button>
              <button type="button" className="rounded-control px-1.5 hover:bg-canvas" aria-label="Zoom in" onClick={() => update(s => setPocketZoom(s, sessionId, zoom + 0.1))}>+</button>
            </span>
          </div>
          <Divider />
          <Label>Cookies</Label>
          <button type="button" role="menuitemradio" aria-checked={pocket.profile === 'lane'} className={pick(pocket.profile === 'lane')} onClick={() => update(s => setPocketProfile(s, sessionId, 'lane'))}>This agent only {pocket.profile === 'lane' && '✓'}</button>
          <button type="button" role="menuitemradio" aria-checked={pocket.profile === 'project'} className={pick(pocket.profile === 'project')} title="Share logins with every pocket in this project. Two dev servers on localhost will share cookies." onClick={() => update(s => setPocketProfile(s, sessionId, 'project'))}>Shared with project {pocket.profile === 'project' && '✓'}</button>
          <button type="button" className={item} onClick={() => {
            setOpen(false)
            const projectId = workspace.state.sessions[sessionId]?.projectId
            void window.api.clearPocketStorage({ pocketId: pocket.pocketId, profile: pocket.profile, ...(projectId ? { projectId } : {}) })
              .then(() => { showToast('Cookies and storage cleared'); requestPocket(pocket.pocketId, { type: 'reload' }) })
              .catch(() => showToast('Could not clear this pocket\'s storage'))
          }}>Clear cookies &amp; storage</button>
          <Divider />
          <button type="button" className={item} onClick={() => { setOpen(false); requestPocket(pocket.pocketId, { type: 'reload', hard: true }) }}>Hard reload</button>
          <button type="button" className={item} title="While DevTools is open the agent cannot act on the page" onClick={() => { setOpen(false); requestPocket(pocket.pocketId, { type: 'devtools' }) }}>Open DevTools</button>
        </div>,
        document.body,
      )}
    </>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wider text-muted">{children}</div>
}

function Divider() {
  return <div className="my-1 h-px bg-border" />
}
