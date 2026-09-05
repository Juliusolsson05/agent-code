import { z } from 'zod'
import { ControlError, defineCapability, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { normalizeGridShape, MAX_DISPATCH_ROWS, MAX_DISPATCH_TILES, MAX_DISPATCH_LANES, INDEX_FRACTION_MIN, INDEX_FRACTION_MAX } from '@renderer/workspace/dispatch/gridShape'
import type { Workspace } from '@renderer/workspace/hook'

const tabId = z.string().describe('Stable project tab ID from app.observe in this window.')
const revision = z.string().describe('Current revision returned by layout.read; refresh it after every successful layout operation.')
const rows = z.array(z.object({ length: z.number().int().min(1).max(MAX_DISPATCH_TILES),
  sourceRow: z.number().int().min(0).nullable().describe('Existing row index to retain its agents and metadata; null creates a new empty row. Explicit identity prevents removing the wrong row.') }).strict()).min(1).max(MAX_DISPATCH_ROWS)
  .refine(values => values.reduce((sum, value) => sum + value.length, 0) <= MAX_DISPATCH_LANES, `At most ${MAX_DISPATCH_LANES} total lanes`)
  .describe('Complete desired rows in output order. Each names its prior row or null; at most 16 total lanes.')
const rowIndex = z.number().int().min(0).describe('Zero-based row index from layout.read; protected by the layout revision.')
const laneIndex = z.number().int().min(0).describe('Zero-based flat lane index from layout.read; rows are laid out in row-major order.')
const scope = z.enum(['project', 'global']).describe('Project uses the active project; global includes every project in this window.')
const layoutOutput = z.object({ revision: z.string(), activeTabId: z.string(), tabs: z.array(z.object({ id: z.string(), root: z.json() })),
  dispatch: z.json().nullable() })

export function layoutControlCapabilities(getWorkspace: () => Workspace) {
  const read = () => {
    const { workspaceState: state } = useAppStore.getState()
    const dispatch = state.dispatchMode ? { ...state.dispatchMode,
      ...(state.dispatchMode.tiled ? { tiled: normalizeGridShape(state.dispatchMode.tiled) } : {}) } : null
    const value = { activeTabId: state.activeTabId, tabs: state.tabs.map(({ id, root }) => ({ id, root })), dispatch }
    return { ...JSON.parse(JSON.stringify(value)), revision: paginate([value], { limit: 1 }, 'workspace-layout').revision }
  }
  const admit = (expected: string) => {
    if (getWorkspace().restoreStatus === 'pending') throw new ControlError('unavailable', 'Wait for workspace restoration')
    if (hasAppInteractionOwner()) throw new ControlError('unavailable', 'Another surface owns input; inspect or dismiss it first')
    if (read().revision !== expected) throw new ControlError('stale_cursor', 'Layout or selection changed; call layout.read again')
  }
  const project = (id: string) => {
    const tab = useAppStore.getState().workspaceState.tabs.find(tab => tab.id === id)
    if (!tab) throw new ControlError('unavailable', 'Project tab no longer exists')
    return tab
  }
  return [
    defineCapability({
      id: 'layout.read', title: 'Read project trees and Dispatch layout', execution: 'window', effect: 'read', input: z.object({}).strict(), output: layoutOutput,
      description: 'Read exact project tile trees, active tab and normalized Dispatch rows/lanes with a revision for edits. Tree split direction vertical means left/right; horizontal means top/bottom; ratio is the a-child share. Dispatch lanes are flat row-major indices, rows specify their lengths. Reading does not focus or wake agents.',
      handler: read,
    }),
    defineCapability({
      id: 'layout.adjust', title: 'Adjust a project grid', execution: 'window', effect: 'ui', target: { kind: 'project', field: 'tabId' },
      description: 'Adjust an explicit project using the existing layout operations. Equalize preserves the tree, balance rebuilds equal-sized cells, rotate swaps rows/columns, and divider sets the shared split between two leaves (and activates that tab). Never creates or closes sessions. For new panes, use agents.create then placement.list/attach.',
      input: z.object({ tabId, revision, change: z.discriminatedUnion('action', [
        z.object({ action: z.enum(['equalize', 'balance', 'rotate']) }).strict(),
        z.object({ action: z.literal('divider'), fromSessionId: z.string().describe('Leaf on the a side of the intended divider.'), toSessionId: z.string().describe('Leaf on its b side.'), ratio: z.number().min(0.1).max(0.9).describe('Share of the split allocated to its a child; between 0.1 and 0.9.') }).strict(),
      ]) }).strict(), output: layoutOutput,
      handler: input => {
        admit(input.revision)
        const tab = project(input.tabId)
        const change = input.change
        if (change.action === 'divider') {
          const leaves = collectLeaves(tab.root)
          if (change.fromSessionId === change.toSessionId || !leaves.includes(change.fromSessionId) || !leaves.includes(change.toSessionId)) throw new ControlError('unavailable', 'Choose two different leaves in the target grid')
          getWorkspace().setSplitRatioInTab(input.tabId, change.fromSessionId, change.toSessionId, change.ratio)
        } else if (change.action === 'equalize') getWorkspace().normalizeLayout(input.tabId)
        else if (change.action === 'balance') getWorkspace().hardNormalizeLayout(input.tabId)
        else getWorkspace().rotateLayout(input.tabId)
        return read()
      },
    }),
    defineCapability({
      id: 'tabs.reorder', title: 'Reorder project tabs', execution: 'window', effect: 'ui',
      description: 'Set the complete project tab order in this window. Requires every current tab ID exactly once and a fresh layout revision. Uses normal tab ordering without moving sessions between projects.',
      input: z.object({ tabIds: z.array(tabId).describe('Complete desired order, with each current tab ID exactly once.'), revision }).strict(), output: layoutOutput,
      handler: input => {
        admit(input.revision)
        const current = useAppStore.getState().workspaceState.tabs.map(tab => tab.id)
        if (input.tabIds.length !== current.length || new Set(input.tabIds).size !== current.length || input.tabIds.some(id => !current.includes(id))) throw new ControlError('invalid_input', 'Supply every current tab exactly once')
        getWorkspace().reorderTabs(input.tabIds)
        return read()
      },
    }),
    defineCapability({
      id: 'dispatch.configure', title: 'Configure Dispatch rows and lanes', execution: 'window', effect: 'ui',
      description: 'Change one explicit Dispatch setting through normal workspace actions, then return the resulting layout. Requires layout.read revision; refresh it between actions. Enter/scope resets tiled lanes to ordinary Dispatch. Grid sets row lengths, preserving existing lane assignments where the domain permits. Row project filters promote scope to global. Lane selection may wake the chosen existing agent; it never creates one. Exiting Dispatch returns to the project grid.',
      input: z.object({ revision, change: z.discriminatedUnion('action', [
        z.object({ action: z.literal('enter'), scope }).strict(),
        z.object({ action: z.literal('exit') }).strict(),
        z.object({ action: z.literal('scope'), scope }).strict(),
        z.object({ action: z.literal('grid'), rows }).strict(),
        z.object({ action: z.literal('lane-select'), laneIndex, sessionId: z.string().describe('Existing, non-buried session ID to show in this lane.') }).strict(),
        z.object({ action: z.literal('lane-focus'), laneIndex }).strict(),
        z.object({ action: z.literal('row-projects'), rowIndex, tabIds: z.array(tabId).describe('Project filter for this row; empty removes the filter.') }).strict(),
        z.object({ action: z.literal('row-cap-children'), rowIndex, enabled: z.boolean().describe('Whether related children are capped in this row index.') }).strict(),
        z.object({ action: z.literal('row-index-width'), rowIndex, fraction: z.number().min(INDEX_FRACTION_MIN).max(INDEX_FRACTION_MAX).describe('Fraction of row width used by its agent index.') }).strict(),
        z.object({ action: z.literal('lane-weights'), weights: z.array(z.number().positive()).describe('One relative width weight for every flat lane; normalized within each row.') }).strict(),
        z.object({ action: z.literal('row-heights'), weights: z.array(z.number().positive()).describe('One relative height weight per row.') }).strict(),
      ]) }).strict(), output: layoutOutput,
      handler: async input => {
        admit(input.revision)
        const change = input.change
        const workspace = getWorkspace()
        const state = useAppStore.getState().workspaceState
        const tiled = state.dispatchMode?.tiled ? normalizeGridShape(state.dispatchMode.tiled) : null
        if ('rowIndex' in change && (!tiled || change.rowIndex >= tiled.rows.length)) throw new ControlError('invalid_input', 'Row is outside the current grid')
        if ('laneIndex' in change && (!tiled || change.laneIndex >= tiled.lanes.length)) throw new ControlError('invalid_input', 'Lane is outside the current grid')
        switch (change.action) {
          case 'enter': await workspace.enterDispatchMode(change.scope); break
          case 'exit': workspace.exitDispatchMode(); break
          case 'scope': await workspace.setDispatchScope(change.scope); break
          case 'grid':
            if (!state.dispatchMode) throw new ControlError('unavailable', 'Enter Dispatch first')
            if (change.rows.some(row => row.sourceRow !== null && (!tiled || row.sourceRow >= tiled.rows.length))) throw new ControlError('invalid_input', 'A sourceRow does not exist; new rows use null')
            if (tiled) { if (!workspace.setDispatchGridShape(change.rows)) throw new ControlError('unavailable', 'Grid shape was refused') }
            else await workspace.enterTiledDispatch(change.rows.map(row => row.length))
            break
          case 'lane-select':
            if (!state.sessions[change.sessionId] || state.buried.some(item => item.sessionId === change.sessionId)) throw new ControlError('unavailable', 'Agent is absent or buried')
            await workspace.selectTiledLaneSession(change.laneIndex, change.sessionId)
            if (useAppStore.getState().workspaceState.dispatchMode?.tiled?.lanes[change.laneIndex]?.selectedSessionId !== change.sessionId) throw new ControlError('failed', 'Requested lane selection was not observed; read the layout', 'unknown')
            break
          case 'lane-focus': workspace.setTiledFocusedLane(change.laneIndex); break
          case 'row-projects': change.tabIds.forEach(project); workspace.setDispatchRowProjects(change.rowIndex, [...new Set(change.tabIds)]); break
          case 'row-cap-children': workspace.setDispatchRowCapChildren(change.rowIndex, change.enabled); break
          case 'row-index-width': workspace.setDispatchRowIndexFraction(change.rowIndex, change.fraction); break
          case 'lane-weights':
            if (!tiled || change.weights.length !== tiled.lanes.length) throw new ControlError('invalid_input', 'Supply one weight per lane')
            workspace.setDispatchLaneWeights(change.weights); break
          case 'row-heights':
            if (!tiled || change.weights.length !== tiled.rows.length) throw new ControlError('invalid_input', 'Supply one weight per row')
            workspace.setDispatchRowHeights(change.weights); break
        }
        return read()
      },
    }),
  ]
}
