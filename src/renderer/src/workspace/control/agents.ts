import { z } from 'zod'
import { startControlTask } from './startTask'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { observeWorkspace, workspaceObservationSchema } from '@renderer/workspace/control'
import type { Workspace } from '@renderer/workspace/hook'
import { AGENT_PROVIDER_RUNTIMES } from '@shared/types/providerKind'
import { buildPlacementTargets } from '@renderer/features/workspace/lib/newAgentPlacement'
import { setAgentTitleInWorkspace } from '@renderer/workspace/agentTitle'

const sessionInput = z.object({ sessionId: z.string().min(1).describe('Stable agent sessionId from agents.search/list; not a provider-native transcript ID or numbered tile.') }).strict()
const sessionReference = workspaceObservationSchema.shape.sessions.element
const provider = z.enum(['claude', 'codex', 'opencode']).describe('Provider for the new agent; its CLI must already be configured in Agent Code.')

export function agentControlCapabilities(getWorkspace: () => Workspace) {
  const observe = () => observeWorkspace(getWorkspace)
  const setTitle = (sessionId: string, title: string) => useAppStore.getState().setWorkspaceState(
    state => setAgentTitleInWorkspace(state, sessionId, title),
  )
  const requireSession = (sessionId: string, allowBuried = false, allowTerminal = false) => {
    const current = observe().sessions.find(session => session.sessionId === sessionId)
    if (!current || (!allowTerminal && current.provider === 'terminal')) throw new ControlError('unavailable', 'Agent does not exist in this window')
    if (!allowBuried && current.placements.some(placement => placement.kind === 'buried')) {
      throw new ControlError('unavailable', 'Agent is buried; restore it explicitly before acting')
    }
    return current
  }
  const requireReady = () => {
    if (getWorkspace().restoreStatus === 'pending') throw new ControlError('unavailable', 'Workspace restoration is still in progress')
  }
  const requireUi = () => {
    requireReady()
    if (hasAppInteractionOwner()) throw new ControlError('unavailable', 'A surface owns input. Inspect or close it before changing the workspace')
  }
  const placements = (tabId: string, anchorSessionId: string) => {
    const tab = useAppStore.getState().workspaceState.tabs.find(tab => tab.id === tabId)
    if (!tab) throw new ControlError('unavailable', 'Project no longer exists')
    return buildPlacementTargets(tab.root, anchorSessionId, { x: 0, y: 0, width: 1, height: 1 })
  }
  return [
    defineCapability({
      id: 'agents.close', target: { kind: 'session', field: 'sessionId' }, title: 'Close an agent', execution: 'window', effect: 'mutation', completion: 'accepted',
      description: 'Request the normal close of an exact agent, including the app’s existing child-cascade confirmation. Returns an accepted callId immediately; finish any confirmation with computer use and read operations.read for the eventual closed result. Does not bypass confirmation or force-kill a process.',
      input: sessionInput, output: z.object({ callId: z.string(), accepted: z.literal(true) }),
      handler: ({ sessionId }, context) => {
        requireUi(); requireSession(sessionId)
        return startControlTask(context, async () => {
          // Admission crosses IPC. Recheck the exact captured target and surface
          // before opening the ordinary confirmation gate; never follow focus.
          requireUi(); requireSession(sessionId)
          const closed = await getWorkspace().closeSession(sessionId)
          return { sessionId, closed }
        })
      },
    }),
    defineCapability({
      id: 'placement.list', target: { kind: 'project', field: 'tabId' }, title: 'List grid placement choices', execution: 'window', effect: 'read',
      description: 'List actual placement-overlay targets around an explicit grid anchor, including root wrapping. Coordinates are normalized to the project grid.',
      input: z.object({ tabId: z.string().describe('Project tab ID from app.observe in the target window.'), anchorSessionId: z.string().describe('Existing agent in this project that supplies the working directory or grid placement anchor.') }).strict(),
      output: z.object({ revision: z.string().describe('Revision returned by placement.list; prevents applying an outdated layout target.'), targets: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string(),
        direction: z.string(), side: z.string(), scope: z.string(), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }) })) }),
      handler: ({ tabId, anchorSessionId }) => {
        const targets = placements(tabId, anchorSessionId)
        return { revision: paginate(targets, { limit: 200 }, `placement:${tabId}:${anchorSessionId}`).revision, targets }
      },
    }),
    defineCapability({
      id: 'placement.attach', target: { kind: 'session', field: 'sessionId' }, title: 'Attach an agent to the grid', execution: 'window', effect: 'mutation',
      description: 'Attach an existing detached agent or terminal using a target and revision from placement.list. Uses the existing placement operation and revalidates the anchor after wake.',
      input: sessionInput.extend({ tabId: z.string().describe('Project tab ID from app.observe in the target window.'), anchorSessionId: z.string().describe('Existing agent in this project that supplies the working directory or grid placement anchor.'), targetId: z.string().describe('Exact target ID returned by placement.list for this anchor.'), revision: z.string().describe('Revision returned by placement.list; prevents applying an outdated layout target.') }),
      output: sessionReference,
      handler: async ({ sessionId, tabId, anchorSessionId, targetId, revision }) => {
        requireUi()
        const session = requireSession(sessionId, false, true)
        if (!session.placements.some(placement => placement.kind === 'detached')) throw new ControlError('unavailable', 'Agent is already attached')
        const targets = placements(tabId, anchorSessionId)
        if (paginate(targets, { limit: 200 }, `placement:${tabId}:${anchorSessionId}`).revision !== revision) throw new ControlError('stale_cursor', 'Placement changed; list targets again')
        const target = targets.find(target => target.id === targetId)
        if (!target) throw new ControlError('unavailable', 'Placement target no longer exists')
        await getWorkspace().attachDetachedToGrid(sessionId, tabId, target)
        const placed = requireSession(sessionId, false, true)
        if (!placed.placements.some(placement => placement.kind === 'grid' && placement.tabId === tabId)) {
          throw new ControlError('failed', 'Attachment was not observed; inspect current placement', 'unknown')
        }
        return placed
      },
    }),
    defineCapability({
      id: 'agents.list', title: 'Find agents', execution: 'window', effect: 'read',
      description: 'Search all agents by stable ID, title, directory and provider, including detached and buried records. Reading never wakes an agent.',
      input: z.object({ query: z.string().default('').describe('Case-insensitive substring of session ID, title, working directory or provider. Empty lists all agents in this window.'), tabId: z.string().describe('Project tab ID from app.observe in the target window.').optional(), ...pageInput }).strict(),
      output: pageSchema(sessionReference),
      handler: input => {
        const query = input.query.trim().toLocaleLowerCase()
        const rows = observe().sessions.filter(session => session.provider !== 'terminal'
          && (!input.tabId || session.placements.some(placement => placement.tabId === input.tabId))
          && [session.sessionId, session.title, session.displayedTitle, session.displayLabel ?? '', session.cwd, session.provider].some(value => value.toLocaleLowerCase().includes(query)))
        return paginate(rows, input, `agents:${query}:${input.tabId ?? ''}`)
      },
    }),
    defineCapability({
      id: 'agents.locate', target: { kind: 'session', field: 'sessionId' }, title: 'Locate an agent', execution: 'window', effect: 'read', input: sessionInput,
      description: 'Get every placement of one stable agent, including mirrored lanes and hidden records, without focusing or waking it.',
      output: sessionReference, handler: ({ sessionId }) => requireSession(sessionId, true),
    }),
    defineCapability({
      id: 'agents.show', target: { kind: 'session', field: 'sessionId' }, title: 'Show an existing agent', execution: 'window', effect: 'ui',
      description: 'Focus this exact agent through the existing Grid, Dispatch, tiled-tab or related-child route. May wake a detached agent under the same ID. Never creates a replacement agent; buried records require agents.restore first.',
      input: sessionInput.extend({ intent: z.enum(['reuse-existing-view', 'open-in-focused-tiled-dispatch-lane']).default('reuse-existing-view').describe('Reuse the existing agent view, or explicitly place it into the currently focused tiled Dispatch lane.') }),
      output: z.object({ session: sessionReference, mode: workspaceObservationSchema.shape.mode,
        bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }) }),
      handler: async ({ sessionId, intent }) => {
        requireUi(); requireSession(sessionId)
        if (!await getWorkspace().focusAgentBySessionId(sessionId, intent)) throw new ControlError('unavailable', 'Agent could not be shown; inspect state before retrying', 'unknown')
        // Reader and Spotlight own legitimate alternate agent views. Move their
        // explicit selection too instead of reporting a hidden grid as visible.
        const store = useAppStore.getState()
        if (store.workspaceReaderMode) getWorkspace().setReaderModeSession(sessionId)
        if (store.workspaceSpotlight) getWorkspace().setSpotlightSession(sessionId)
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const state = observe()
        const session = requireSession(sessionId)
        if (state.focusedSessionId !== sessionId || !session.placements.some(placement => placement.visible)) throw new ControlError('failed', 'Navigation committed but the target is no longer visibly focused', 'unknown')
        const pane = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(element => {
          const rect = element.getBoundingClientRect()
          return element.dataset.paneId === sessionId && rect.width > 0 && rect.height > 0
        })
        if (!pane || hasAppInteractionOwner()) throw new ControlError('failed', 'The target view was not observed or another surface took input; inspect the UI', 'unknown')
        const { x, y, width, height } = pane.getBoundingClientRect()
        return { session, mode: state.mode, bounds: { x, y, width, height } }
      },
    }),
    defineCapability({
      id: 'agents.restore', target: { kind: 'session', field: 'sessionId' }, title: 'Restore a buried agent', execution: 'window', effect: 'mutation',
      description: 'Explicitly restore one buried record through the UI restore policy, waking the same session ID if needed. Returns the resulting placement.',
      input: sessionInput, output: sessionReference,
      handler: async ({ sessionId }) => {
        requireUi(); requireSession(sessionId, true)
        const buried = useAppStore.getState().workspaceState.buried.find(record => record.sessionId === sessionId)
        if (!buried) throw new ControlError('unavailable', 'This agent is not buried')
        await getWorkspace().reviveBuried(buried.id)
        return requireSession(sessionId)
      },
    }),
    defineCapability({
      id: 'agents.titleSet', target: { kind: 'session', field: 'sessionId' }, title: 'Set an agent title', execution: 'window', effect: 'mutation',
      description: 'Set or clear the exact agent title using the same normalization and length policy as the UI. Does not send a prompt.',
      input: sessionInput.extend({ title: z.string().describe('Agent display title; empty clears a custom title. Normal UI normalization applies.') }), output: z.object({ sessionId: z.string(), title: z.string().describe('Agent display title; empty clears a custom title. Normal UI normalization applies.') }),
      handler: ({ sessionId, title }) => {
        requireReady(); requireSession(sessionId)
        setTitle(sessionId, title)
        return { sessionId, title: requireSession(sessionId).title }
      },
    }),
    defineCapability({
      id: 'agents.pinSet', target: { kind: 'session', field: 'sessionId' }, title: 'Set agent pin', execution: 'window', effect: 'mutation',
      description: 'Pin or unpin an exact agent. This is an explicit desired value, so repeating the intention cannot toggle it back.',
      input: sessionInput.extend({ pinned: z.boolean().describe('Desired pin state; this sets a value rather than toggling it.') }), output: z.object({ sessionId: z.string(), pinned: z.boolean().describe('Desired pin state; this sets a value rather than toggling it.') }),
      handler: ({ sessionId, pinned }) => {
        requireReady(); requireSession(sessionId)
        const workspace = getWorkspace()
        if (pinned) workspace.pinSession(sessionId)
        else workspace.unpinSession(sessionId)
        return { sessionId, pinned: requireSession(sessionId).pinned }
      },
    }),
    defineCapability({
      id: 'projects.open', title: 'Open a project', execution: 'window', effect: 'mutation',
      description: 'Open a directory in a new project tab with an initial agent. Reuses an existing tab with that exact directory unless createDuplicate is explicit.',
      input: z.object({ cwd: z.string().min(1).describe('Absolute local directory to open as a project.'), provider: provider.default('claude'), createDuplicate: z.boolean().default(false).describe('False reuses one existing project with exactly this directory; true explicitly creates another tab.') }).strict(),
      output: z.object({ tabId: z.string().describe('Project tab ID from app.observe in the target window.'), sessionId: z.string(), created: z.boolean() }),
      handler: async ({ cwd, provider: kind, createDuplicate }) => {
        requireUi()
        const state = useAppStore.getState().workspaceState
        const matches = state.tabs.filter(tab => resolveTabSessions(state, tab.id).some(id => state.sessions[id]?.cwd === cwd))
        if (!createDuplicate && matches.length > 1) throw new ControlError('ambiguous_owner', 'Several project tabs use this directory; select a tab ID')
        if (!createDuplicate && matches.length === 1) {
          const tab = matches[0]
          getWorkspace().activateTab(tab.id)
          return { tabId: tab.id, sessionId: tab.focusedSessionId, created: false }
        }
        return { ...await getWorkspace().newTab(cwd, undefined, kind), created: true }
      },
    }),
    defineCapability({
      id: 'agents.create', target: { kind: 'project', field: 'tabId' }, title: 'Create a project agent', execution: 'window', effect: 'mutation',
      description: 'Create an ordinary detached agent in the explicit project, anchored to an existing agent directory. Detached means outside the project grid, not hidden: selectCreated defaults true, activates the project and selects the new agent in the Dispatch lane focused when creation began, replacing that view without closing its agent. Set selectCreated:false to preserve tabs and lane assignments, then use layout.read and dispatch.configure (lane-select) to place the returned ID in an explicit lane.',
      input: z.object({ tabId: z.string().describe('Project tab ID from app.observe in the target window.'), anchorSessionId: z.string().describe('Existing agent in this project that supplies the working directory or grid placement anchor.'), provider,
        selectCreated: z.boolean().default(true).describe('False preserves the current tab and every Dispatch lane; true selects the created agent using normal UI creation behavior.'), providerRuntime: z.enum(AGENT_PROVIDER_RUNTIMES).optional().describe('Omit for the normal structured agent view. terminal requests the provider-native terminal runtime.'), title: z.string().describe('Agent display title; empty clears a custom title. Normal UI normalization applies.').optional() }).strict(),
      output: sessionReference,
      handler: async ({ tabId, anchorSessionId, provider: kind, providerRuntime, title, selectCreated }) => {
        requireUi(); requireSession(anchorSessionId)
        if (!resolveTabSessions(useAppStore.getState().workspaceState, tabId).includes(anchorSessionId)) {
          throw new ControlError('unavailable', 'Anchor does not belong to that project')
        }
        const sessionId = await getWorkspace().createDetachedDispatchAgent({ kind, providerRuntime }, { tabId, anchorSessionId }, undefined, { selectCreated })
        if (!sessionId) throw new ControlError('failed', 'Agent creation did not produce a placed session; inspect the project', 'unknown')
        if (title !== undefined) setTitle(sessionId, title)
        return requireSession(sessionId)
      },
    }),
    defineCapability({
      id: 'agents.prompt', target: { kind: 'session', field: 'sessionId' }, title: 'Send an agent prompt', execution: 'window', effect: 'mutation', completion: 'accepted',
      description: 'Deliver text to the exact agent through the provider delivery protocol. Reports user, queue or transport acceptance, not task completion. Preserves the Agent Code composer draft and never retries an uncertain write. Native TUI drafts are separate: agents.inputInspect reports available knowledge; provider delivery checks remain authoritative and transport acceptance is not proof of the exact committed text.',
      input: sessionInput.extend({ prompt: z.string().min(1).max(1_000_000).describe('Exact text to deliver once. A successful acceptance can be queued; inspect agents.read for actual progress.') }),
      output: z.object({ sessionId: z.string(), acceptance: z.object({ kind: z.enum(['user', 'queue', 'transport']), acceptedAt: z.number(), entryId: z.string().optional() }) }),
      handler: async ({ sessionId, prompt }) => {
        requireReady(); requireSession(sessionId)
        await getWorkspace().ensureSessionLive(sessionId, 'control.send-prompt')
        requireReady(); requireSession(sessionId)
        const delivery = await window.api.deliverPrompt(sessionId, prompt)
        if (!delivery.ok) throw new ControlError('failed', JSON.stringify(delivery), delivery.retrySafe ? 'not_started' : 'unknown')
        return { sessionId, acceptance: delivery.acceptance }
      },
    }),
  ]
}
