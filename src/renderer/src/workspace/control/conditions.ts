import { ControlError, defineCapability, conditionTargetInput, conditionReadOutput, conditionReplyInput, conditionReplyOutput } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'

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
