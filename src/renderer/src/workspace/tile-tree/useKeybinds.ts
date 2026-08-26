import { useEffect, useMemo } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import type { BindingContext } from '@renderer/features/command-keybindings/defaults'
import { keybindingFromEvent } from '@renderer/features/command-keybindings/normalize'
import { commandOwnsOpenSurface } from '@renderer/features/command-palette/surfaceOwnership'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { getEffectiveAgentSurface, isAgentKind } from '@renderer/workspace/agentDisplayMode'
import {
  buildVisibleDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { nextTiledRowIndex } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { enumerateCodeBlockIds } from '@renderer/features/copy-code-block/lib/enumerateCodeBlocks'
import { getCodeBlockCode } from '@renderer/features/copy-code-block/lib/codeBlockRegistry'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Keybinds: global window-level listeners. The handler is attached to
// `document` in a single useEffect, which captures the key BEFORE the
// focused input element sees it (via `capture: true`). That's necessary
// because all the keybinds fire while an input is focused — without
// capture, the input would swallow them.
//
// Keybind scheme (user-approved in brainstorming, section 4):
//   cmd-t           new tab (prompts for cwd)
//   cmd-shift-r     resume: open the path modal with the focused tab's
//                   cwd pre-filled, so the resume list for that cwd is
//                   visible instantly. Same modal as cmd-t — one path
//                   to both flows — just with a different default
//                   value and intent.
//   cmd-w           close focused pane (collapses tree; closes tab if last)
//   cmd-shift-w     close active tab outright
//   cmd-1..9        activate Nth tab
//                   In Dispatch Mode this selects the Nth visible session row.
//                   Press a second digit while cmd is still held to select
//                   rows 10..99, preserving digit order (cmd-1 then 2 → 12).
//   cmd-alt-1..9    activate Nth tab, including while Dispatch Mode owns cmd-N.
//   cmd-[           previous tab
//   cmd-]           next tab
//   cmd-shift-p     command palette
//   cmd-shift-e     Global Editor overlay toggle
//   cmd-alt-e       Global Editor fullscreen (opens the editor first if
//                   needed; Esc exits fullscreen)
//   cmd-p           Quick Open file in the Global Editor (opens the
//                   editor first if needed)
//   cmd-shift-f     Search in files (Global Editor; opens it if needed)
//   alt-d           split current pane vertically (new pane to the right)
//   alt-shift-d     split current pane horizontally (new pane below)
//   alt-t           split with a TERMINAL below (new row, horizontal split)
//   alt-shift-t     split with a TERMINAL to the right (new column, vertical)
//   alt-c           split with CODEX below (new row, horizontal split)
//   alt-shift-c     split with CODEX to the right (new column, vertical)
//   alt-h/j/k/l     navigate panes (vim: left/down/up/right)
//   alt-ArrowLeft/Right/Up/Down  same, for non-vim users
//   alt-w           close focused pane (same as cmd-w but alt-keyed)
//   alt-=           grow focused split (direction-agnostic, nearest split)
//   alt--           shrink focused split (direction-agnostic, nearest split)
//   fn-alt-Arrow    directional resize — grow focused pane toward that
//                   direction. tmux-style semantics: finds the nearest
//                   split in the matching axis containing the focused
//                   pane on the correct side and adjusts its ratio.
//
//                   Why fn-alt and not alt-shift: on macOS, Option+Shift
//                   +Arrow is the system shortcut for word-by-word text
//                   selection, which is load-bearing for every text
//                   field in the app (including our composer). Fn+Arrow
//                   is the OS-level translation to Home/End/PageUp/
//                   PageDown, so "fn+option+arrow" arrives in JS as
//                   altKey=true with e.key === 'Home' / 'End' /
//                   'PageUp' / 'PageDown'. That combo has no conflicting
//                   system meaning, and we never have to touch the
//                   actual Fn modifier (which isn't exposed to JS).


function isTextEditingTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit'
  }
  return el.isContentEditable
}

const BLOCKED_META_CODES = new Set([
  'BracketLeft',
  'BracketRight',
  'KeyE',
  'KeyP',
  'KeyR',
  'KeyT',
  'KeyW',
])

const BLOCKED_ALT_CODES = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Equal',
  'Home',
  'KeyC',
  'KeyD',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyT',
  'KeyW',
  'Minus',
  'PageDown',
  'PageUp',
])

export function shouldPreventOwnedApplicationShortcut(event: KeyboardEvent): boolean {
  // WHY this is an allow-list of Agent Code chords instead of "any Cmd/Alt":
  // a modal input still needs native editing shortcuts (Cmd+C/V/X/A/Z) and
  // macOS Option-based character entry. The earlier per-modal bailout blocked
  // every modified key, which happened to protect the workspace but also made
  // legitimate form editing inert. Suppress only chords this router owns.
  if (event.metaKey) {
    if (/^Digit[0-9]$/.test(event.code)) return true
    if (event.altKey && /^Digit[1-9]$/.test(event.code)) return true
    return BLOCKED_META_CODES.has(event.code)
  }
  if (!event.altKey) return false
  // Option is also macOS's text-composition modifier. While an app-owned
  // surface has an editable target, Option+C may produce "ç" and Option+Arrow
  // performs native word navigation/selection. The ownership gate already
  // prevents the workspace router from acting; preventing the browser default
  // here would only break the modal's legitimate editing behavior.
  if (isTextEditingTarget(event.target)) return false
  if (/^Digit[0-9]$/.test(event.code)) return true
  return BLOCKED_ALT_CODES.has(event.code)
}

