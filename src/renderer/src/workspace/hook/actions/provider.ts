import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind, AgentProviderRuntime } from '@shared/types/providerKind'
import type { RewindPromptAddress } from '@shared/types/transcriptRewind'
import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { ClaudeDraftImage } from '@renderer/session-runtime/state'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import { switchAgentProvider, type SwitchAgentProviderResult } from '@renderer/workspace/hook/actions/providerSwitchCore'
import { providerChoiceLabel } from '@renderer/workspace/providerChoices'

// Provider-level actions on the focused pane.
//
// switchSessionProvider   — translate one captured session to an explicit
//                           provider/runtime destination and re-home its pane.
// reloadFocusedAgent      — respawn the focused agent session with
//                           resume so the conversation history replays.
// rewindFocusedToPrompt   — user picks a past user prompt; pane
//                           re-homes onto a truncated transcript with
//                           the prompt prefilled as an unsent draft.

// Domain outcomes are shared by UI commands and external control. A returned
// Promise<void> cannot distinguish a declined operation from a replacement;
// the transport must not infer success from a toast or a changed session census.
export type AgentLifecycleResult =
  | { status: 'completed'; sourceSessionId: SessionId; newSessionId: SessionId }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; message: string }

export function useProviderActions(
  refs: WorkspaceRefs,
  setRuntimes: WorkspaceSetRuntimes,
  showPaneToast: (sessionId: SessionId, message: string, durationMs?: number) => void,
  sessionActions: SessionActions,
): {
  switchSessionProvider: (
    sourceSessionId: SessionId,
    targetKind: AgentProviderKind,
    targetProviderRuntime?: AgentProviderRuntime,
  ) => Promise<SwitchAgentProviderResult>
  reloadSessionAgent: (sourceSessionId: SessionId) => Promise<AgentLifecycleResult>
  rewindSessionToPrompt: (sourceSessionId: SessionId, anchor: RewindPromptAddress) => Promise<AgentLifecycleResult>
  undoSessionRewind: (sourceSessionId: SessionId) => Promise<AgentLifecycleResult>
  reloadFocusedAgent: () => Promise<void>
  rewindFocusedToPrompt: (
    anchor: RewindPromptAddress,
  ) => Promise<void>
  undoLastRewind: () => Promise<void>
} {
  const switchSessionProvider = useCallback(async (
    sourceSessionId: SessionId,
    targetKind: AgentProviderKind,
    targetProviderRuntime?: AgentProviderRuntime,
  ): Promise<SwitchAgentProviderResult> => {
    const current = refs.stateRef.current
    const meta = current.sessions[sourceSessionId]
    if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

    const sourceKind = meta.kind ?? DEFAULT_PROVIDER
    if (!isAgentProviderKind(sourceKind)) {
      // Non-agent (terminal) pane — nothing to switch.
      showPaneToast(sourceSessionId, 'Only agent panes can switch provider')
      return { status: 'skipped', reason: 'Only agent panes can switch provider' }
    }
    const result = await switchAgentProvider({
      sessionId: sourceSessionId,
      targetKind,
      targetProviderRuntime,
      refs,
      setRuntimes,
      sessionActions,
      onProgress: event => showPaneToast(sourceSessionId, event.message, 305_000),
    })

    if (result.status === 'switched') {
      showPaneToast(
        result.newSessionId,
        `Switched to ${providerChoiceLabel(result.targetKind, targetProviderRuntime)}`,
      )
    } else if (result.status === 'failed') {
      showPaneToast(sourceSessionId, result.message)
    } else {
      showPaneToast(sourceSessionId, result.reason)
    }
    return result
  }, [refs, sessionActions, setRuntimes, showPaneToast])

  const reloadSessionAgent = useCallback(async (sourceSessionId: SessionId): Promise<AgentLifecycleResult> => {
    const current = refs.stateRef.current
    const meta = current.sessions[sourceSessionId]
    if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

    const kind = meta.kind ?? DEFAULT_PROVIDER
    if (!isAgentProviderKind(kind)) {
      // Toast text is registry-driven — "Only agent panes can reload" reads
      // right for any current OR future provider set. The previous
      // "Claude and Codex" wording rotted the moment OpenCode was registered.
      showPaneToast(sourceSessionId, 'Only agent panes can reload')
      return { status: 'skipped', reason: 'Only agent panes can reload' }
    }
    const resumeSessionId = resumableProviderSessionId(meta)
    if (!resumeSessionId) {
      showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
      return { status: 'skipped', reason: 'Provider session id is not ready yet' }
    }

    try {
      const newSessionId = await sessionActions.replaceSession(meta.cwd, {
        kind,
        targetSessionId: sourceSessionId,
        resumeSessionId,
        builtInMcpDomains: meta.builtInMcpDomains,
      })
      if (!newSessionId) return { status: 'failed', message: 'Replacement was not committed' }
      showPaneToast(
        newSessionId,
        `${getRendererProviderCapabilities(kind).shortLabel} reloaded`,
      )
      return { status: 'completed', sourceSessionId, newSessionId }
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Reload failed'
      showPaneToast(sourceSessionId, message)
      return { status: 'failed', message }
    }
  }, [refs.stateRef, sessionActions, showPaneToast])

  // Rewind the focused pane to a selected earlier user prompt.
  //
  // Contract (see docs/superpowers/plans for the full rationale):
  //   1. The source session's on-disk transcript is NOT touched.
  //   2. Main produces a fresh provider session id whose transcript
  //      ends strictly before the anchor.
  //   3. The focused pane is re-homed to the new id via
  //      `replaceSession(...)`, so the pane stays in place; only its
  //      backing session swaps. This matches resume semantics.
  //   4. The anchored prompt's text is stuffed into the new pane's
  //      `draftInput` — the rewound session opens with the prompt
  //      prefilled and UNSENT, so the user can edit or re-send.
  //
  // Bail-outs:
  //   - No providerSessionId yet (pane still spawning): toast and
  //     return. Rewinding a session we can't locate on disk is a
  //     nonsense operation.
  //   - Session is mid-turn (processActive or live currentTurn):
  //     toast and return. Rewinding while a response is streaming
  //     exercises every race we have around the live-to-committed
  //     handoff at once; requiring idle is the safe path.
  const rewindSessionToPrompt = useCallback(
    async (sourceSessionId: SessionId, anchor: RewindPromptAddress): Promise<AgentLifecycleResult> => {
      const current = refs.stateRef.current
      const meta = current.sessions[sourceSessionId]
      if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

      const kind = meta.kind ?? DEFAULT_PROVIDER
      if (!isAgentProviderKind(kind)) {
        // Registry-driven toast — see the reload-agent counterpart above.
        // Terminal panes are the only non-agent kind today; the wording will
        // continue to read right when future providers register.
        showPaneToast(sourceSessionId, 'Only agent panes support rewind')
        return { status: 'skipped', reason: 'Only agent panes support rewind' }
      }
      const previousProviderSessionId = resumableProviderSessionId(meta)
      if (!previousProviderSessionId) {
        showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
        return { status: 'skipped', reason: 'Provider session id is not ready yet' }
      }
      if (kind !== anchor.provider) {
        showPaneToast(
          sourceSessionId,
          `Prompt address is for ${anchor.provider} but focused pane is ${kind}`,
        )
        return { status: 'skipped', reason: 'Prompt provider differs from this session' }
      }

      const currentRuntime = refs.latestRuntimesRef.current[sourceSessionId]
      if (currentRuntime?.processActive || currentRuntime?.semantic.currentTurn) {
        showPaneToast(sourceSessionId, 'Wait for the current turn to finish before rewinding')
        return { status: 'skipped', reason: 'Wait for the current turn to finish before rewinding' }
      }

      try {
        const result = await window.api.rewindToPrompt({
          provider: kind,
          sourceProviderSessionId: previousProviderSessionId,
          cwd: meta.cwd,
          anchor,
        })

        const newSessionId = await sessionActions.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: result.newProviderSessionId,
          builtInMcpDomains: meta.builtInMcpDomains,
          targetSessionId: sourceSessionId,
        })
        if (!newSessionId) return { status: 'failed', message: 'Replacement was not committed' }

        // `replaceSession` copied the PRIOR pane's draft forward.
        // For rewind we deliberately clobber that draft with the
        // anchored prompt text — the whole feature is "open this
        // prompt in unsent form so I can edit/re-send it".
        //
        // Bash mode: Claude Code exposes a `bash` input mode that
        // prefixes `!` when composing. Agent Code's composer doesn't
        // have a discrete bash mode yet, but it DOES treat a
        // leading `!` as bash. Mirroring CC's behavior means
        // "rewinding to a /bash-input prompt rehydrates as
        // `!<body>`" so the next Enter submits as bash again.
        //
        // Images: convert the main-process image records (base64 +
        // mediaType) into `ClaudeDraftImage` shape the composer
        // already renders and can send. The preview URL uses a
        // data: URL so no blob lifecycle is needed.
        const draftText =
          result.promptMode === 'bash' && result.promptText.length > 0
            ? `!${result.promptText}`
            : result.promptText

        const draftImages: ClaudeDraftImage[] =
          kind === 'claude'
            ? result.promptImages.map((image, index) => ({
                id: `rewind-${Date.now()}-${index}`,
                mediaType: image.mediaType,
                base64Data: image.data,
                previewUrl: `data:${image.mediaType};base64,${image.data}`,
                filename: `rewind-${index + 1}`,
              }))
            : []

        setRuntimes(prev => {
          const runtime = prev[newSessionId]
          if (!runtime) return prev
          return {
            ...prev,
            [newSessionId]: {
              ...runtime,
              draftInput: draftText,
              draftImages,
              // Runtime-only rewind undo records the provider transcript we just
              // left, not the local Agent Code session id we killed. Local ids
              // are routing handles for this renderer launch; provider ids are
              // the durable resume identity that `replaceSession` already knows
              // how to swap back into the same pane. The record intentionally
              // rides on the replacement runtime so command visibility follows
              // the rewound pane, including detached Dispatch rows.
              pendingRewindUndo: {
                createdAt: Date.now(),
                provider: kind,
                cwd: meta.cwd,
                previousProviderSessionId,
                rewoundProviderSessionId: result.newProviderSessionId,
                rewoundPromptText: result.promptText,
                rewoundPromptTimestamp: result.promptTimestamp,
                // The replacement owner just transferred the latest draft.
                // Save that here, not the pre-export snapshot: edits made while
                // native rewind/spawn awaited must remain recoverable by Undo.
                previousDraftInput: runtime.draftInput,
                previousDraftImages: runtime.draftImages.slice(),
                builtInMcpDomains: meta.builtInMcpDomains,
              },
            },
          }
        })

        showPaneToast(newSessionId, 'Rewound to prompt - Undo Rewind available until next submit')
        return { status: 'completed', sourceSessionId, newSessionId }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Rewind failed'
        showPaneToast(sourceSessionId, message)
        return { status: 'failed', message }
      }
    },
    [refs.latestRuntimesRef, refs.stateRef, sessionActions, setRuntimes, showPaneToast],
  )

  const undoSessionRewind = useCallback(async (sourceSessionId: SessionId): Promise<AgentLifecycleResult> => {
    const current = refs.stateRef.current
    const meta = current.sessions[sourceSessionId]
    if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

    const runtime = refs.latestRuntimesRef.current[sourceSessionId]
    const pending = runtime?.pendingRewindUndo ?? null
    if (!pending) {
      showPaneToast(sourceSessionId, 'No rewind to undo')
      return { status: 'skipped', reason: 'No rewind to undo' }
    }

    const kind = meta.kind ?? DEFAULT_PROVIDER
    if (kind !== pending.provider) {
      showPaneToast(sourceSessionId, 'Rewind undo no longer matches this pane')
      return { status: 'skipped', reason: 'Rewind undo no longer matches this pane' }
    }
    if (meta.providerSessionId !== pending.rewoundProviderSessionId) {
      showPaneToast(sourceSessionId, 'Rewind undo is no longer available')
      return { status: 'skipped', reason: 'Rewind undo is no longer available' }
    }
    if (runtime.processActive || runtime.semantic.currentTurn) {
      showPaneToast(sourceSessionId, 'Wait for the current turn to finish before undoing rewind')
      return { status: 'skipped', reason: 'Wait for the current turn to finish before undoing rewind' }
    }

    try {
      const newSessionId = await sessionActions.replaceSession(pending.cwd, {
        kind: pending.provider,
        resumeSessionId: pending.previousProviderSessionId,
        builtInMcpDomains: pending.builtInMcpDomains,
        targetSessionId: sourceSessionId,
      })
      if (!newSessionId) return { status: 'failed', message: 'Replacement was not committed' }

      setRuntimes(prev => {
        const restored = prev[newSessionId]
        if (!restored) return prev
        return {
          ...prev,
          [newSessionId]: {
            ...restored,
            // Undo Rewind restores the composer to the user's pre-rewind draft
            // because the rewound draft is the selected historical prompt, not
            // the user's current unsent work. Clearing the pending record here
            // keeps undo one-way; a redo-style stack would need a separate
            // product model and should not appear accidentally from this swap.
            draftInput: pending.previousDraftInput,
            draftImages: pending.previousDraftImages,
            pendingRewindUndo: null,
          },
        }
      })

      showPaneToast(newSessionId, 'Undid rewind')
      return { status: 'completed', sourceSessionId, newSessionId }
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Undo rewind failed'
      showPaneToast(sourceSessionId, message)
      return { status: 'failed', message }
    }
  }, [refs.latestRuntimesRef, refs.stateRef, sessionActions, setRuntimes, showPaneToast])

  // UI commands capture focus once, before any asynchronous work. External
  // callers use the explicit methods directly and never move selection as a
  // substitute for specifying an operation target.
  const reloadFocusedAgent = useCallback(async () => {
    const id = commandTargetSessionIdForState(refs.stateRef.current)
    if (id) await reloadSessionAgent(id)
  }, [refs.stateRef, reloadSessionAgent])
  const rewindFocusedToPrompt = useCallback(async (anchor: RewindPromptAddress) => {
    const id = commandTargetSessionIdForState(refs.stateRef.current)
    if (id) await rewindSessionToPrompt(id, anchor)
  }, [refs.stateRef, rewindSessionToPrompt])
  const undoLastRewind = useCallback(async () => {
    const id = commandTargetSessionIdForState(refs.stateRef.current)
    if (id) await undoSessionRewind(id)
  }, [refs.stateRef, undoSessionRewind])
  return { switchSessionProvider, reloadSessionAgent, rewindSessionToPrompt, undoSessionRewind,
    reloadFocusedAgent, rewindFocusedToPrompt, undoLastRewind }
}
