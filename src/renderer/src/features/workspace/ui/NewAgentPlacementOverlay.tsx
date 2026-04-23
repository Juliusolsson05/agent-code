import { useEffect, useMemo, useRef, useState } from 'react'

import {
  buildPlacementTargets,
  defaultPlacementTargetId,
  findNearestPlacementTarget,
  type PlacementTarget,
} from '../lib/newAgentPlacement'
import type { SessionKind } from '../../../workspace/types'
import type { Workspace } from '../../../workspace/workspaceStore'

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

export function NewAgentPlacementOverlay({ open, workspace, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedKind, setSelectedKind] = useState<SessionKind | null>(null)
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  // One-shot latch around commitNewAgentPlacement. The commit is async
  // (spawns a session, awaits an IPC round-trip, then calls
  // closeNewAgentPlacement()). Until the close fires, this overlay
  // keeps its `open` prop true and its keydown listener registered —
  // so a user that hits Enter twice in quick succession would fire
  // commit twice, spawning a second unwanted agent. A ref (not state)
  // because the latch needs to gate the synchronous keydown handler
  // path, not trigger a re-render.
  const committingRef = useRef(false)

  const activeTab = workspace.activeTab
  const anchorSessionId = activeTab?.focusedSessionId ?? null

  useEffect(() => {
    if (!open) return
    setSelectedIndex(0)
    setSelectedKind(null)
    setSelectedTargetId(null)
    // Reset the commit latch whenever the overlay re-opens. Otherwise
    // a user could open → commit → close → reopen and the second
    // session would be suppressed.
    committingRef.current = false
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

  const placementTargets = useMemo<PlacementTarget[]>(() => {
    if (!open || !activeTab || !anchorSessionId || !selectedKind) return []
    if (bounds.width <= 0 || bounds.height <= 0) return []
    return buildPlacementTargets(
      activeTab.root,
      anchorSessionId,
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
    )
  }, [activeTab, anchorSessionId, bounds.height, bounds.width, open, selectedKind])

  useEffect(() => {
    if (!selectedKind || !anchorSessionId) return
    if (placementTargets.length === 0) {
      setSelectedTargetId(null)
      return
    }
    setSelectedTargetId(prev => (
      prev && placementTargets.some(target => target.id === prev)
        ? prev
        : defaultPlacementTargetId(placementTargets, anchorSessionId)
    ))
  }, [anchorSessionId, placementTargets, selectedKind])

  const placementTarget = useMemo(
    () => placementTargets.find(target => target.id === selectedTargetId) ?? null,
    [placementTargets, selectedTargetId],
  )

  useEffect(() => {
    if (!open) return
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
      if (event.key === 'Enter' && !placementTarget) return
      event.stopPropagation()

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        if (anchorSessionId) {
          setSelectedTargetId(defaultPlacementTargetId(placementTargets, anchorSessionId))
        }
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedTargetId(prev => findNearestPlacementTarget(placementTargets, prev, 'up'))
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedTargetId(prev => findNearestPlacementTarget(placementTargets, prev, 'down'))
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSelectedTargetId(prev => findNearestPlacementTarget(placementTargets, prev, 'left'))
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setSelectedTargetId(prev => findNearestPlacementTarget(placementTargets, prev, 'right'))
        return
      }
      if (event.key === 'Enter' && placementTarget) {
        event.preventDefault()
        // Latch against double-commit. commitNewAgentPlacement is a
        // multi-step async: spawn() → setState → closeNewAgentPlacement.
        // The overlay stays mounted/open until close fires, so a rapid
        // second Enter would commit again and spawn a second session
        // the user didn't ask for. Skipping here keeps the first commit
        // the authoritative one; the reset in the `open` effect clears
        // the latch the next time the overlay opens.
        if (committingRef.current) return
        committingRef.current = true
        void workspace.commitNewAgentPlacement(selectedKind, placementTarget)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [
    anchorSessionId,
    onClose,
    open,
    placementTarget,
    placementTargets,
    selectedIndex,
    selectedKind,
    workspace,
  ])

  if (!open || !activeTab || !anchorSessionId) return null

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40 bg-black/20"
    >
      {selectedKind && placementTargets.map(target => {
        const active = target.id === placementTarget?.id
        return (
          <button
            key={target.id}
            type="button"
            onClick={() => setSelectedTargetId(target.id)}
            className={`absolute border pointer-events-auto ${
              active
                ? 'border-red-500 bg-red-500/12 shadow-[0_0_0_1px_rgba(239,68,68,0.35)]'
                : target.scope === 'global'
                  ? 'border-white/20 bg-white/5 hover:border-white/35'
                  : 'border-white/15 bg-white/[0.03] hover:border-white/25'
            }`}
            style={{
              left: target.rect.x,
              top: target.rect.y,
              width: target.rect.width,
              height: target.rect.height,
            }}
            aria-label={target.label}
          >
            <span className="sr-only">{target.label}</span>
          </button>
        )
      })}

      <div className="absolute left-4 top-4 pointer-events-none">
        <div className="border border-border bg-surface/95 px-3 py-2 text-[11px] text-ink-dim shadow-lg shadow-black/30">
          {!selectedKind ? (
            <div>Choose agent type with ↑/↓ and press Enter</div>
          ) : (
            <div className="space-y-1">
              <div>{KIND_OPTIONS.find(option => option.kind === selectedKind)?.label} placement</div>
              <div className="text-muted">
                Arrow keys move between real layout targets. Enter confirms. Backspace resets.
              </div>
              <div className="text-muted">
                Target: {placementTarget?.label ?? 'none'}
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