function renderedAgentSurfaceIsVisible(
  workspace: Workspace,
  agentViewMode: string,
  sessionId: string,
): boolean {
  const kind = workspace.state.sessions[sessionId]?.kind
  if (!isAgentKind(kind)) return false
  return (
    getEffectiveAgentSurface({
      kind,
      mode: agentViewMode === 'terminal' || agentViewMode === 'hybrid' ? agentViewMode : 'agent',
      runtime: workspace.getRuntime(sessionId),
    }) === 'rendered'
  )
}

/**
 * Commands whose chord is owned by a surface OTHER than this router, and which
 * must therefore never be dispatched from here.
 *
 * This is a DENY-list, not an allow-list, and the difference is the whole
 * lesson of the first attempt. That version enumerated 24 routable ids while
 * Settings offered bindings for all 98 commands, so 74 rows persisted a chord,
 * displayed it, reserved it against every other command in the collision
 * checker — and did nothing when pressed. A hand-maintained allow-list cannot
 * stay in step with a growing catalog, and it silently disagreed with the
 * generated provider commands too.
 *
 * Deny-listing inverts the failure: forget an entry here and a chord is routed
 * that should have been left to the editor, which is visible immediately,
 * rather than a binding that quietly never fires.
 */
const SURFACE_OWNED_COMMAND_IDS: ReadonlySet<string> = new Set([
  // Monaco and the EditorWorkbench own ⌘S inside editor chrome, where the
  // routed path never runs (the editor guard returns before routing). Listing
  // it is belt-and-braces so a future guard change cannot hand Save to the
  // workspace router.
  'save-editor-file',
])

/**
 * Which binding contexts are live for THIS event.
 *
 * The first attempt matched on chord alone and ignored `BindingContext`
 * entirely, which killed Dispatch navigation: ⌥J resolved to the grid-context
 * `nav-down`, got preventDefault-ed, and was then refused by admission — so the
 * Dispatch handler below never ran and the selection never moved.
 *
 * Returning a SET rather than a single context is what makes that correct:
 * several contexts are genuinely live at once ('global' always, plus exactly
 * one of grid/dispatch, plus 'feed' only when a rendered feed is focused and
 * the user is not typing).
 */
function activeBindingContexts(input: {
  dispatchMode: boolean
  editorOwnsTarget: boolean
  feedFocused: boolean
}): ReadonlySet<BindingContext> {
  const contexts = new Set<BindingContext>(['global'])
  contexts.add(input.dispatchMode ? 'dispatch' : 'grid')
  if (input.editorOwnsTarget) contexts.add('editor')
  if (input.feedFocused) contexts.add('feed')
  return contexts
}

/**
 * The command id a keyboard event should invoke, or null.
 *
 * Built from EFFECTIVE bindings (shipped defaults overlaid with the user's
 * overrides), so the chord the palette displays and the chord that runs are the
 * same fact and a Settings edit changes real behaviour.
 *
 * `bindingIndex` is precomputed by the caller: resolving it here meant
 * rebuilding the default table and re-normalizing ~30 strings on EVERY keydown,
 * including ordinary typing.
 */
function routedCommandForEvent(
  event: KeyboardEvent,
  bindingIndex: ReadonlyMap<string, { commandId: string; context: BindingContext }[]>,
  activeContexts: ReadonlySet<BindingContext>,
): string | null {
  const binding = keybindingFromEvent(event)
  if (!binding) return null
  for (const entry of bindingIndex.get(binding) ?? []) {
    if (SURFACE_OWNED_COMMAND_IDS.has(entry.commandId)) continue
    if (!activeContexts.has(entry.context)) continue
    return entry.commandId
  }
  return null
}

/** The only context a chord may fire in while a surface owns the interaction.
 *  See the exemption in the handler for why this is not the live context set. */
const GLOBAL_CONTEXT_ONLY: ReadonlySet<BindingContext> = new Set<BindingContext>(['global'])

/** Chord -> candidate commands, built once per override change. */
function buildBindingIndex(
  overrides: Record<string, string[]>,
): Map<string, { commandId: string; context: BindingContext }[]> {
  const index = new Map<string, { commandId: string; context: BindingContext }[]>()
  for (const entry of resolveEffectiveKeybindings(overrides, buildDefaultKeybindings())) {
    for (const binding of entry.bindings) {
      const list = index.get(binding) ?? []
      list.push({ commandId: entry.commandId, context: entry.context })
      index.set(binding, list)
    }
  }
  return index
}

