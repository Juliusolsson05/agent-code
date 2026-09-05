import { z } from 'zod'
import { ControlError, defineCapability, terminalReadInput, terminalReadOutput, terminalInput, terminalInputOutput } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { Workspace } from '@renderer/workspace/hook'

export function terminalControlCapabilities(getWorkspace: () => Workspace) {
  const invoke = async (capabilityId: string, input: { sessionId: string }) => {
    const state = useAppStore.getState().workspaceState
    const meta = state.sessions[input.sessionId]
    if (!meta || state.buried.some(item => item.sessionId === input.sessionId)) throw new ControlError('unavailable', 'Session is absent or buried')
    const result = await window.api.controlInvoke({ capabilityId, input: { ...input, cwd: meta.cwd, provider: meta.kind ?? 'claude' } })
    if (!result.ok) throw new ControlError(result.error.code, result.error.message, result.error.outcome)
    return result.value
  }
  return [
    defineCapability({
      id: 'terminals.create', title: 'Create a project terminal', execution: 'window', effect: 'mutation', target: { kind: 'project', field: 'tabId' },
      description: 'Create a new shell as a detached session in an explicit project, using the named anchor session directory. Uses the normal spawn/placement transaction and returns the exact new ID. Existing tiled Dispatch may select its lane. Use dispatch.configure or placement.list/attach to place the terminal; this does not send a shell command.',
      input: z.object({ tabId: z.string().describe('Project tab ID from app.observe.'), anchorSessionId: z.string().describe('Existing session in that project whose cwd the new shell should use.') }).strict(),
      output: z.object({ sessionId: z.string(), tabId: z.string(), cwd: z.string() }),
      handler: async input => {
        if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or dismiss the input-owning surface')
        const state = useAppStore.getState().workspaceState
        if (!resolveTabSessions(state, input.tabId).includes(input.anchorSessionId)) throw new ControlError('unavailable', 'Anchor is not in this project')
        const sessionId = await getWorkspace().createDetachedSession({ kind: 'terminal' }, input)
        if (!sessionId) throw new ControlError('failed', 'Terminal creation did not produce a placed session; inspect the project', 'unknown')
        const meta = useAppStore.getState().workspaceState.sessions[sessionId]
        if (!meta || meta.kind !== 'terminal') throw new ControlError('failed', 'Created terminal is no longer present', 'unknown')
        return { sessionId, tabId: input.tabId, cwd: meta.cwd }
      },
    }),
    defineCapability({
      id: 'terminals.read', title: 'Read retained terminal output', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Read raw retained PTY replay from a shell or agent terminal without waking it, attaching another terminal view or changing its size. Defaults to a recent tail. Use range retained and nextCursor for all currently buffered output. ANSI/control sequences remain raw, and older output outside the bounded replay may already be unavailable. This is not a shell-command completion detector; use agents.read for rendered conversation text.',
      input: terminalReadInput, output: terminalReadOutput,
      handler: async input => terminalReadOutput.parse(await invoke('sessions.terminalRead', input)),
    }),
    defineCapability({
      id: 'terminals.input', title: 'Send exact terminal input', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Send exact raw input to the backend lifetime observed by terminals.read. Nothing is appended and no Enter is inferred. The active program interprets these bytes; an agent terminal may be showing a permission dialog. Existing provider input reservations are respected. Delivery is not execution completion. For agent tasks prefer agents.prompt, and for advertised condition choices prefer agents.conditionsReply.',
      input: terminalInput, output: terminalInputOutput,
      handler: async input => terminalInputOutput.parse(await invoke('sessions.terminalInput', input)),
    }),
  ]
}
