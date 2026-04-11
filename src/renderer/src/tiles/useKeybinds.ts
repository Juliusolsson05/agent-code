import { useEffect } from 'react'

import type { Workspace } from './workspaceStore'

// Keybinds: global window-level listeners. The handler is attached to
// `document` in a single useEffect, which captures the key BEFORE the
// focused input element sees it (via `capture: true`). That's necessary
// because all the keybinds fire while an input is focused — without
// capture, the input would swallow them.
//
// Keybind scheme (user-approved in brainstorming, section 4):
//   cmd-t           new tab (prompts for cwd)
//   cmd-w           close focused pane (collapses tree; closes tab if last)
//   cmd-shift-w     close active tab outright
//   cmd-1..9        activate Nth tab
//   cmd-[           previous tab
//   cmd-]           next tab
//   alt-d           split current pane vertically (new pane to the right)
//   alt-shift-d     split current pane horizontally (new pane below)
//   alt-h/j/k/l     navigate panes (vim: left/down/up/right)
//   alt-ArrowLeft/Right/Up/Down  same, for non-vim users
//   alt-w           close focused pane (same as cmd-w but alt-keyed)
//   alt-=           grow focused split
//   alt--           shrink focused split

type NewTabRequester = () => Promise<void> | void

export function useKeybinds(
  workspace: Workspace,
  onNewTabRequest: NewTabRequester,
): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmd = e.metaKey
      const alt = e.altKey
      const shift = e.shiftKey
      const k = e.key

      // --- CMD: tab management ---
      if (cmd && !alt) {
        if (k === 't' && !shift) {
          e.preventDefault()
          void onNewTabRequest()
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
        // cmd-1..9 → tab index
        const digit = parseInt(k, 10)
        if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
          e.preventDefault()
          workspace.activateTabByIndex(digit - 1)
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
    }

    // capture: true — run BEFORE focused input sees the key. Without
    // this, the input would consume keys like 'd', 'h', etc. before
    // our handler fires.
    document.addEventListener('keydown', handler, { capture: true })
    return () => {
      document.removeEventListener('keydown', handler, { capture: true })
    }
  }, [workspace, onNewTabRequest])
}