export function useKeybinds(
  workspace: Workspace,
): void {
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const requestCommandInvocation = useAppStore(state => state.requestCommandInvocation)
  const commandKeybindingOverrides = useAppStore(
    state => state.settings.commandKeybindingOverrides,
  )
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const buryPromptSessionId = useAppStore(state => state.buryPromptSessionId)
  const closeBuryPrompt = useAppStore(state => state.closeBuryPrompt)
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  // The placement overlay is opened from TWO independent flows:
  // - newAgentPlacementOpen: the cmd+T / new-agent-placement flow
  // - dispatchAttachIntent: attach-detached-to-grid
  // - linkedAgentParentId: linked-agent kind picker
  // App.tsx already unifies them as `placementOverlayOpen` and
  // closes them together via `closePlacementOverlay`. We must
  // subscribe to all three here — an earlier revision only checked
  // newAgentPlacementOpen, so cmd+W / cmd+1..9 / alt+d still
  // mutated the workspace under sibling overlay modes before the
  // overlay's own listener could stop propagation. See PR #75 review.
  const dispatchAttachIntent = useAppStore(state => state.dispatchAttachIntent)
  const closeDispatchAttach = useAppStore(state => state.closeDispatchAttach)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  const closeLinkedAgent = useAppStore(state => state.closeLinkedAgent)
  // Reorder Tabs and Pin Agents are modal overlays with their own
  // internal onKeyDown handlers. Without bailing out here, the
  // global capture-phase handler still fires cmd+1..9 / cmd+t /
  // alt+d / cmd+W underneath the modal — which mutates the
  // workspace while the user is in a "transient draft" UI that
  // promises Escape-cancellation. Mirror the placement bailout:
  // consume Escape, swallow shortcut chords, drop everything else.
  const reorderTabsOpen = useAppStore(state => state.reorderTabsOpen)
  const closeReorderTabs = useAppStore(state => state.closeReorderTabs)
  const pinAgentsOpen = useAppStore(state => state.pinAgentsOpen)
  const closePinAgents = useAppStore(state => state.closePinAgents)

  // Built once per override change, not per keystroke. Resolving inside the
  // handler meant rebuilding the default table and re-normalizing ~30 strings
  // on every keydown, including ordinary typing.
  const bindingIndex = useMemo(
    () => buildBindingIndex(commandKeybindingOverrides),
    [commandKeybindingOverrides],
  )

  useEffect(() => {
    let pendingTiledResizeIndex: number | null = null
    let pendingDispatchDigit: number | null = null
    let pendingDispatchDigitTimer: number | null = null

    const clearPendingDispatchDigit = () => {
      pendingDispatchDigit = null
      if (pendingDispatchDigitTimer !== null) {
        window.clearTimeout(pendingDispatchDigitTimer)
        pendingDispatchDigitTimer = null
      }
    }

    const rememberDispatchDigit = (digit: number) => {
      pendingDispatchDigit = digit
      if (pendingDispatchDigitTimer !== null) {
        window.clearTimeout(pendingDispatchDigitTimer)
      }
      pendingDispatchDigitTimer = window.setTimeout(() => {
        pendingDispatchDigit = null
        pendingDispatchDigitTimer = null
      }, 650)
    }

    const handler = (e: KeyboardEvent) => {
      const cmd = e.metaKey
      const alt = e.altKey
      const shift = e.shiftKey
      const k = e.key

      // App-owned dialogs/takeovers get the whole interaction turn. This gate
      // must precede every workspace shortcut because the listener runs in
      // capture phase, before a focused modal control can stop propagation.
      // Do not stop propagation here: the owning surface still needs Escape,
      // Enter, arrows, and normal form input. Only prevent browser/Electron
      // defaults for chords that Agent Code itself claims (Cmd+W is the
      // important one — otherwise macOS closes the window after we return).
      if (hasAppInteractionOwner()) {
        // ONE exemption: the chord that owns the surface currently holding the
        // interaction. Pressing ⌘⇧U while Usage is up is unambiguously "dismiss
        // Usage" — it cannot be a stray shortcut leaking into a modal, because
        // the modal is the thing this command controls.
        //
        // Without this, every toggle written in a command body is unreachable
        // by keyboard: the second press never gets past this gate, so the
        // command's `run` is never called. That is why ⌥R Reader and ⌥S
        // Spotlight round-trip today while ⌘⇧U does not — the former render
        // inline and stamp no owner marker, the latter is a Radix dialog. The
        // difference was never in the commands.
        //
        // Context is deliberately 'global' only. A surface owns the screen, so
        // a grid- or dispatch-scoped binding has no business firing underneath
        // it; only an app-wide chord can mean "dismiss the thing in front of
        // me".
        const dismissCommandId = routedCommandForEvent(e, bindingIndex, GLOBAL_CONTEXT_ONLY)
        if (dismissCommandId && commandOwnsOpenSurface(dismissCommandId, useAppStore.getState())) {
          e.preventDefault()
          requestCommandInvocation(dismissCommandId, 'keybinding')
          return
        }
        if (shouldPreventOwnedApplicationShortcut(e)) e.preventDefault()
        return
      }
      // Unified placement-overlay predicate — matches App.tsx's
      // `placementOverlayOpen` so create, attach, and linked-agent
      // modes share one keyboard bailout.
      const placementOverlayOpen =
        newAgentPlacementOpen || dispatchAttachIntent !== null || linkedAgentParentId !== null

      // Placement overlay (create-new, attach-detached, or linked
      // agent) and the two draft modals (reorder / pin) all share
      // the same shape:
      // a transient UI with its own onKeyDown that owns Enter /
      // Space / Arrow / j / k, plus Escape-to-cancel. Three things
      // we must do here in the global capture handler:
      //   1. Consume Escape so it closes the modal even when the
      //      modal's inner div has lost focus.
      //   2. preventDefault on shortcut chords (cmd / alt). Without
      //      this, returning early stops Agent Code's handler but
      //      not the macOS / Electron defaults — cmd+W would still
      //      close the window, cmd+T would still open a new tab in
      //      Electron, alt+number cycles tab focus on some setups.
      //      preventDefault on chords blocks those defaults while
      //      still letting the event bubble to the modal's React
      //      onKeyDown for navigation keys.
      //   3. Drop unmodified keys (j/k/Space/Enter/etc) — the
      //      modal's own onKeyDown handles those via React bubble.
      if (placementOverlayOpen || reorderTabsOpen || pinAgentsOpen) {
        if (k === 'Escape') {
          e.preventDefault()
          if (newAgentPlacementOpen) closeNewAgentPlacement()
          if (dispatchAttachIntent !== null) closeDispatchAttach()
          if (linkedAgentParentId !== null) closeLinkedAgent()
          if (reorderTabsOpen) closeReorderTabs()
          if (pinAgentsOpen) closePinAgents()
          return
        }
        if (cmd || alt) {
          e.preventDefault()
        }
        return
      }

      const eventElement = e.target instanceof Element ? e.target : null
      const editorOwnsTarget = Boolean(eventElement?.closest('[data-global-editor-input-owner]'))
      if (editorOwnsTarget) {
        const monacoOwnsTarget = Boolean(eventElement?.closest('[data-global-editor-monaco]'))
        // On macOS Option is a text-composition modifier (⌥D → ∂, etc.). Every
        // unclaimed Option chord must remain in the editor surface; falling
        // through can split/close/navigate the hidden workspace while the user
        // is simply typing into Monaco.
        if (alt && !cmd) return
        const plainEditorCommand = cmd && !shift && !alt && ['s', 'w', '[', ']'].includes(k)
        if (plainEditorCommand) {
          // Monaco and EditorWorkbench handle save/close in bubble phase. The
          // remaining chords have no useful native meaning in editor chrome;
          // suppress browser history/navigation there while still allowing
          // Monaco's own keybinding service to consume them.
          if (!monacoOwnsTarget && (k === '[' || k === ']')) {
            e.preventDefault()
          }
          return
        }
      }
      const fullscreenEditorOwnsWorkspace =
        useAppStore.getState().globalEditorOpen && useGlobalEditorStore.getState().editorFullscreen
      const hiddenWorkspaceShortcut =
        (cmd && !alt && e.code === 'KeyW') ||
        (alt && !cmd && shouldPreventOwnedApplicationShortcut(e))
      if (
        fullscreenEditorOwnsWorkspace &&
        !editorOwnsTarget &&
        hiddenWorkspaceShortcut
      ) {
        // Fullscreen deliberately hides the workspace, but the workspace's
        // global capture router remains mounted. Swallow its destructive pane
        // grammar when focus sits in app chrome outside the workbench. This
        // MUST use the same finite allow-list as the router: blanket-swallowing
        // Alt also captures OS chords such as Alt+F4/Alt+Tab on Windows/Linux,
        // even though Agent Code has no action to protect for those keys.
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // --- Copy Assistant picker (Up/Down/Enter/Esc) ---
      //
      // Active when the focused pane's runtime has assistantPicker set.
      // Capture all four keys here so the focused composer doesn't
      // receive them. Picker dismisses on Enter (after copy) and Esc
      // (without copy); arrow keys move the selection. Lives BEFORE
      // the Spotlight Esc handler so picker-Esc wins when both modes
      // are active (shouldn't happen — picker is feed-only — but the
      // ordering keeps the intent local).
      const focusedSessionId = commandTargetSessionId(workspace)
      const renderedPickerSurfaceVisible = focusedSessionId
        ? renderedAgentSurfaceIsVisible(workspace, agentViewMode, focusedSessionId) &&
          !workspace.spotlight &&
          workspace.readerMode === null &&
          !settingsPageOpen
        : false
      const picker = focusedSessionId ? workspace.runtimes[focusedSessionId]?.assistantPicker : null
      if (picker && focusedSessionId && renderedPickerSurfaceVisible) {
        if (k === 'ArrowUp') {
          e.preventDefault()
          workspace.pickerMove(focusedSessionId, -1)
          return
        }
        if (k === 'ArrowDown') {
          e.preventDefault()
          workspace.pickerMove(focusedSessionId, +1)
          return
        }
        if (k === 'Enter') {
          e.preventDefault()
          void workspace.pickerConfirm(focusedSessionId)
          return
        }
        if (k === 'Escape') {
          e.preventDefault()
          workspace.pickerCancel(focusedSessionId)
          return
        }
        // Other keys fall through — typing into the composer doesn't
        // cancel the picker. If we want "any keystroke cancels",
        // that's a one-line follow-up.
      }

      // --- Copy Code Block picker (Up/Down/Enter/Esc) ---
      //
      // Parallel to the Copy Assistant picker above, but the ordered
      // list of selectable items is enumerated from the DOM, not the
      // transcript: code blocks have no transcript identity, so
      // `enumerateCodeBlockIds` reads `[data-code-block-id]` nodes
      // within the focused pane in document order. The store only
      // parks the current `selectedId`. Only one picker is ever
      // active at a time (each command toggles its own), so this
      // block and the assistant block can't both fire.
      const cbPicker = focusedSessionId
        ? workspace.runtimes[focusedSessionId]?.codeBlockPicker
        : null
      if (cbPicker && focusedSessionId && renderedPickerSurfaceVisible) {
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          e.preventDefault()
          const ids = enumerateCodeBlockIds(focusedSessionId)
          if (ids.length === 0) {
            // Every block unmounted under the picker — close it
            // rather than leave a selection pointing at nothing.
            workspace.setCodeBlockPicker(focusedSessionId, null)
            return
          }
          const cur = ids.indexOf(cbPicker.selectedId)
          // Down = toward newer (document order runs oldest→newest,
          // so the last id is the most recent block). If the selected
          // block vanished mid-pick, snap to the newest available —
          // same recovery the assistant picker does for a stale uuid.
          const dir = k === 'ArrowDown' ? 1 : -1
          const nextIdx =
            cur === -1 ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, cur + dir))
          workspace.setCodeBlockPicker(focusedSessionId, {
            selectedId: ids[nextIdx],
          })
          return
        }
        if (k === 'Enter') {
          e.preventDefault()
          const code = getCodeBlockCode(cbPicker.selectedId)
          // Clear the picker first so the UI returns to normal even
          // if the clipboard write rejects (mirrors pickerConfirm).
          workspace.setCodeBlockPicker(focusedSessionId, null)
          if (code == null) {
            workspace.showPaneToast(focusedSessionId, 'Nothing to copy')
          } else {
            void navigator.clipboard.writeText(code).then(
              () => workspace.showPaneToast(focusedSessionId, 'Copied code block'),
              () => workspace.showPaneToast(focusedSessionId, 'Clipboard write failed'),
            )
          }
          return
        }
        if (k === 'Escape') {
          e.preventDefault()
          workspace.setCodeBlockPicker(focusedSessionId, null)
          return
        }
        // Other keys fall through, same as the assistant picker.
      }

      if (k === 'Escape' && workspace.spotlight && !fullscreenEditorOwnsWorkspace) {
        e.preventDefault()
        workspace.toggleSpotlight()
        return
      }

      // Esc also exits Reader Mode. Same one-key dismiss pattern as
      // Spotlight — both are read-only "fullscreen" overlays the user
      // expects to bail out of with Escape.
      if (k === 'Escape' && workspace.readerMode && !fullscreenEditorOwnsWorkspace) {
        e.preventDefault()
        workspace.toggleReaderMode()
        return
      }

      if (k === 'Escape' && settingsPageOpen) {
        e.preventDefault()
        closeSettingsPage()
        return
      }

      if (k === 'Escape' && buryPromptSessionId) {
        e.preventDefault()
        closeBuryPrompt()
        return
      }

      // Reader and Spotlight are inline full-screen takeovers rather than
      // Radix dialogs, so they deliberately do not stamp the DOM interaction-
      // owner marker handled at the top of this router. Their workspace state
      // remains live underneath them, though, and that makes the ordinary
      // grid/Dispatch contexts a lie while either takeover is visible: the
      // user cannot see the pane or row those shortcuts would mutate.
      //
      // WHY this gate lives before BOTH configured commands and the legacy
      // Dispatch grammar: Reader's Option+Arrow listener calls
      // preventDefault(), but another capture listener on the same document
      // still runs. Checking defaultPrevented or stopping propagation would
      // make correctness depend on React effect/listener registration order.
      // This router instead declines ownership structurally, while leaving the
      // event propagating so Reader's own older/newer handler can consume it.
      //
      // The one admitted command is the toggle that owns the visible takeover.
      // That preserves the second-press dismissal contract without reopening
      // arbitrary global shortcuts against the hidden workspace. Escape is
      // handled immediately above for the same reason.
      const focusModeOwnerCommandId = workspace.readerMode
        ? 'toggle-reader-mode'
        : workspace.spotlight
          ? 'toggle-spotlight'
          : null
      if (focusModeOwnerCommandId) {
        const focusModeCommandId = routedCommandForEvent(
          e,
          bindingIndex,
          GLOBAL_CONTEXT_ONLY,
        )
        if (focusModeCommandId === focusModeOwnerCommandId) {
          e.preventDefault()
          requestCommandInvocation(focusModeCommandId, 'keybinding')
          return
        }
        if (shouldPreventOwnedApplicationShortcut(e)) e.preventDefault()
        return
      }

      // --- Configured command bindings ---
      //
      // POSITION IS THE FIX. This used to sit near the top of the handler,
      // above the editor-ownership guard and above every legacy chord branch,
      // which produced three regressions at once: ⌘W inside Monaco killed the
      // agent pane behind the editor, bare End in a composer scrolled the feed
      // instead of moving the caret, and ⌘[ / ⌘] stole Monaco's indent.
      //
      // Everything that OWNS an interaction now runs first — app modals,
      // placement overlays, editor chrome, the assistant/code-block pickers,
      // and Escape. Only then do configured bindings get a look.
      //
      // What remains BELOW is contextual interaction that is deliberately not a
      // command: numbered tab/Dispatch selection, the tiled-resize
      // continuation, Dispatch row/lane movement, and split resizing. Those are
      // reached because the context filter refuses to match a grid-context
      // binding while Dispatch owns the layout, so ⌥J falls through to the
      // Dispatch handler instead of being swallowed and refused.
      const activeContexts = activeBindingContexts({
        dispatchMode: Boolean(workspace.dispatchMode),
        editorOwnsTarget,
        // 'feed' is live only when a rendered feed is focused AND the user is
        // not typing — which is what keeps bare End as a caret key in every
        // composer while still jumping the feed elsewhere.
        feedFocused: Boolean(
          focusedSessionId
          && renderedAgentSurfaceIsVisible(workspace, agentViewMode, focusedSessionId)
          && !isTextEditingTarget(e.target),
        ),
      })
      const routedCommandId = routedCommandForEvent(e, bindingIndex, activeContexts)
      if (routedCommandId) {
        e.preventDefault()
        requestCommandInvocation(routedCommandId, 'keybinding')
        return
      }

      // --- CMD: tab management ---
      if (cmd && alt && !shift) {
        const digit = digitFromKeyboardEvent(e)
        if (digit !== null) {
          e.preventDefault()
          workspace.activateTabByIndex(digit - 1)
          return
        }
      }

      // --- CMD: tab management ---
      if (cmd && !alt) {
        if (workspace.tileTabs && pendingTiledResizeIndex !== null) {
          if (k === 'ArrowLeft') {
            e.preventDefault()
            workspace.resizeTiledTabByIndex(pendingTiledResizeIndex, -0.03)
            return
          }
          if (k === 'ArrowRight') {
            e.preventDefault()
            workspace.resizeTiledTabByIndex(pendingTiledResizeIndex, 0.03)
            return
          }
          if (workspace.tileTabs.direction === 'horizontal') {
            if (k === 'ArrowUp') {
              e.preventDefault()
              workspace.resizeTiledTabByIndex(pendingTiledResizeIndex, -0.03)
              return
            }
            if (k === 'ArrowDown') {
              e.preventDefault()
              workspace.resizeTiledTabByIndex(pendingTiledResizeIndex, 0.03)
              return
            }
          }
        }
        // In Dispatch Mode, the numbered command grammar moves from
        // "tab N" to "session row N" because the left list is the primary
        // control surface. Tab switching remains available via cmd-[ / ].
        // The row labels keep their tab letter (A/B/C) for orientation,
        // but the numeric suffix is global in the visible dispatch list.
        if (workspace.dispatchMode) {
          const digit = digitFromKeyboardEvent(e, {
            includeZero: pendingDispatchDigit !== null,
          })
          if (digit !== null) {
            e.preventDefault()
            if (!e.repeat) {
              // In a tiled layout cmd-N fills the FOCUSED LANE; in classic
              // Dispatch it moves the single dispatch focus. Same row index
              // semantics (buildVisibleDispatchRows) either way.
              const selectRow = workspace.dispatchMode?.tiled
                ? (index: number) => focusTiledRowByIndex(workspace, index)
                : (index: number) => focusDispatchRowByIndex(workspace, index)
              const combined =
                pendingDispatchDigit !== null ? pendingDispatchDigit * 10 + digit : null
              if (combined !== null && combined >= 10 && combined <= 99) {
                selectRow(combined - 1)
                clearPendingDispatchDigit()
              } else if (digit > 0) {
                selectRow(digit - 1)
                rememberDispatchDigit(digit)
              }
            }
            return
          }
        }
        // cmd-1..9 → tab index
        const digit = digitFromKeyboardEvent(e)
        if (digit !== null) {
          e.preventDefault()
          if (workspace.tileTabs) {
            pendingTiledResizeIndex = digit - 1
            workspace.focusTiledTabByIndex(digit - 1)
          } else {
            workspace.activateTabByIndex(digit - 1)
          }
          return
        }
      }

      // --- ALT: pane management ---
      //
      // Important: on macOS, alt+letter produces Unicode symbols
      // (alt+d → ∂, alt+h → ˙, alt+l → ¬). That means e.key is the
      // produced symbol, NOT the letter. Use e.code ("KeyD", "KeyH",
      // …) for reliable detection of alt combos. Arrow keys and
      // punctuation still use e.key because their codes are verbose
      // and the key values ARE what we want.
      if (alt && !cmd) {
        const code = e.code

        if (workspace.dispatchMode) {
          // WHY Dispatch steals these before normal pane navigation:
          // Dispatch focus is `dispatchMode.focusedSessionId`, while grid
          // navigation below walks `activeTab.focusedSessionId` through
          // `tab.root`. Those are deliberately different invariants. Once a
          // Dispatch row points at a detached session, falling through to
          // `workspace.navigate()` asks the grid to find a neighbor for a
          // session that is not in the grid and silently does nothing. The
          // command-palette side of this fix hides `Focus Pane *` in Dispatch;
          // the keybind side must also stop grid navigation from running
          // underneath Dispatch.
          //
          // Dispatch is a vertical list, so only up/down and vim k/j have
          // movement semantics. Left/right/h/l are consumed because letting
          // them fall through would mutate or probe the hidden grid and make
          // keyboard behavior depend on stale grid focus instead of the row
          // the user actually sees highlighted.
          // In a tiled layout the same up/down keys move the FOCUSED LANE's
          // selection, and left/right — which are swallowed in classic
          // Dispatch (a vertical list) — gain meaning: they switch which
          // lane has keyboard focus. Switching lanes never changes any
          // lane's selection, keeping lanes independent.
          const tiled = workspace.dispatchMode?.tiled
          if (k === 'ArrowUp' || code === 'KeyK') {
            e.preventDefault()
            if (tiled) moveTiledLaneSelection(workspace, -1)
            else moveDispatchSelection(workspace, -1)
            return
          }
          if (k === 'ArrowDown' || code === 'KeyJ') {
            e.preventDefault()
            if (tiled) moveTiledLaneSelection(workspace, 1)
            else moveDispatchSelection(workspace, 1)
            return
          }
          if (k === 'ArrowLeft' || code === 'KeyH') {
            e.preventDefault()
            if (tiled) workspace.setTiledFocusedLane(tiled.focusedLane - 1)
            return
          }
          if (k === 'ArrowRight' || code === 'KeyL') {
            e.preventDefault()
            if (tiled) workspace.setTiledFocusedLane(tiled.focusedLane + 1)
            return
          }
        }

        // --- Directional resize: fn+alt+arrow ---
        //
        // On macOS, holding Fn while pressing an arrow is translated by
        // the OS to Home/End/PageUp/PageDown BEFORE the event reaches
        // the app — so what the user types as "fn+option+←" arrives
        // here as altKey=true, e.key==='Home'. We never see the Fn
        // modifier directly (it isn't exposed to the browser), and we
        // don't need to: the translated key is unambiguous.
        //
        // Must come BEFORE plain alt+arrow navigation so the two
        // handlers don't collide (they're disjoint by key name, but
        // keeping the directional block first matches how the old
        // shift-gated version was ordered and makes the precedence
        // obvious).
        //
        // Why not alt+shift+arrow like before: Option+Shift+Arrow is
        // the macOS system shortcut for word-by-word text selection.
        // Stealing it broke selection inside the composer and any
        // other text field. Fn+Option+Arrow has no system meaning so
        // we can claim it cleanly.
        //
        // Semantics unchanged: the arrow moves the divider of the
        // nearest matching split. Whether the focused pane grows or
        // shrinks is determined by which side of the divider it's on.
        //
        // 0.02 delta per press gives about 45 keystrokes across the
        // clamp range, which is fine-grained enough to land on exact
        // 50/50 or 25/75 ratios without overshooting. Hold the key
        // for coarse moves.
        if (k === 'Home') {
          e.preventDefault()
          workspace.resizeFocusedDirectional('left', 0.02)
          return
        }
        if (k === 'End') {
          e.preventDefault()
          workspace.resizeFocusedDirectional('right', 0.02)
          return
        }
        if (k === 'PageUp') {
          e.preventDefault()
          workspace.resizeFocusedDirectional('up', 0.02)
          return
        }
        if (k === 'PageDown') {
          e.preventDefault()
          workspace.resizeFocusedDirectional('down', 0.02)
          return
        }

        // Vim navigation (e.code) + arrow keys (e.key)
        // Resize — use physical codes for punctuation too
        if (code === 'Equal' || k === '=' || k === '+') {
          e.preventDefault()
          workspace.resizeFocused(+0.05)
          return
        }
        if (code === 'Minus' || k === '-' || k === '_') {
          e.preventDefault()
          workspace.resizeFocused(-0.05)
          return
        }
      }

    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        pendingTiledResizeIndex = null
        clearPendingDispatchDigit()
      }
    }

    const onBlur = () => {
      pendingTiledResizeIndex = null
      clearPendingDispatchDigit()
    }

    // capture: true — run BEFORE focused input sees the key. Without
    // this, the input would consume keys like 'd', 'h', etc. before
    // our handler fires.
    document.addEventListener('keydown', handler, { capture: true })
    document.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      clearPendingDispatchDigit()
      document.removeEventListener('keydown', handler, { capture: true })
      document.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  }, [
    agentViewMode,
    closeSettingsPage,
    closeBuryPrompt,
    closeNewAgentPlacement,
    closeDispatchAttach,
    closeLinkedAgent,
    closeReorderTabs,
    closePinAgents,
    buryPromptSessionId,
    dispatchAttachIntent,
    linkedAgentParentId,
    newAgentPlacementOpen,
    pinAgentsOpen,
    reorderTabsOpen,
    settingsPageOpen,
    workspace,
  ])
}

