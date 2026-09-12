import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { TabId } from '@renderer/workspace/types'

export type MergeTabOption = {
  id: TabId
  /** `A · agent-code`, the Dispatch vocabulary. */
  label: string
  /** Exact working directories the tab's sessions run in; drives the default selection. */
  cwds: string[]
  /** Directory basenames for display. */
  directories: string[]
  sessionCount: number
}

type Props = {
  open: boolean
  tabs: MergeTabOption[]
  initialTargetId: TabId
  onCancel: () => void
  onConfirm: (targetId: TabId, sourceIds: TabId[]) => void
}

/**
 * Pick the tab to keep, then the tabs to fold into it (#913).
 *
 * WHY sources default to "shares a working directory with the target": that
 * is the duplicate-tab case the command exists for, and it is decided on the
 * exact cwd rather than the title, so two unrelated projects that happen to
 * share a folder name are not pre-ticked. Worktree tabs share no cwd with the
 * main checkout and are therefore a deliberate tick, never a default.
 */
export function MergeProjectTabsModal({ open, tabs, initialTargetId, onCancel, onConfirm }: Props) {
  const [targetId, setTargetId] = useState<TabId>(initialTargetId)
  const [sources, setSources] = useState<TabId[]>([])
  const wasOpenRef = useRef(false)

  const target = useMemo(() => tabs.find(tab => tab.id === targetId) ?? null, [tabs, targetId])

  const defaultSourcesFor = (id: TabId): TabId[] => {
    const chosen = tabs.find(tab => tab.id === id)
    if (!chosen) return []
    const cwds = new Set(chosen.cwds)
    return tabs.filter(tab => tab.id !== id && tab.cwds.some(cwd => cwds.has(cwd))).map(tab => tab.id)
  }

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setTargetId(initialTargetId)
      setSources(defaultSourcesFor(initialTargetId))
    }
    wasOpenRef.current = open
    // The default computation reads `tabs`, which the surface rebuilds per
    // render; re-running on every tab change would reset a half-made choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTargetId])

  // A tab that closed while the dialog is open silently leaves the draft.
  useEffect(() => {
    if (!open) return
    const valid = new Set(tabs.map(tab => tab.id))
    setSources(prev => {
      const next = prev.filter(id => valid.has(id))
      return next.length === prev.length ? prev : next
    })
    if (!valid.has(targetId) && tabs[0]) setTargetId(tabs[0].id)
  }, [open, tabs, targetId])

  const sourceSet = useMemo(() => new Set(sources), [sources])
  const movedCount = tabs.filter(tab => sourceSet.has(tab.id)).reduce((sum, tab) => sum + tab.sessionCount, 0)

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onCancel() }}>
      <DialogContent className="flex max-h-[80vh] w-[560px] max-w-[calc(100vw-64px)] flex-col">
        <DialogHeader>
          <DialogTitle className="font-semibold">Merge Project Tabs</DialogTitle>
          <DialogDescription>
            Keep one tab; the agents of the merged tabs move to its Dispatch list. Nothing restarts and no agent is closed.
          </DialogDescription>
        </DialogHeader>

        <div className="mx-4 mt-3 flex-shrink-0">
          <label className="text-[10px] uppercase tracking-wider text-muted" htmlFor="merge-target">
            Keep
          </label>
          <select
            id="merge-target"
            value={targetId}
            onChange={event => {
              const next = event.target.value
              setTargetId(next)
              setSources(defaultSourcesFor(next))
            }}
            className="rounded-control mt-1 w-full border border-border bg-canvas px-2 py-1 text-[12px] text-ink"
          >
            {tabs.map(tab => (
              <option key={tab.id} value={tab.id}>{tab.label}</option>
            ))}
          </select>
        </div>

        <div className="mx-4 mt-3 text-[10px] uppercase tracking-wider text-muted">Merge into it</div>
        <div className="rounded-slab mx-4 mb-3 mt-1 min-h-0 flex-1 overflow-auto border border-border bg-canvas">
          {tabs.filter(tab => tab.id !== targetId).map(tab => {
            const checked = sourceSet.has(tab.id)
            return (
              <label
                key={tab.id}
                className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  onChange={() => {
                    setSources(prev => (prev.includes(tab.id) ? prev.filter(id => id !== tab.id) : [...prev, tab.id]))
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ink">{tab.label}</span>
                  <span className="block truncate text-[10px] text-muted">{tab.directories.join(' · ')}</span>
                </span>
                <span className="flex-shrink-0 text-[10px] tabular-nums text-muted">{tab.sessionCount}</span>
              </label>
            )
          })}
        </div>

        <div className="mx-4 mb-2 flex-shrink-0 text-[11px] text-muted" role="status">
          {sources.length === 0 || !target
            ? 'Tick at least one tab to merge.'
            : `${sources.length} tab${sources.length === 1 ? '' : 's'}, ${movedCount} agent${movedCount === 1 ? '' : 's'} move to ${target.label}.`}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            type="button"
            disabled={sources.length === 0 || !target}
            onClick={() => { if (target) onConfirm(target.id, sources) }}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
