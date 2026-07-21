import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { RewindPromptAddress } from '@shared/types/transcriptRewind'
import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { ClaudeDraftImage } from '@renderer/session-runtime/state'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import { switchAgentProvider } from '@renderer/workspace/hook/actions/providerSwitchCore'

// Provider-level actions on the focused pane.
//
// switchFocusedProvider   — Claude ↔ Codex translation of the focused
//                           session's transcript, then re-home pane
//                           onto the new provider.
// reloadFocusedAgent      — respawn the focused agent session with
//                           resume so the conversation history replays.
// rewindFocusedToPrompt   — user picks a past user prompt; pane
//                           re-homes onto a truncated transcript with
//                           the prompt prefilled as an unsent draft.

export function useProviderActions(
  refs: WorkspaceRefs,
  setRuntimes: WorkspaceSetRuntimes,
  showPaneToast: (sessionId: SessionId, message: string, durationMs?: number) => void,
  sessionActions: SessionActions,
): {
  switchFocusedProvider: () => Promise<void>
  reloadFocusedAgent: () => Promise<void>
  rewindFocusedToPrompt: (
    anchor: RewindPromptAddress,
  ) => Promise<void>
  undoLastRewind: () => Promise<void>
} {
  const switchFocusedProvider = useCallback(async () => {
    const current = refs.stateRef.current
    const sourceSessionId = commandTargetSessionIdForState(current)
    if (!sourceSessionId) return
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const sourceKind = meta.kind ?? DEFAULT_PROVIDER
    if (!isAgentProviderKind(sourceKind)) {
      // Non-agent (terminal) pane — nothing to switch.
      showPaneToast(sourceSessionId, 'Only agent panes can switch provider')
      return
    }
    // Focused command policy: toggle to "the other provider". The translate /
    // replace / empty-pane mechanics live in switchAgentProvider so the bulk
    // modal can reuse them; this command owns only the target choice and the
    // pane-scoped toast.
    //
    // Only the claude↔codex pair has a transcript translation path today:
    // main-side switchProvider throws for any other pair, and atp ships only
    // Claude/Codex codecs. OpenCode is a registered AgentProviderKind (so it
    // passes the guard above) but has NO transcript codec yet (the atp
    // opencode-codec follow-up, #406 step 7). Without this check an opencode
    // pane would compute targetKind='claude' via the negation below, attempt
    // opencode→claude, and hit switchProvider's "no translation path" throw —
    // surfacing as a confusing failure toast. Refuse cleanly instead.
    //
    // WHY the switchable pair is spelled out rather than registry-derived: it
    // mirrors the two file-transcript providers that actually have codecs.
    // When a third provider gains a codec + file layout this becomes a
    // capability lookup and the binary negation dies (#394 phase 5b, §6).
    if (sourceKind !== 'claude' && sourceKind !== 'codex') {
      showPaneToast(
        sourceSessionId,
        `${getRendererProviderCapabilities(sourceKind).shortLabel} panes can't switch provider yet`,
      )
      return
    }
    const targetKind = sourceKind === 'claude' ? 'codex' : 'claude'

    const result = await switchAgentProvider({
      sessionId: sourceSessionId,
      targetKind,
      refs,
      setRuntimes,
      sessionActions,
      onProgress: event => showPaneToast(sourceSessionId, event.message, 305_000),
    })

    if (result.status === 'switched') {
      showPaneToast(
        result.newSessionId,
        `Switched to ${getRendererProviderCapabilities(result.targetKind).shortLabel}`,
      )
    } else if (result.status === 'failed') {
      showPaneToast(sourceSessionId, result.message)
    } else {
      showPaneToast(sourceSessionId, result.reason)
    }
  }, [refs, sessionActions, setRuntimes, showPaneToast])

  const reloadFocusedAgent = useCallback(async () => {
    const current = refs.stateRef.current
    const sourceSessionId = commandTargetSessionIdForState(current)
    if (!sourceSessionId) return
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const kind = meta.kind ?? DEFAULT_PROVIDER
    if (!isAgentProviderKind(kind)) {
      // Toast text is registry-driven — "Only agent panes can reload" reads
      // right for any current OR future provider set. The previous
      // "Claude and Codex" wording rotted the moment OpenCode was registered.
      showPaneToast(sourceSessionId, 'Only agent panes can reload')
      return
    }
    const resumeSessionId = resumableProviderSessionId(meta)
    if (!resumeSessionId) {
      showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
      return
    }

    try {
      const newSessionId = await sessionActions.replaceSession(meta.cwd, {
        kind,
        resumeSessionId,
        builtInMcpDomains: meta.builtInMcpDomains,
      })
      if (!newSessionId) return
      showPaneToast(
        newSessionId,
        `${getRendererProviderCapabilities(kind).shortLabel} reloaded`,
      )
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Reload failed'
      showPaneToast(sourceSessionId, message)
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
  const rewindFocusedToPrompt = useCallback(
    async (anchor: RewindPromptAddress) => {
      const current = refs.stateRef.current
      const sourceSessionId = commandTargetSessionIdForState(current)
      if (!sourceSessionId) return
      const meta = current.sessions[sourceSessionId]
      if (!meta) return

      const kind = meta.kind ?? DEFAULT_PROVIDER
      if (!isAgentProviderKind(kind)) {
        // Registry-driven toast — see the reload-agent counterpart above.
        // Terminal panes are the only non-agent kind today; the wording will
        // continue to read right when future providers register.
        showPaneToast(sourceSessionId, 'Only agent panes support rewind')
        return
      }
      const previousProviderSessionId = resumableProviderSessionId(meta)
      if (!previousProviderSessionId) {
        showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
        return
      }
      if (kind !== anchor.provider) {
        showPaneToast(
          sourceSessionId,
          `Prompt address is for ${anchor.provider} but focused pane is ${kind}`,
        )
        return
      }

      const currentRuntime = refs.latestRuntimesRef.current[sourceSessionId]
      if (currentRuntime?.processActive || currentRuntime?.semantic.currentTurn) {
        showPaneToast(sourceSessionId, 'Wait for the current turn to finish before rewinding')
        return
      }

      try {
        const previousDraftInput = currentRuntime?.draftInput ?? ''
        const previousDraftImages = currentRuntime?.draftImages ?? []

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
        if (!newSessionId) return

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
                previousDraftInput,
                previousDraftImages: previousDraftImages.slice(),
                builtInMcpDomains: meta.builtInMcpDomains,
              },
            },
          }
        })

        showPaneToast(newSessionId, 'Rewound to prompt - Undo Rewind available until next submit')
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Rewind failed'
        showPaneToast(sourceSessionId, message)
      }
    },
    [refs.latestRuntimesRef, refs.stateRef, sessionActions, setRuntimes, showPaneToast],
  )

  const undoLastRewind = useCallback(async () => {
    const current = refs.stateRef.current
    const sourceSessionId = commandTargetSessionIdForState(current)
    if (!sourceSessionId) return
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const runtime = refs.latestRuntimesRef.current[sourceSessionId]
    const pending = runtime?.pendingRewindUndo ?? null
    if (!pending) {
      showPaneToast(sourceSessionId, 'No rewind to undo')
      return
    }

    const kind = meta.kind ?? DEFAULT_PROVIDER
    if (kind !== pending.provider) {
      showPaneToast(sourceSessionId, 'Rewind undo no longer matches this pane')
      return
    }
    if (meta.providerSessionId !== pending.rewoundProviderSessionId) {
      showPaneToast(sourceSessionId, 'Rewind undo is no longer available')
      return
    }
    if (runtime.processActive || runtime.semantic.currentTurn) {
      showPaneToast(sourceSessionId, 'Wait for the current turn to finish before undoing rewind')
      return
    }

    try {
      const newSessionId = await sessionActions.replaceSession(pending.cwd, {
        kind: pending.provider,
        resumeSessionId: pending.previousProviderSessionId,
        builtInMcpDomains: pending.builtInMcpDomains,
        targetSessionId: sourceSessionId,
      })
      if (!newSessionId) return

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
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Undo rewind failed'
      showPaneToast(sourceSessionId, message)
    }
  }, [refs.latestRuntimesRef, refs.stateRef, sessionActions, setRuntimes, showPaneToast])

  return { switchFocusedProvider, reloadFocusedAgent, rewindFocusedToPrompt, undoLastRewind }
}