function digitFromKeyboardEvent(
  e: KeyboardEvent,
  options: { includeZero?: boolean } = {},
): number | null {
  if (options.includeZero && e.code === 'Digit0') return 0
  if (/^Digit[1-9]$/.test(e.code)) {
    return Number(e.code.slice('Digit'.length))
  }
  if (options.includeZero && e.key === '0') return 0
  const digit = parseInt(e.key, 10)
  return !Number.isNaN(digit) && digit >= 1 && digit <= 9 ? digit : null
}

function dispatchRows(workspace: Workspace) {
  // WHY use the visible-row helper instead of flattening groups here:
  // keyboard selection is the user's row-number contract. Once Dispatch rows
  // include pinned agents and terminal sessions, "cmd-3" must resolve against
  // the exact same list the user sees, not a convenient subset of project
  // groups. The helper keeps this in lockstep with DispatchLayout and command
  // targeting.
  return buildVisibleDispatchRows(workspace.state)
}

function focusDispatchRowByIndex(workspace: Workspace, index: number) {
  const row = dispatchRows(workspace)[index]
  if (!row) return
  workspace.focusDispatchSession(row.tabId, row.sessionId)
}

// ---- Tiled Dispatch keybind helpers (issue #248) ----
//
// When a tiled layout is active, dispatch selection targets the FOCUSED
// LANE rather than the single dispatch focus. These mirror the classic
// helpers above but write through setTiledLaneSession, so cmd-N / arrows
// fill the focused lane (duplicates across lanes are allowed).

