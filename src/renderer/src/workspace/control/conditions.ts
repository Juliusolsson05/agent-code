import { ControlError, defineCapability, nativeInputOutput, conditionTargetInput, conditionReadOutput, conditionReplyInput, conditionReplyOutput } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { z } from 'zod'

export function conditionControlCapabilities() {
  const invoke = async (capabilityId: string, input: { sessionId: string }) => {
    const state = useAppStore.getState().workspaceState
    const meta = state.sessions[input.sessionId]
    if (!meta || meta.kind === 'terminal' || state.buried.some(item => item.sessionId === input.sessionId)) throw new ControlError('unavailable', 'Choose a current, non-buried agent')
    const result = await window.api.controlInvoke({ capabilityId, input: { ...input, cwd: meta.cwd, provider: meta.kind ?? 'claude' } })
    if (!result.ok) throw new ControlError(result.error.code, result.error.message, result.error.outcome)
    return result.value
  }
  return [
    defineCapability({ id: 'agents.inputInspect', title: 'Inspect provider draft uncertainty', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Inspect backend readiness and whether the full native terminal draft is known. Currently nativeDraft.state is unknown: neither xterm accessibility input nor an empty Agent Code draft proves the provider composer is empty. Prefer agents.prompt with its provider-owned delivery checks. Before computer paste/Return, establish the full native composer through the actual UI; do not clear or submit uncertain existing text. Reads never wake or type.',
      input: conditionTargetInput, output: nativeInputOutput, handler: async input => nativeInputOutput.parse(await invoke('sessions.inputInspect', input)),
    }),
    defineCapability({
      id: 'agents.interrupt', title: 'Request Stop for an exact agent', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Send the same Escape signal as the composer Stop button to an active agent, preserving its process and draft. First call agents.conditionsRead and supply its revision; changed backend identity or any current condition refuses the write. Acceptance means the signal was delivered, not that the turn stopped. Read agents.read afterward. Does not wake or force-kill anything.',
      input: conditionTargetInput.extend({ revision: z.string().describe('Fresh revision from agents.conditionsRead.') }),
      output: z.object({ sessionId: z.string(), sessionRunId: z.string(), accepted: z.literal(true) }),
      handler: async input => {
        const runtime = useAppStore.getState().workspaceRuntimes[input.sessionId]
        if (!runtime?.processActive && !runtime?.semantic.currentTurn) throw new ControlError('unavailable', 'No active turn was observed')
        return z.object({ sessionId: z.string(), sessionRunId: z.string(), accepted: z.literal(true) }).parse(await invoke('sessions.interrupt', input))
      },
    }),
    defineCapability({
      id: 'agents.conditionsRead', title: 'Read current agent conditions', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Read current provider dialogs, questions and permissions with their advertised action IDs and an exact revision. Uses the live backend, never wakes an agent. An empty action list means use the condition UI; arbitrary typed answers are not synthesized by this tool.',
      input: conditionTargetInput, output: conditionReadOutput,
      handler: async input => conditionReadOutput.parse(await invoke('sessions.conditionsRead', input)),
    }),
    defineCapability({
      id: 'agents.conditionsReply', title: 'Choose an advertised condition action', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Choose one action returned by agents.conditionsRead, using its revision and condition kind. Revalidates the live backend and complete condition before writing. Preserves provider permission/trust semantics and existing input reservations. Success means action delivery, not that the agent finished or every dialog closed; read conditions again afterward. Use computer interaction for custom answers absent from the advertised actions.',
      input: conditionReplyInput, output: conditionReplyOutput,
      handler: async input => conditionReplyOutput.parse(await invoke('sessions.conditionsReply', input)),
    }),
  ]
}
