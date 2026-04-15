import { useEffect, useMemo, useRef, useState } from 'react'

import {
  resolvePlacementTarget,
  type PlacementIntent,
  type PlacementTarget,
} from '../lib/newAgentPlacement'
import type { SessionKind } from '../../../tiles/types'
import type { Workspace } from '../../../tiles/workspaceStore'

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

const KIND_OPTIONS: Array<{ kind: SessionKind; label: string; description: string }> = [
  { kind: 'claude', label: 'Claude', description: 'full agent session' },
  { kind: 'codex', label: 'Codex', description: 'OpenAI coding agent session' },
  { kind: 'terminal', label: 'Terminal', description: 'plain shell pane' },
]

const EMPTY_INTENT: PlacementIntent = {
  vertical: null,
  horizontal: null,
}

export function NewAgentPlacementOverlay({ open, workspace, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedKind, setSelectedKind] = useState<SessionKind | null>(null)
  const [intent, setIntent] = useState<PlacementIntent>(EMPTY_INTENT)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })

  const activeTab = workspace.activeTab
  const anchorSessionId = activeTab?.focusedSessionId ?? null

  useEffect(() => {
    if (!open) return
    setSelectedIndex(0)
    setSelectedKind(null)
    setIntent(EMPTY_INTENT)
  }, [open])

  useEffect(() => {
    if (!open) return
    const element = overlayRef.current
    if (!element) return
    const update = () => {
      setBounds({ width: element.clientWidth, height: element.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  const placementTarget = useMemo<PlacementTarget | null>(() => {
    if (!open || !activeTab || !anchorSessionId || !selectedKind) return null
    if (bounds.width <= 0 || bounds.height <= 0) return null
    return resolvePlacementTarget(
      activeTab.root,
      anchorSessionId,
      intent,
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
    )
  }, [activeTab, anchorSessionId, bounds.height, bounds.width, intent, open, selectedKind])

  useEffect(() => {
    if (!open) return
    // WHY scope stopPropagation to the keys we actually handle:
    //   Earlier we swallowed every keydown unconditionally while the
    //   overlay was open. That killed app-level shortcuts like Cmd+W,
    //   Cmd+Q, and the command palette trigger — confusing if the
    //   overlay got stuck open. Now only keys we consume are blocked
    //   from bubbling; everything else reaches the normal handlers.
    const handledPickerKeys = new Set(['Escape', 'ArrowUp', 'ArrowDown', 'Enter'])
    const handledPlacementKeys = new Set([
      'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter',
    ])

    const onKeyDown = (event: KeyboardEvent) => {
      if (!selectedKind) {
        if (!handledPickerKeys.has(event.key)) return
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelectedIndex(prev => (prev + KIND_OPTIONS.length - 1) % KIND_OPTIONS.length)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelectedIndex(prev => (prev + 1) % KIND_OPTIONS.length)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          setSelectedKind(KIND_OPTIONS[selectedIndex]!.kind)
        }
        return
      }

      if (!handledPlacementKeys.has(event.key)) return
      // Enter only consumes when we have somewhere to land — without a
      // placement target it should fall through so the user isn't
      // stranded with a "nothing happens" Enter press.
      if (event.key === 'Enter' && !placementTarget) return
      event.stopPropagation()

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setIntent(prev => ({ ...prev, vertical: 'up' }))
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setIntent(prev => ({ ...prev, vertical: 'down' }))
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setIntent(prev => ({ ...prev, horizontal: 'left' }))
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setIntent(prev => ({ ...prev, horizontal: 'right' }))
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        setIntent(EMPTY_INTENT)
        return
      }
      if (event.key === 'Enter' && placementTarget) {
        event.preventDefault()
        void workspace.commitNewAgentPlacement(selectedKind, placementTarget)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, open, placementTarget, selectedIndex, selectedKind, workspace])

  if (!open || !activeTab || !anchorSessionId) return null

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40 bg-black/20"
    >
      {selectedKind && placementTarget && (
        <div
          className="absolute border-2 border-red-500 bg-red-500/12 shadow-[0_0_0_1px_rgba(239,68,68,0.35)] pointer-events-none"
          style={{
            left: placementTarget.rect.x,
            top: placementTarget.rect.y,
            width: placementTarget.rect.width,
            height: placementTarget.rect.height,
          }}
        />
      )}

      <div className="absolute left-4 top-4 pointer-events-none">
        <div className="border border-border bg-surface/95 px-3 py-2 text-[11px] text-ink-dim shadow-lg shadow-black/30">
          {!selectedKind ? (
            <div>Choose agent type with ↑/↓ and press Enter</div>
          ) : (
            <div className="space-y-1">
              <div>{KIND_OPTIONS.find(option => option.kind === selectedKind)?.label} placement</div>
              <div className="text-muted">Use arrow keys to shape placement. Enter confirms. Backspace resets.</div>
              <div className="text-muted">
                Intent: {intent.vertical ?? '·'} / {intent.horizontal ?? '·'}
              </div>
            </div>
          )}
        </div>
      </div>

      {!selectedKind && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-[340px] border border-border bg-surface shadow-lg shadow-black/30">
            <div className="border-b border-border px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
              New Agent
            </div>
            <div className="p-2">
              {KIND_OPTIONS.map((option, index) => {
                const active = index === selectedIndex
                return (
                  <button
                    key={option.kind}
                    type="button"
                    onClick={() => {
                      setSelectedIndex(index)
                      setSelectedKind(option.kind)
                    }}
                    className={`flex w-full items-center justify-between border px-3 py-2 text-left ${
                      active
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-border bg-canvas text-ink-dim hover:border-border-hi hover:text-ink'
                    }`}
                  >
                    <span className="text-[12px]">{option.label}</span>
                    <span className={`text-[10px] ${active ? 'text-accent-fg/80' : 'text-muted'}`}>
                      {option.description}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
