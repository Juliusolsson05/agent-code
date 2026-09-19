import { z } from 'zod'
import { ControlError, defineCapability, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { getEffectiveAgentSurfaceForSession, isAgentKind } from '@renderer/workspace/agentDisplayMode'
import type { Workspace } from '@renderer/workspace/hook'
import { agentFollowEnabled } from '@renderer/workspace/agentFollow'

const target = z.object({ sessionId: z.string().min(1) }).strict()
const output = z.object({ sessionId: z.string(), override: z.enum(['agent', 'terminal']).nullable(), globalMode: z.enum(['agent', 'terminal', 'hybrid']), effectiveSurface: z.enum(['rendered', 'terminal']), autoFollow: z.boolean(), tailAll: z.boolean(), tailWorking: z.boolean(), followEnabled: z.boolean(), revision: z.string() })
export function preferenceControlCapabilities(getWorkspace: () => Workspace) {
  const read = (sessionId: string) => {
    const state = useAppStore.getState()
    const meta = state.workspaceState.sessions[sessionId]
    if (!meta || !isAgentKind(meta.kind ?? 'claude') || state.workspaceState.buried.some(row => row.sessionId === sessionId)) throw new ControlError('unavailable', 'Choose an existing non-buried agent')
    const runtime = state.workspaceRuntimes[sessionId] ?? emptyRuntime()
    // Revisions cover the observation, including effective surface/follow, not
    // only stored preferences. Working activity can invalidate a read without
    // a settings edit; callers must re-read instead of acting on a stale On state.
    const value = { sessionId, override: meta.agentViewModeOverride ?? null, globalMode: state.settings.agentViewMode,
      effectiveSurface: getEffectiveAgentSurfaceForSession({ kind: meta.kind ?? 'claude', providerRuntime: meta.providerRuntime, globalMode: state.settings.agentViewMode, override: meta.agentViewModeOverride, runtime }),
      autoFollow: runtime.tailMode, tailAll: state.tailAllMode, tailWorking: state.tailWorkingMode, followEnabled: agentFollowEnabled(meta.kind, runtime, state) }
    return { ...value, revision: paginate([value], { limit: 1 }, `agent-preferences:${sessionId}`).revision }
  }
  const guard = (input: { sessionId: string; revision: string }) => {
    if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or finish the input-owning surface')
    const current = read(input.sessionId)
    if (current.revision !== input.revision) throw new ControlError('stale_cursor', 'Display or follow state changed; inspect again')
    return current
  }
  return [
    defineCapability({ id: 'views.preferencesRead', title: 'Read agent display and follow preferences', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Read an exact agent’s configured view override, global mode, effective rendered/terminal surface and auto-follow preference without focusing it. followEnabled includes Tail All and the activity-filtered Tail Working mode and applies to rendered feeds and raw agent terminal viewports; hidden panes suspend forced scrolling. Hybrid leases can temporarily change effectiveSurface. Returns the revision used by the setters.', input: target, output, handler: input => read(input.sessionId) }),
    defineCapability({ id: 'views.modeSet', title: 'Set an agent display mode', execution: 'window', effect: 'mutation', target: { kind: 'session', field: 'sessionId' },
      description: 'Set an exact agent’s durable Agent/Terminal override, or null to inherit global Agent/Terminal/Hybrid mode. Requires views.preferencesRead revision. Uses the normal provider policy: structured OpenCode cannot become a native terminal, and OpenCode Terminal cannot become a rendered agent. Does not focus, reload or rearrange panes.',
      input: target.extend({ revision: z.string(), mode: z.enum(['agent', 'terminal']).nullable() }), output,
      handler: input => { guard(input); if (!getWorkspace().setSessionAgentViewModeOverride(input.sessionId, input.mode)) throw new ControlError('unavailable', 'Provider rejected this view mode'); return read(input.sessionId) } }),
    defineCapability({ id: 'views.followSet', title: 'Set an agent auto-follow preference', execution: 'window', effect: 'mutation', target: { kind: 'session', field: 'sessionId' },
      description: 'Set the exact agent’s auto-follow preference for its rendered feed or raw terminal viewport using a fresh views.preferencesRead revision. Idempotent desired state; leaves other agents and pane layout untouched. Bulk follow modes can keep followEnabled true when this preference is false; inspect tailAll/tailWorking for the current window-wide policy.',
      input: target.extend({ revision: z.string(), enabled: z.boolean() }), output,
      handler: input => { const current = guard(input); if (current.autoFollow !== input.enabled) getWorkspace().toggleTailMode(input.sessionId); return read(input.sessionId) } }),
    defineCapability({ id: 'views.tailAllSet', title: 'Set window-wide agent auto-follow', execution: 'window', effect: 'mutation',
      description: 'Set Tail All for the explicitly selected window. Requires expected current value from views.preferencesRead.tailAll. Enabling it switches off Tail Working. Turning it off restores each agent’s own follow preference; it does not disable individually enabled followers. Hidden panes may suspend scrolling. Does not focus or rearrange panes.',
      input: z.object({ expected: z.boolean(), enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean() }),
      handler: input => {
        if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or finish the input-owning surface')
        const state = useAppStore.getState()
        if (state.tailAllMode !== input.expected) throw new ControlError('stale_cursor', 'Tail All changed; inspect again')
        // Use the ordinary owner only when a transition is necessary. Toggling
        // blindly makes a retry reverse the human's intended desired state.
        if (state.tailAllMode !== input.enabled) state.toggleTailAllMode()
        return { enabled: useAppStore.getState().tailAllMode }
      } }),
  ]
}
