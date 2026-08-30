import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { normalizeGridShape } from '@renderer/workspace/dispatch/gridShape'

// Which project a Grid Dispatch row is restricted to.
//
// WHY one list with "Any project" in it rather than a bind/unbind pair: unbound
// is a VALUE of the same setting, not a separate action. That is the same
// correction that made the scope command "Dispatch Scope" naming both ends
// instead of shipping "Global Dispatch: On", which told the user nothing about
// what Off meant.
//
// Binding FILTERS, it never fills. The row's index and strips stop offering
// other projects' agents; no lane is populated, moved, or cleared. The user
// named a constraint, not an occupant.
export function DispatchRowProjectModal({
  rowIndex,
  workspace,
  onClose,
}: {
  rowIndex: number | null
  workspace: Workspace
  onClose: () => void
}) {
  const tiled = workspace.state.dispatchMode?.tiled
  // Read the CURRENT binding so the active row is marked. Guard the null
  // rowIndex: the surface stays mounted-but-closed between opens.
  const current =
    rowIndex !== null && tiled
      ? normalizeGridShape(tiled).rows[rowIndex]?.projectTabId
      : undefined

  const choose = (tabId: string | undefined) => {
    if (rowIndex !== null) workspace.setDispatchRowProject(rowIndex, tabId)
    onClose()
  }

  return (
    <Dialog open={rowIndex !== null} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="w-[380px] max-w-[calc(100vw-64px)]">
        <DialogHeader>
          <DialogTitle>Row project</DialogTitle>
          <DialogDescription className="text-[10px]">
            Restrict this row&rsquo;s index and selectors to one project. Agents
            already in its lanes are left alone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col px-2 py-2">
          <RowProjectOption
            label="Any project"
            hint="Follows the Dispatch scope"
            active={current === undefined}
            onSelect={() => choose(undefined)}
          />
          {workspace.state.tabs.map((tab, index) => (
            <RowProjectOption
              key={tab.id}
              // The same A/B/C vocabulary the dispatch labels and pinned project
              // chips already use, so the picker names projects the way the
              // index does rather than inventing a second scheme.
              label={`${tabIndexLabel(index)} · ${tab.title}`}
              active={current === tab.id}
              onSelect={() => choose(tab.id)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RowProjectOption({
  label,
  hint,
  active,
  onSelect,
}: {
  label: string
  hint?: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex items-baseline justify-between gap-3 rounded px-3 py-1.5 text-left text-xs hover:bg-surface-raised focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${
        active ? 'text-accent' : 'text-fg'
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      {hint && <span className="flex-shrink-0 text-[10px] text-muted">{hint}</span>}
    </button>
  )
}