function focusedTiledLane(workspace: Workspace): number {
  return workspace.dispatchMode?.tiled?.focusedLane ?? 0
}

function focusTiledRowByIndex(workspace: Workspace, index: number) {
  const row = dispatchRows(workspace)[index]
  if (!row) return
  // cmd-N fills the focused lane with row N. Duplicates are allowed, so this
  // works even if that agent is already shown in another lane.
  workspace.setTiledLaneSession(focusedTiledLane(workspace), row.sessionId)
}

function moveTiledLaneSelection(workspace: Workspace, delta: number) {
  const tiled = workspace.dispatchMode?.tiled
  if (!tiled) return
  const rows = dispatchRows(workspace)
  if (rows.length === 0) return
  const laneIndex = tiled.focusedLane
  const currentId = tiled.lanes[laneIndex]?.selectedSessionId
  const currentIndex = currentId ? rows.findIndex(row => row.sessionId === currentId) : -1
  // Step one row in `delta` direction, wrapping. Duplicates are allowed, so
  // we do NOT skip rows shown in other lanes — landing on one just mirrors
  // that agent into this lane too.
  const probe = nextTiledRowIndex(currentIndex, delta, rows.length)
  const row = rows[probe]
  if (row) workspace.setTiledLaneSession(laneIndex, row.sessionId)
}

