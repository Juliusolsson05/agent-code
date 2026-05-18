import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { ClaudeDraftImage } from '@renderer/workspace/workspaceState'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

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
    anchor:
      | { kind: 'claude'; uuid: string }
      | { kind: 'codex'; userMessageIndex: number },
  ) => Promise<void>
  undoLastRewind: () => Promise<void>
} {
  const switchFocusedProvider = useCallback(async () => {
    const current = refs.stateRef.current
    const sourceSessionId = commandTargetSessionIdForState(current)
    if (!sourceSessionId) return
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const sourceKind = meta.kind ?? 'claude'
    if (sourceKind !== 'claude' && sourceKind !== 'codex') {
      showPaneToast(sourceSessionId, 'Only Claude and Codex panes can switch provider')
      return
    }
    if (!meta.providerSessionId) {
      showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
      return
    }

    try {
      // The translated target transcript must be created BEFORE we
      // replace the live pane. If translation fails, the current
      // provider process should stay untouched and the user should
      // keep their running session instead of being dropped into a
      // dead pane.
      const result = await window.api.switchProvider({
        sourceKind,
        sourceProviderSessionId: meta.providerSessionId,
        cwd: meta.cwd,
      })

      const newSessionId = await sessionActions.replaceSession(meta.cwd, {
        kind: result.targetKind,
        resumeSessionId: result.targetProviderSessionId,
        builtInMcpDomains: meta.builtInMcpDomains,
      })
      if (!newSessionId) return

      showPaneToast(
        newSessionId,
        result.targetKind === 'codex' ? 'Switched to Codex' : 'Switched to Claude',
      )
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Provider switch failed'
      showPaneToast(sourceSessionId, message)
    }
  }, [refs.stateRef, sessionActions, showPaneToast])

  const reloadFocusedAgent = useCallback(async () => {
    const current = refs.stateRef.current
    const sourceSessionId = commandTargetSessionIdForState(current)
    if (!sourceSessionId) return
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const kind = meta.kind ?? 'claude'
    if (kind !== 'claude' && kind !== 'codex') {
      showPaneToast(sourceSessionId, 'Only Claude and Codex panes can reload')
      return
    }
    if (!meta.providerSessionId) {
      showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
      return
    }

    try {
      const newSessionId = await sessionActions.replaceSession(meta.cwd, {
        kind,
        resumeSessionId: meta.providerSessionId,
        builtInMcpDomains: meta.builtInMcpDomains,
      })
      if (!newSessionId) return
      showPaneToast(
        newSessionId,
        kind === 'codex' ? 'Codex reloaded' : 'Claude reloaded',
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
    async (
      anchor:
        | { kind: 'claude'; uuid: string }
        | { kind: 'codex'; userMessageIndex: number },
    ) => {
      const current = refs.stateRef.current
      const sourceSessionId = commandTargetSessionIdForState(current)
      if (!sourceSessionId) return
      const meta = current.sessions[sourceSessionId]
      if (!meta) return

      const kind = meta.kind ?? 'claude'
      if (kind !== 'claude' && kind !== 'codex') {
        showPaneToast(sourceSessionId, 'Only Claude and Codex panes support rewind')
        return
      }
      if (!meta.providerSessionId) {
        showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
        return
      }
      const previousProviderSessionId = meta.providerSessionId
      if (kind !== anchor.kind) {
        showPaneToast(
          sourceSessionId,
          `Anchor is ${anchor.kind} but focused pane is ${kind}`,
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
                rewoundPromptTimestamp: null,
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

    const kind = meta.kind ?? 'claude'
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
