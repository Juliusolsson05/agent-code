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
//   cmd-shift-r     resume: open the path modal with the focused tab's
//                   cwd pre-filled, so the resume list for that cwd is
//                   visible instantly. Same modal as cmd-t — one path
//                   to both flows — just with a different default
//                   value and intent.
//   cmd-w           close focused pane (collapses tree; closes tab if last)
//   cmd-shift-w     close active tab outright
//   cmd-1..9        activate Nth tab
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

export function useKeybinds(
  workspace: Workspace,
  onNewTabRequest: NewTabRequester,
  onResumeRequest: ResumeRequester,
  onCommandPalette?: CommandPaletteToggle,
): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmd = e.metaKey
      const alt = e.altKey
      const shift = e.shiftKey
      const k = e.key

      // --- CMD: command palette ---
      if (cmd && shift && k.toLowerCase() === 'p' && !alt) {
        e.preventDefault()
        onCommandPalette?.()
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
      if (cmd && !alt) {
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
          if (tab) {
            const cwd = workspace.state.sessions[tab.focusedSessionId]?.cwd
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
        // Alt+T        → horizontal split (new row BELOW) with a
        //                plain shell terminal. "Row below" is the
        //                natural default because terminals are
        //                usually scanned at the bottom of the
        //                screen, not in a side column.
        // Alt+Shift+T  → vertical split (new column RIGHT) with a
        //                plain shell terminal. Same keybind
        //                grammar as alt-d / alt-shift-d but
        //                inverted-default because terminals lean
        //                the other way.
        //
        // The 't' detection uses e.code === 'KeyT' (not e.key)
        // because on macOS alt+t produces the Unicode dagger '†',
        // and holding shift produces 'Ê'. Both are invisible to
        // key-string matching but show up fine as KeyT via the
        // physical-key code. See the note on alt-h/j/k/l above.
        if (code === 'KeyT' && !shift) {
          e.preventDefault()
          void workspace.splitFocused('horizontal', 'terminal')
          return
        }
        if (code === 'KeyT' && shift) {
          e.preventDefault()
          void workspace.splitFocused('vertical', 'terminal')
          return
        }
        // --- Codex split: alt-c / alt-shift-c ---
        //
        // Same grammar as terminal (alt-t): default is horizontal
        // (new row below), shift flips to vertical (new column).
        // Uses e.code === 'KeyC' for the same macOS alt-letter
        // reason as the others.
        if (code === 'KeyC' && !shift) {
          e.preventDefault()
          void workspace.splitFocused('horizontal', 'codex')
          return
        }
        if (code === 'KeyC' && shift) {
          e.preventDefault()
          void workspace.splitFocused('vertical', 'codex')
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
  }, [workspace, onNewTabRequest, onCommandPalette])
}