function moveDispatchSelection(workspace: Workspace, delta: number) {
  const rows = dispatchRows(workspace)
  if (rows.length === 0) return
  // Resolve the current row through the same row-derived selector that the
  // visible UI uses. Reading raw dispatchMode.focusedSessionId here (the
  // previous shape) yields ids that aren't always in the visible list:
  // stale persisted focus right after rehydrate, scope toggles, or the
  // tiny gap right after a close. findIndex would then return -1 and the
  // wrap-around math `(currentIndex + delta + len) % len` produces a
  // deterministic-but-confusing jump — Down lands on row 0, Up lands on
  // the second-to-last row — neither matches the row the user sees
  // highlighted. selectVisibleDispatchRow always returns a row when the
  // list is non-empty (rows[0] fallback), so currentIndex is always in
  // range and the visible cursor is the cursor we move from.
  const currentRow = selectVisibleDispatchRow(
    rows,
    workspace.dispatchMode?.focusedSessionId,
    workspace.activeTab?.focusedSessionId,
  )
  const currentIndex = currentRow
    ? rows.findIndex(row => row.sessionId === currentRow.sessionId)
    : 0
  const nextIndex = (currentIndex + delta + rows.length) % rows.length
  const row = rows[nextIndex]
  if (!row) return
  workspace.focusDispatchSession(row.tabId, row.sessionId)
}
