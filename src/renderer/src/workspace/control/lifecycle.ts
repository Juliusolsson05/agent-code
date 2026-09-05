import { z } from 'zod'
import { ControlError, defineCapability, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import type { Workspace } from '@renderer/workspace/hook'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import { providerSwitchChoices } from '@renderer/workspace/providerChoices'
import { isAgentProviderKind } from '@shared/types/providerKind'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { startControlTask } from './startTask'

const target = z.object({ sessionId: z.string().min(1).describe('Exact Agent Code sessionId from agents.search; not the native transcript ID.') }).strict()
const revision = z.string().describe('Revision from agents.lifecycleRead. Refresh it after any lifecycle or draft change.')
const accepted = z.object({ callId: z.string(), accepted: z.literal(true) })
const address = z.object({ provider: z.enum(['claude', 'codex', 'opencode']), line: z.number().int().min(0),
  sessionId: z.string().nullable(), uuid: z.string().nullable().optional() }).strict()

// Lifecycle adapters consume observable domain results, not toasts or before/
// after session-set differences. The native transaction remains the only place
// allowed to replace a session; the journal task only carries its final result.
export function lifecycleControlCapabilities(getWorkspace: () => Workspace) {
  const inspect = (sessionId: string) => {
    const state = useAppStore.getState()
    const meta = state.workspaceState.sessions[sessionId]
    if (!meta || !isAgentProviderKind(meta.kind ?? 'claude') || state.workspaceState.buried.some(row => row.sessionId === sessionId)) {
      throw new ControlError('unavailable', 'Agent is absent, buried or not an agent; inspect or restore it first')
    }
    const provider = meta.kind ?? 'claude'
    if (!isAgentProviderKind(provider)) throw new ControlError('unavailable', 'Not an agent')
    const runtime = state.workspaceRuntimes[sessionId]
    const nativeSessionId = resumableProviderSessionId(meta) ?? null
    const processActive = runtime?.processActive === true || Boolean(runtime?.semantic.currentTurn)
    // Do not hash streaming text: it would invalidate every inspection. The
    // guard covers identity, activity boundaries and unsent work, which are the
    // facts a destructive replacement decision was made against.
    const evidence = { meta, processActive, draft: runtime?.draftInput ?? '', images: runtime?.draftImages.map(image => image.id) ?? [],
      rewindUndo: runtime?.pendingRewindUndo?.createdAt ?? null, providerSwitch: runtime?.providerSwitch ?? null }
    return { sessionId, provider, providerRuntime: meta.providerRuntime ?? null, nativeSessionId, cwd: meta.cwd, processActive,
      hasRewindUndo: Boolean(runtime?.pendingRewindUndo), revision: paginate([evidence], { limit: 1 }, `lifecycle:${sessionId}`).revision,
      switchChoices: providerSwitchChoices(provider).map(choice => ({ provider: choice.kind, runtime: choice.providerRuntime ?? null, label: choice.label })) }
  }
  const guard = (input: { sessionId: string; revision: string }) => {
    if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or finish the input-owning surface')
    const current = inspect(input.sessionId)
    if (current.revision !== input.revision) throw new ControlError('stale_cursor', 'Agent lifecycle or draft changed; read agents.lifecycleRead again')
    return current
  }
  const result = (value: { status: string; reason?: string; message?: string; newSessionId?: string }, sourceSessionId: string) => {
    if (value.status === 'skipped') throw new ControlError('unavailable', value.reason ?? 'Operation declined')
    if (value.status === 'failed' || !value.newSessionId) throw new ControlError('failed', value.message ?? 'Replacement was not observed', 'unknown')
    return { sourceSessionId, newSessionId: value.newSessionId, status: value.status }
  }
  return [
    defineCapability({ id: 'agents.resume', title: 'Resume a native session in a project', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'project', field: 'tabId' },
      description: 'Open a known native conversation as a new detached agent in an explicit project. Supply provider/nativeSessionId/cwd from nativeHistory.list; known OpenCode IDs are supported. This resumes the same native conversation, not a copy; the ordinary backend ownership policy applies if already open. Returns a task callId; operations.read reports the exact newSessionId. Use agents.show or placement.attach afterward.',
      input: z.object({ tabId: z.string(), anchorSessionId: z.string(), provider: z.enum(['claude', 'codex', 'opencode']), nativeSessionId: z.string().min(1), cwd: z.string().min(1), runtime: z.enum(['terminal']).optional() }).strict(), output: accepted,
      handler: (input, context) => {
        const check = () => {
          if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or finish the input-owning surface')
          if (!resolveTabSessions(useAppStore.getState().workspaceState, input.tabId).includes(input.anchorSessionId)) throw new ControlError('unavailable', 'Anchor is not in the target project')
          if (input.runtime && input.provider !== 'opencode') throw new ControlError('invalid_input', 'Only OpenCode supports the terminal runtime')
        }
        check()
        return startControlTask(context, async () => {
          check()
          const newSessionId = await getWorkspace().createDetachedSession({ kind: input.provider, providerRuntime: input.runtime },
            { tabId: input.tabId, anchorSessionId: input.anchorSessionId }, { cwd: input.cwd, resumeSessionId: input.nativeSessionId })
          if (!newSessionId) throw new ControlError('failed', 'Resume did not commit a placed session; inspect before retrying', 'unknown')
          return { newSessionId, nativeSessionId: input.nativeSessionId }
        })
      },
    }),
    defineCapability({ id: 'agents.duplicate', title: 'Branch an exact agent conversation', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Copy an idle native conversation to a new native identity and create a detached agent in the chosen project. Preserves provider/runtime and enabled built-in domain names; leaves the source and its draft intact. Requires a fresh lifecycle revision and an explicit target project/anchor in the same window. Use operations.read for both new IDs, then agents.show or placement.attach. A failed placement can leave a native transcript copy; do not blindly retry unknown outcomes.',
      input: target.extend({ revision, tabId: z.string(), anchorSessionId: z.string() }), output: accepted,
      handler: (input, context) => {
        const check = () => {
          const value = guard(input)
          if (!value.nativeSessionId || value.processActive || !getProviderFeatures(value.provider).transcriptDuplicate) throw new ControlError('unavailable', 'Choose an idle native conversation with duplicate support')
          if (!resolveTabSessions(useAppStore.getState().workspaceState, input.tabId).includes(input.anchorSessionId)) throw new ControlError('unavailable', 'Anchor is not in the target project')
          return value
        }
        check()
        return startControlTask(context, async () => {
          const value = check()
          const meta = useAppStore.getState().workspaceState.sessions[input.sessionId]
          const clone = await window.api.duplicateSession({ provider: value.provider, sourceProviderSessionId: value.nativeSessionId!, cwd: value.cwd })
          // The source can change during export. Never place a clone under a
          // newly selected project or pretend to have branched the new state.
          check()
          const newSessionId = await getWorkspace().createDetachedSession({ kind: value.provider, providerRuntime: meta.providerRuntime },
            { tabId: input.tabId, anchorSessionId: input.anchorSessionId }, { cwd: value.cwd, resumeSessionId: clone.newProviderSessionId, builtInMcpDomains: meta.builtInMcpDomains })
          if (!newSessionId) throw new ControlError('failed', `Native copy ${clone.newProviderSessionId} exists but no placement was committed`, 'unknown')
          return { sourceSessionId: input.sessionId, newSessionId, nativeSessionId: clone.newProviderSessionId }
        })
      },
    }),
    defineCapability({ id: 'agents.lifecycleRead', title: 'Inspect agent lifecycle choices', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Inspect native session identity, activity, rewind-undo availability and actual supported provider/runtime switch choices without waking the agent. Its revision binds subsequent lifecycle mutations to the observed identity and draft. Native transcript IDs differ from Agent Code session IDs.',
      input: target, output: z.object({ sessionId: z.string(), provider: z.string(), providerRuntime: z.string().nullable(), nativeSessionId: z.string().nullable(), cwd: z.string(),
        processActive: z.boolean(), hasRewindUndo: z.boolean(), revision, switchChoices: z.array(z.object({ provider: z.string(), runtime: z.string().nullable(), label: z.string() })) }),
      handler: ({ sessionId }) => inspect(sessionId),
    }),
    defineCapability({ id: 'agents.switchProvider', title: 'Switch an exact agent provider', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Move an observed agent to one of agents.lifecycleRead switchChoices through the normal translation, capacity/compaction and replacement transaction. May open a confirmation or take minutes. Returns a task callId; use operations.read for the new Agent Code session ID or failure. Draft and supported internal MCP-domain continuity follow the ordinary UI operation. Never assume the source ID remains valid.',
      input: target.extend({ revision, provider: z.enum(['claude', 'codex', 'opencode']), runtime: z.enum(['terminal']).optional().describe('Supply only when the chosen switchChoices entry declares this runtime; omit for structured rendering.') }), output: accepted,
      handler: (input, context) => {
        const current = guard(input)
        if (!current.switchChoices.some(choice => choice.provider === input.provider && choice.runtime === (input.runtime ?? null))) throw new ControlError('invalid_input', 'Choose a supported provider/runtime from agents.lifecycleRead')
        return startControlTask(context, async () => { guard(input); return result(await getWorkspace().switchSessionProvider(input.sessionId, input.provider, input.runtime), input.sessionId) })
      },
    }),
    defineCapability({ id: 'agents.reload', title: 'Reload an exact agent backend', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Restart one agent through its native resume identity, preserving its placement, runtime and draft through the existing replacement transaction. Requires an idle, resumable agent and a fresh lifecycle revision. This replaces the Agent Code session ID. Read operations.read for completion/newSessionId; it is not a visual-only refresh.',
      input: target.extend({ revision }), output: accepted,
      handler: (input, context) => {
        const check = () => { const value = guard(input); if (!value.nativeSessionId || value.processActive) throw new ControlError('unavailable', 'Reload requires an idle agent with a native session ID'); return value }
        check()
        return startControlTask(context, async () => { check(); return result(await getWorkspace().reloadSessionAgent(input.sessionId), input.sessionId) })
      },
    }),
    defineCapability({ id: 'agents.rewind', title: 'Rewind an exact agent to a native prompt', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Create a new native transcript ending before an exact prompt address from nativeHistory.prompts, and replace this idle agent in place. The original transcript remains intact. The selected historical prompt becomes the new unsent draft, replacing the current draft; undoRewind can restore the prior conversation/draft until the next submission. First read agents.lifecycleRead. Use operations.read for the final newSessionId; acceptance alone is not completion.',
      input: target.extend({ revision, address: address.describe('Exact address from nativeHistory.prompts for this native session; never infer line numbers from rendered feed rows.') }), output: accepted,
      handler: (input, context) => {
        const check = () => { const value = guard(input); if (!value.nativeSessionId || value.processActive) throw new ControlError('unavailable', 'Rewind requires an idle resumable agent');
          // Imported transcripts can retain original source session IDs in
          // their addresses. The native transcript engine owns exact address
          // membership; comparing source identity to the container ID here
          // would reject valid rewinds of translated/cloned conversations.
          if (input.address.provider !== value.provider) throw new ControlError('invalid_input', 'Prompt provider differs from this agent') }
        check()
        return startControlTask(context, async () => { check(); return result(await getWorkspace().rewindSessionToPrompt(input.sessionId, input.address), input.sessionId) })
      },
    }),
    defineCapability({ id: 'agents.undoRewind', title: 'Undo an agent rewind', execution: 'window', effect: 'mutation', completion: 'accepted', target: { kind: 'session', field: 'sessionId' },
      description: 'Restore the prior native conversation and pre-rewind draft using the existing one-use undo record. Requires an idle agent with hasRewindUndo from agents.lifecycleRead; submission expires undo. Replaces the local session ID again. Read operations.read for its final newSessionId.',
      input: target.extend({ revision }), output: accepted,
      handler: (input, context) => {
        const check = () => { const value = guard(input); if (!value.hasRewindUndo || value.processActive) throw new ControlError('unavailable', 'No idle rewind undo is available') }
        check()
        return startControlTask(context, async () => { check(); return result(await getWorkspace().undoSessionRewind(input.sessionId), input.sessionId) })
      },
    }),
  ]
}
