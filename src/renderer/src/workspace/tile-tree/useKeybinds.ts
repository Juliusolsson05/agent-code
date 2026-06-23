import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { getEffectiveAgentSurface, isAgentKind } from '@renderer/workspace/agentDisplayMode'
import {
  buildVisibleDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { enumerateCodeBlockIds } from '@renderer/features/copy-code-block/lib/enumerateCodeBlocks'
import { getCodeBlockCode } from '@renderer/features/copy-code-block/lib/codeBlockRegistry'

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

type NewTabRequester = () => Promise<void> | void
type ResumeRequester = (defaultCwd: string) => Promise<void> | void
type CommandPaletteToggle = () => void

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

function renderedAgentSurfaceIsVisible(workspace: Workspace, agentViewMode: string, sessionId: string): boolean {
  const kind = workspace.state.sessions[sessionId]?.kind
  if (!isAgentKind(kind)) return false
  return getEffectiveAgentSurface({
    kind,
    mode: agentViewMode === 'terminal' || agentViewMode === 'hybrid' ? agentViewMode : 'agent',
    runtime: workspace.getRuntime(sessionId),
  }) === 'rendered'
}

export function useKeybinds(
  workspace: Workspace,
  onNewTabRequest: NewTabRequester,
  onResumeRequest: ResumeRequester,
  onCommandPalette?: CommandPaletteToggle,
): void {
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const buryPromptSessionId = useAppStore(state => state.buryPromptSessionId)
  const closeBuryPrompt = useAppStore(state => state.closeBuryPrompt)
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const toggleGlobalEditor = useAppStore(state => state.toggleGlobalEditor)
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
      // Unified placement-overlay predicate — matches App.tsx's
      // `placementOverlayOpen` so create, attach, and linked-agent
      // modes share one keyboard bailout.
      const placementOverlayOpen =
        newAgentPlacementOpen ||
        dispatchAttachIntent !== null ||
        linkedAgentParentId !== null

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

      // --- CMD: command palette ---
      if (cmd && shift && k.toLowerCase() === 'p' && !alt) {
        e.preventDefault()
        onCommandPalette?.()
        return
      }

      // --- Cmd+Shift+E: Global Editor toggle ---
      //
      // WHY this specific chord: ⌘E is taken by tile-resize, ⌘⇧E was
      // unused, and it mirrors VS Code's "Explorer" muscle memory for
      // users coming from an IDE. The toggle is global — no `when`
      // guard, no mode dependence — because Global Editor is
      // orthogonal to dispatch / tile / spotlight (it WRAPS them
      // rather than replacing them).
      if (cmd && shift && k.toLowerCase() === 'e' && !alt) {
        e.preventDefault()
        toggleGlobalEditor()
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
          !workspace.reader &&
          !settingsPageOpen
        : false
      const picker = focusedSessionId
        ? workspace.runtimes[focusedSessionId]?.assistantPicker
        : null
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
            cur === -1
              ? ids.length - 1
              : Math.max(0, Math.min(ids.length - 1, cur + dir))
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

      if (k === 'Escape' && workspace.spotlight) {
        e.preventDefault()
        workspace.toggleSpotlight()
        return
      }

      // Esc also exits Reader Mode. Same one-key dismiss pattern as
      // Spotlight — both are read-only "fullscreen" overlays the user
      // expects to bail out of with Escape.
      if (k === 'Escape' && workspace.readerMode) {
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

      // --- CMD: undo close (⌘⇧T) ---
      // Same shortcut as Chrome's "reopen closed tab". Pops the most
      // recent entry from the undo-close stack and restores it — either
      // re-splitting a pane in place or re-inserting a whole tab.
      if (cmd && shift && k.toLowerCase() === 't' && !alt) {
        e.preventDefault()
        void workspace.undoClose()
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
        if (k === 't' && !shift) {
          e.preventDefault()
          void onNewTabRequest()
          return
        }
        // Resume: ⌘⇧R opens the path modal pre-filled with the
        // focused tab's cwd. Same modal as ⌘T but biased toward
        // picking an existing session in the same directory the user
        // is already in — which is the common "continue where I left
        // off" flow.
        if (k.toLowerCase() === 'r' && shift) {
          e.preventDefault()
          const tab = workspace.activeTab
          const targetSessionId = commandTargetSessionId(workspace)
          if (tab && targetSessionId) {
            const cwd = workspace.state.sessions[targetSessionId]?.cwd
            void onResumeRequest(cwd ?? '')
          } else {
            void onResumeRequest('')
          }
          return
        }
        if (k.toLowerCase() === 'w' && shift) {
          e.preventDefault()
          if (workspace.activeTab) void workspace.closeTab(workspace.activeTab.id)
          return
        }
        if (k.toLowerCase() === 'w' && !shift) {
          e.preventDefault()
          void workspace.closeFocused()
          return
        }
        if (k === '[') {
          e.preventDefault()
          workspace.prevTab()
          return
        }
        if (k === ']') {
          e.preventDefault()
          workspace.nextTab()
          return
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
                pendingDispatchDigit !== null
                  ? pendingDispatchDigit * 10 + digit
                  : null
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

        if (code === 'KeyD' && !shift) {
          e.preventDefault()
          void workspace.splitFocused('vertical')
          return
        }
        if (code === 'KeyD' && shift) {
          e.preventDefault()
          void workspace.splitFocused('horizontal')
          return
        }
        // --- Terminal split: alt-t / alt-shift-t ---
        //
        // Keep the same grammar as the generic split bindings above:
        // no shift = vertical/right, shift = horizontal/down.
        //
        // The 't' detection uses e.code === 'KeyT' (not e.key)
        // because on macOS alt+t produces the Unicode dagger '†',
        // and holding shift produces 'Ê'. Both are invisible to
        // key-string matching but show up fine as KeyT via the
        // physical-key code. See the note on alt-h/j/k/l above.
        if (code === 'KeyT' && !shift) {
          e.preventDefault()
          void workspace.splitFocused('vertical', 'terminal')
          return
        }
        if (code === 'KeyT' && shift) {
          e.preventDefault()
          void workspace.splitFocused('horizontal', 'terminal')
          return
        }
        // --- Codex split: alt-c / alt-shift-c ---
        //
        // Same grammar as the generic split bindings above:
        // no shift = vertical/right, shift = horizontal/down.
        // Uses e.code === 'KeyC' for the same macOS alt-letter reason
        // as the others.
        if (code === 'KeyC' && !shift) {
          e.preventDefault()
          void workspace.splitFocused('vertical', 'codex')
          return
        }
        if (code === 'KeyC' && shift) {
          e.preventDefault()
          void workspace.splitFocused('horizontal', 'codex')
          return
        }
        if (code === 'KeyW') {
          e.preventDefault()
          void workspace.closeFocused()
          return
        }
        // Vim navigation (e.code) + arrow keys (e.key)
        if (code === 'KeyH' || k === 'ArrowLeft') {
          e.preventDefault()
          workspace.navigate('left')
          return
        }
        if (code === 'KeyL' || k === 'ArrowRight') {
          e.preventDefault()
          workspace.navigate('right')
          return
        }
        if (code === 'KeyK' || k === 'ArrowUp') {
          e.preventDefault()
          workspace.navigate('up')
          return
        }
        if (code === 'KeyJ' || k === 'ArrowDown') {
          e.preventDefault()
          workspace.navigate('down')
          return
        }
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

      if (!cmd && !alt && !shift && k === 'End' && !isTextEditingTarget(e.target)) {
        const sessionId = commandTargetSessionId(workspace)
        if (!sessionId || !renderedAgentSurfaceIsVisible(workspace, agentViewMode, sessionId)) {
          return
        }
        e.preventDefault()
        workspace.scrollFocusedToLatest()
        return
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
    onCommandPalette,
    onNewTabRequest,
    onResumeRequest,
    buryPromptSessionId,
    dispatchAttachIntent,
    linkedAgentParentId,
    newAgentPlacementOpen,
    pinAgentsOpen,
    reorderTabsOpen,
    settingsPageOpen,
    toggleGlobalEditor,
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
  const currentIndex = currentId
    ? rows.findIndex(row => row.sessionId === currentId)
    : -1
  // Step one row in `delta` direction, wrapping. Duplicates are allowed, so
  // we do NOT skip rows shown in other lanes — landing on one just mirrors
  // that agent into this lane too.
  const len = rows.length
  const probe = (((currentIndex + delta) % len) + len) % len
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
