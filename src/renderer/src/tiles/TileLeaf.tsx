import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { extractAssistantInProgress } from '../../../shared/parsers/extractAssistant'
import { CodexApprovalModal } from '../../../providers/codex/renderer/CodexApprovalModal'
import { ResumePromptModal } from '../../../providers/claude/renderer/ResumePromptModal'
import { useGlobalToast } from '../GlobalToast'
import { Feed } from '../feed/Feed'
import type { ScrollInfo } from '../feed/Feed'
import { TrustDialogModal } from '../../../providers/claude/renderer/TrustDialogModal'
import { SlashCommandPicker } from '../../../providers/claude/renderer/SlashCommandPicker'
import { extractLatestUserPrompts } from '../features/workspace/lib/latestUserPrompts'
import type { SessionRuntime, Workspace } from './workspaceStore'
import type { SessionId, SessionKind } from './types'
import type { ClaudeDraftImage } from './workspaceState'

// Claude's TUI has its own paste-state machine. Large input and bracketed
// paste do NOT go straight from "bytes arrived" to "submit immediately" —
// Claude first buffers the paste, may collapse it into a `[Pasted text #N]`
// placeholder in the visible composer, and only later expands it back out
// during submit. If we send the paste payload AND the trailing Enter in the
// same PTY write, that Enter can land while Claude still considers the paste
// "in flight". The result is the exact user-facing bug we saw:
//
//   1. the pasted prompt appears in Claude's composer,
//   2. Claude flips into a "working" looking state,
//   3. but no real turn starts,
//   4. and the NEXT Enter finally submits the already-buffered prompt.
//
// We fix this at the shell boundary instead of forking Claude's paste logic:
// for Claude only, any prompt that is likely to be treated as a paste gets
// delivered in TWO phases — first the payload, then (after Claude's own paste
// debounce window has elapsed) the submit key. This keeps us aligned with
// Claude's existing placeholder/expansion model instead of fighting it.
//
// Why these numbers:
//   - 800 chars matches Claude's current PASTE_THRESHOLD upstream.
//   - 125ms is slightly above Claude's 100ms paste completion timeout.
//     Going lower risks reintroducing the race; going much higher makes
//     submit feel laggy on every long paste.
const CLAUDE_PASTE_THRESHOLD = 800
const CLAUDE_PASTE_SUBMIT_DELAY_MS = 125
const CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS = 750
const MAX_CLAUDE_IMAGE_BYTES = 5 * 1024 * 1024
const SUPPORTED_CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const SUPPORTED_CLAUDE_IMAGE_FORMATS_TEXT = 'PNG, JPEG, GIF, WebP'

function isSupportedClaudeImageMediaType(mediaType: string): boolean {
  return SUPPORTED_CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())
}

function exceedsClaudeImageSizeLimit(image: ClaudeDraftImage): boolean {
  return estimateBase64DecodedBytes(image.base64Data) > MAX_CLAUDE_IMAGE_BYTES
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('file reader returned non-string result'))
    }
    reader.readAsDataURL(file)
  })
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64Data: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) {
    throw new Error('unsupported image data url')
  }
  return {
    mediaType: match[1] ?? 'image/png',
    base64Data: match[2] ?? '',
  }
}

function estimateBase64DecodedBytes(base64Data: string): number {
  const normalized = base64Data.trim()
  if (normalized.length === 0) return 0
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.floor((normalized.length * 3) / 4) - padding
}

function parseImagesFromHtml(html: string): ClaudeDraftImage[] {
  if (!html.trim()) return []
  // Some browsers copy web images as an HTML fragment containing an
  // embedded data URL rather than exposing a File in clipboardData.
  // We only parse this into a detached Document and read `img.src` —
  // the HTML is never injected into the live DOM.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const images: ClaudeDraftImage[] = []
  for (const img of Array.from(doc.images)) {
    const src = img.getAttribute('src')?.trim() ?? ''
    if (!src.startsWith('data:image/')) continue
    try {
      const { mediaType, base64Data } = parseDataUrl(src)
      images.push({
        id: crypto.randomUUID(),
        mediaType,
        base64Data,
        previewUrl: src,
        filename: img.getAttribute('alt')?.trim() || 'Pasted image',
      })
    } catch {
      // Ignore malformed HTML image sources and keep scanning.
    }
  }
  return images
}

async function filesToDraftImages(files: File[]): Promise<ClaudeDraftImage[]> {
  return Promise.all(
    files.map(async file => {
      const previewUrl = await fileToDataUrl(file)
      const { mediaType, base64Data } = parseDataUrl(previewUrl)
      return {
        id: crypto.randomUUID(),
        mediaType,
        base64Data,
        previewUrl,
        filename: file.name || 'Pasted image',
      } satisfies ClaudeDraftImage
    }),
  )
}

async function readImagesFromClipboard(): Promise<ClaudeDraftImage[]> {
  if (!navigator.clipboard?.read) return []
  const items = await navigator.clipboard.read()
  const images: ClaudeDraftImage[] = []
  for (const item of items) {
    const imageType = item.types.find(type => type.startsWith('image/'))
    if (!imageType) continue
    const blob = await item.getType(imageType)
    const previewUrl = await fileToDataUrl(new File([blob], 'Pasted image', { type: imageType }))
    const { mediaType, base64Data } = parseDataUrl(previewUrl)
    images.push({
      id: crypto.randomUUID(),
      mediaType,
      base64Data,
      previewUrl,
      filename: 'Pasted image',
    })
  }
  return images
}

function buildClaudeImagePastePayload(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text
  if (text.trim().length === 0) return imagePaths.join('\n')
  return `${imagePaths.join('\n')}\n${text}`
}

async function sendBracketedPaste(
  send: (data: string) => Promise<void>,
  payload: string,
): Promise<void> {
  await send(`\x1b[200~${payload}\x1b[201~`)
}

async function sendBracketedPasteThenSubmit(
  send: (data: string) => Promise<void>,
  payload: string,
  delayMs = 0,
): Promise<void> {
  if (delayMs <= 0) {
    await send(`\x1b[200~${payload}\x1b[201~\r`)
    return
  }
  await sendBracketedPaste(send, payload)
  await wait(delayMs)
  await send('\r')
}

async function sendClaudeDraftText(
  send: (data: string) => Promise<void>,
  text: string,
): Promise<void> {
  if (text.length === 0) return
  const isPasteLike = text.includes('\n') || text.length > CLAUDE_PASTE_THRESHOLD
  if (isPasteLike) {
    await sendBracketedPaste(send, text)
    await wait(CLAUDE_PASTE_SUBMIT_DELAY_MS)
    return
  }
  await send(text)
}

// TileLeaf — one pane. A "mini cc-shell" self-contained in a box:
//   header strip (project dir + status)
//   Feed (structured JSONL + streaming preview)
//   composer (input box routing keystrokes to this pane's session)
//   SlashCommandPicker overlay (when slashMode is active)
//   trust dialog overlay (scoped to this pane, not window-global)
//
// All per-session runtime state comes in through the `runtime` prop —
// this component never touches window.api except for sendInput.
// That's the boundary: the store owns event subscriptions + mutations,
// TileLeaf owns rendering and keyboard input for its specific session.
//
// Slash-mode behavior:
//   When the input is empty and the user types `/`, we flip into
//   "slash mode". In slash mode EVERY keystroke is forwarded directly
//   to the PTY (including the `/` itself), and we keep the React input
//   value in sync with what we've sent so the user still sees their
//   filter text. The slash command picker renders as a dropdown above
//   the composer, driven entirely by picker state the main-process
//   parser detected from CC's screen buffer. Arrow keys navigate the
//   picker (forwarded), Enter commits, Escape cancels. See
//   src/core/parsers/slashCommandPicker.ts for the parser.
//
// We deliberately DON'T track "is the picker visible?" to decide when
// to enter/exit slash mode. That would race the IPC snapshot interval:
// the user types `/` and expects the next keystroke to go to CC, but
// picker.visible might still be false in state for another 16ms. So
// slashMode is local state that flips on `/` and flips off on
// Enter/Escape/backspace-to-empty. The picker is a purely visual
// reflection of CC's state; it doesn't gate anything.

type Props = {
  sessionId: SessionId
  runtime: SessionRuntime
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
}

export function TileLeaf({
  sessionId,
  runtime,
  focused,
  onFocusRequest,
  workspace,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { showToast } = useGlobalToast()
  // Destructure the stable useCallback setter so effect deps don't
  // spuriously invalidate on every parent render. workspace itself
  // is a fresh object literal each render, but its methods are
  // memoed via useCallback in workspaceStore — depping on the
  // method gives us "re-run only when the workspace rebuilds the
  // callback", which in practice is never.
  const { setDraftInput } = workspace
  // Draft input lives in the workspace runtime (not local useState)
  // so it survives TileLeaf unmount when the user switches tabs.
  // App.tsx only mounts the active tab's tree — inactive tabs are
  // unmounted, not hidden — so any component-local state dies on
  // tab switch. See SessionRuntime.draftInput for the full reasoning.
  //
  // We keep a local `setInputText` adapter so the rest of this file
  // reads the same way it did before the hoist. The source of truth
  // is runtime.draftInput; this adapter writes THROUGH to the store.
  const input = runtime.draftInput
  const setInputText = (next: string) => {
    setDraftInput(sessionId, next)
  }
  const setDraftImages = workspace.setDraftImages
  const provider: 'claude' | 'codex' =
    workspace.state.sessions[sessionId]?.kind === 'codex' ? 'codex' : 'claude'

  // Auto-grow the composer textarea to fit its content. We keep a single
  // line by default, but as the user types (or pastes) a long prompt the
  // box extends downward so every character is visible without scrolling
  // inside the input itself. The reflow is driven off `input` so paste,
  // programmatic setInputText, and typed keystrokes all converge on the
  // same measurement pass.
  //
  // Why manual measurement instead of CSS `field-sizing: content`?
  //   - Safari/older Chromium don't support it yet and Electron ships a
  //     pinned Chromium we don't want to track.
  //   - Setting height to 'auto' first forces layout to forget the
  //     previous height, so scrollHeight reflects ONLY the current
  //     content — without the reset we'd ratchet taller and never shrink.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])
  // True while we're forwarding keystrokes to the PTY for a slash
  // command. Controls key routing in onKeyDown and render of the
  // picker dropdown (we still render the dropdown from runtime.picker,
  // but we use slashMode to decide whether keys should be forwarded
  // vs. stored locally).
  const [slashMode, setSlashMode] = useState(false)

  // Scroll position for the indicator above the composer. Updated on
  // every scroll tick via onScrollInfo callback from Feed. fraction=0
  // means at bottom, fraction=1 means at top.
  const [scrollFraction, setScrollFraction] = useState(0)
  const onScrollInfo = useCallback((info: ScrollInfo) => {
    setScrollFraction(info.fraction)
  }, [])

  // ---- Prompt history state ----
  //
  // cc-shell keeps its own bash-style history for the composer instead
  // of forwarding Up/Down to CC. Two reasons:
  //   1. CC's own history updates CC's own input box in the terminal
  //      buffer, but our composer is a React textarea — the two states
  //      never reconcile, so pressing Up in our composer and letting
  //      CC handle it produced no visible change for the user. The
  //      whole thing looked broken.
  //   2. We already have every past user prompt in runtime.entries,
  //      pulled from the JSONL transcript. Deriving a history list
  //      from that is nearly free.
  //
  // `historyIndex` is null when the user is NOT cycling (fresh draft,
  // or just typed something), and a number in [0, history.length - 1]
  // while cycling. 0 = most recent historic prompt, 1 = one before
  // that, etc. When cycling is active the composer displays the
  // history[historyIndex] string, not the live draft.
  //
  // `historyAnchor` stores whatever was in the composer the moment
  // the user first pressed Up to enter the cycle. Pressing Down past
  // the newest historic prompt (i.e. historyIndex back to -1) restores
  // this string so the user doesn't lose mid-typed work.
  //
  // Both pieces of state are component-local (not runtime). They don't
  // need to survive tab-switch because the moment the user comes back
  // to the tab, they start fresh — cycling mid-tab-switch isn't a
  // real workflow. Keeping them local avoids cluttering SessionRuntime
  // and avoids the re-render cost of threading through the store.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [historyAnchor, setHistoryAnchor] = useState<string>('')

  // Derive the history list from the transcript. We walk every
  // ConversationEntry, pull USER-role text content (either from a
  // plain string content or from the first `text` block of an array
  // content), and collect them in REVERSE chronological order so
  // index 0 is the most recent prompt.
  //
  // Filter: the user-role slot in CC's JSONL is used for MANY things
  // besides real typed prompts. Without proper filtering our history
  // picks up strings the user never actually typed, which feels
  // exactly like "another prompt got injected into my input" — the
  // exact bug that forced us to revert the first cut of this feature.
  //
  // Concrete noise we've seen in real transcripts (see commit
  // message for the companion fix commit for the full survey):
  //
  //   1. `isMeta: true` entries like "Continue from where you left
  //      off." — CC's auto-continue hint. User never typed it.
  //   2. `<local-command-caveat>…` and `<command-name>/clear…` —
  //      system markers for local-command invocations. Caught by
  //      the old startsWith('<') filter but still in this list for
  //      the audit record.
  //   3. "Unknown skill: resumeOne" and similar — CC's error
  //      response to bad slash-command invocations. Logged as a
  //      user-role entry, plain-text content, doesn't start with '<'.
  //      THE main offender that made it into the first cut.
  //   4. Tool-result-only user-role entries — no text blocks at
  //      all, just the results for the previous assistant turn's
  //      tool_use blocks. Harmless with our "has text" check but
  //      noted for completeness.
  //
  // Positive signal for "this was a real prompt the user typed":
  // the entry has a `permissionMode` field set. Empirically every
  // real user prompt in the current transcript (27/27) carries it;
  // every synthetic entry (isMeta, error responses, local-command
  // markers) lacks it. `isMeta === true` is a redundant secondary
  // defense in case CC ever starts writing permissionMode into
  // synthetic meta entries too. startsWith('<') stays as a tertiary
  // catch-all for any future tag-shaped synthetics.
  //
  // Dedup: adjacent identical prompts (the "oops, meant to add
  // detail" resubmit pattern) collapse into one entry. Distant
  // duplicates stay, matching bash history behavior. Memoed on
  // entries reference so normal re-renders don't rebuild the list.
  const sessionKind = workspace.state.sessions[sessionId]?.kind
  const history = useMemo(() => {
    return extractLatestUserPrompts(runtime.entries, sessionKind).map(prompt => prompt.text)
  }, [runtime.entries, sessionKind])

  // Helper: are we currently in history-cycling mode? Multiple key
  // handlers consult this and a named check reads cleaner than
  // `historyIndex !== null` repeated everywhere.
  const cyclingHistory = historyIndex !== null

  // Helper: cancel history cycling without changing the composer text.
  // Called whenever the user makes ANY edit that isn't Up/Down — the
  // invariant is "once you start typing over a recalled prompt, it's
  // yours, and the next Up starts from the newest entry again."
  const endHistoryCycle = () => {
    if (historyIndex !== null) setHistoryIndex(null)
  }

  // (cursor-row helpers removed — the new history gate fires only
  // when the composer is entirely empty, so multi-line caret
  // navigation is moot.)

  // When focus flips to this pane, move the DOM caret into its input.
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  // Type-to-focus: when the user starts typing anywhere in the
  // focused pane — feed area, a stray click on a button, whatever —
  // the keystroke routes to the composer without them having to
  // click on it first.
  //
  // Why this is needed even with the focus-on-focus effect above:
  // DOM focus wanders. Clicking a feed button, interacting with
  // the tab bar, switching apps and coming back, hitting a keybind
  // that focuses something else — all of these leave DOM focus
  // somewhere other than the composer textarea. The focus-on-pane-
  // focus effect only fires when `focused` CHANGES, which doesn't
  // happen in any of those cases. So a fresh keystroke can land
  // nowhere useful.
  //
  // The fix: listen at document level (scoped to the currently
  // focused pane via the `focused` guard), and when a printable
  // key comes in while DOM focus is NOT on an editable target,
  // redirect it to the composer.
  //
  // Filter list (all of these are cases where we must NOT steal
  // the key):
  //   - `defaultPrevented`: a keybind or earlier handler already
  //     handled this. Stay out of their way.
  //   - Any modifier (cmd / ctrl / alt / meta): modifier combos
  //     are global keybinds, not text input.
  //   - Non-printable key (e.key.length !== 1): arrow keys,
  //     Escape, Enter, Backspace, Tab, function keys. Those all
  //     have multi-char names.
  //   - Target is already an input / textarea / contentEditable:
  //     the character is already going somewhere legitimate; don't
  //     intercept it and double-type.
  //   - A modal with role="dialog" is open: PathPickerModal,
  //     TrustDialogModal, or any future modal. Those own keyboard
  //     focus while visible.
  //
  // Injection path: we write directly to SessionRuntime.draftInput
  // via workspace.setDraftInput (same setter the composer's
  // onChange uses), then focus() the textarea, then move the
  // cursor to end on the next frame after React re-renders with
  // the new value. The rAF is load-bearing: setting selectionStart
  // synchronously on a textarea whose React-bound `value` hasn't
  // re-rendered yet targets the OLD value and puts the cursor
  // at a stale index.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (target.isContentEditable) return
      }
      if (document.querySelector('[role="dialog"]')) return

      const el = inputRef.current
      if (!el) return
      e.preventDefault()
      const next = el.value + e.key
      setDraftInput(sessionId, next)
      el.focus()
      requestAnimationFrame(() => {
        const el2 = inputRef.current
        if (!el2) return
        el2.selectionStart = el2.value.length
        el2.selectionEnd = el2.value.length
      })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // setDraftInput is a stable useCallback from the workspace hook
    // so re-destructuring it every render is a no-op for this dep
    // array. If workspace ever stops memoing it, this effect would
    // re-subscribe on every render and we'd add/remove a document
    // listener every frame — so keep setDraftInput memoed upstream.
  }, [focused, sessionId, setDraftInput])

  const send = async (data: string) => {
    const ok = await window.api.sendInput(sessionId, data)
    if (!ok) {
      throw new Error(`sendInput failed for missing session ${sessionId}`)
    }
  }

  const appendDraftImages = useCallback(
    (images: ClaudeDraftImage[]) => {
      if (images.length === 0) return
      setDraftImages(sessionId, prev => [...prev, ...images])
    },
    [sessionId, setDraftImages],
  )

  const removeDraftImage = useCallback(
    (imageId: string) => {
      setDraftImages(sessionId, prev => prev.filter(image => image.id !== imageId))
    },
    [sessionId, setDraftImages],
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (provider !== 'claude') return

      try {
        const itemFiles = Array.from(e.clipboardData.items)
          .map(item => item.type.startsWith('image/') ? item.getAsFile() : null)
          .filter((file): file is File => Boolean(file && file.type.startsWith('image/')))
        const htmlImages = parseImagesFromHtml(e.clipboardData.getData('text/html'))

        let images: ClaudeDraftImage[] = htmlImages
        if (itemFiles.length > 0) {
          e.preventDefault()
          const fileImages = await filesToDraftImages(itemFiles)
          const existing = new Set(images.map(image => image.previewUrl))
          images = [
            ...images,
            ...fileImages.filter(image => !existing.has(image.previewUrl)),
          ]
        } else if (images.length === 0) {
          images = await readImagesFromClipboard()
          if (images.length > 0) {
            e.preventDefault()
          }
        } else {
          e.preventDefault()
        }
        if (images.length === 0) return
        const unsupported = images.find(
          image => !isSupportedClaudeImageMediaType(image.mediaType),
        )
        if (unsupported) {
          showToast(
            `Unsupported image format: ${unsupported.mediaType}. Claude supports ${SUPPORTED_CLAUDE_IMAGE_FORMATS_TEXT}.`,
          )
          return
        }
        const oversized = images.find(exceedsClaudeImageSizeLimit)
        if (oversized) {
          showToast(
            `Image is too large. Claude supports pasted images up to 5 MB.`,
          )
          return
        }
        appendDraftImages(images)
      } catch (err) {
        console.warn('[TileLeaf] image paste failed', err)
        showToast('Image paste failed.')
      }
    },
    [appendDraftImages, provider, showToast],
  )

  const exitSlashMode = () => {
    setSlashMode(false)
    setInputText('')
  }

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Global keybinds bubble up to the document-level listener in
    // useKeybinds; if a modifier-combo handler called preventDefault
    // already, skip processing here to avoid routing pane-management
    // keys into the PTY as text.
    if (e.defaultPrevented) return

    // ---- Slash mode entry ----
    //
    // Only when input is empty AND the user types `/`. That way normal
    // text containing a `/` in the middle (a URL, a path) doesn't
    // accidentally flip us into slash mode.
    if (!slashMode && input === '' && e.key === '/') {
      e.preventDefault()
      await send('/')
      setInputText('/')
      setSlashMode(true)
      return
    }

    // ---- Slash mode: forward every key to PTY ----
    if (slashMode) {
      e.preventDefault()

      if (e.key === 'Escape') {
        // Send ESC to CC (dismisses the picker) and exit slash mode.
        // slashMode is intentionally flipped off BEFORE the picker's
        // next screen update arrives — we don't want to wait for CC
        // to confirm the dismissal before letting the user type.
        await send('\x1b')
        exitSlashMode()
        return
      }
      if (e.key === 'Enter') {
        // Commit whatever CC has highlighted. If there's no highlight
        // CC will just send the literal text as a regular prompt.
        await send('\r')
        exitSlashMode()
        return
      }
      if (e.key === 'Backspace') {
        await send('\x7f')
        const next = input.slice(0, -1)
        setInputText(next)
        // If the user backspaces all the way out, we're no longer in
        // slash mode — fall back to the normal composer.
        if (next === '') setSlashMode(false)
        return
      }
      if (e.key === 'ArrowUp') {
        await send('\x1b[A')
        return
      }
      if (e.key === 'ArrowDown') {
        await send('\x1b[B')
        return
      }
      if (e.key === 'ArrowLeft') {
        await send('\x1b[D')
        return
      }
      if (e.key === 'ArrowRight') {
        await send('\x1b[C')
        return
      }
      if (e.key === 'Tab') {
        await send('\t')
        return
      }
      // Single printable char: forward + mirror into local state so
      // the React input visibly tracks what CC has in its buffer.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        await send(e.key)
        setInputText(input + e.key)
        return
      }
      // Ignore shift, ctrl, meta, function keys, etc. while in slash mode.
      return
    }

    // ---- Normal mode ----
    //
    // Shift+Enter: insert a literal newline in the composer (normal
    // textarea behavior). We DON'T preventDefault so the browser handles
    // the insertion, and we don't forward anything to the PTY — the
    // newline only becomes visible to CC when the user commits with a
    // bare Enter below. This gives multi-line prompt editing without
    // touching the PTY until the user actually wants to send.
    if (e.key === 'Enter' && e.shiftKey) {
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const draftImages = runtime.draftImages
      if (input.trim().length === 0 && draftImages.length === 0) {
        return
      }
      // Capture streaming baseline from the very freshest screen text
      // so the streaming card can detect "this is the old response"
      // reliably. latestScreenRef is mutated synchronously on every
      // IPC screen event so this is always current.
      const screen = workspace.latestScreenRef.current[sessionId] ?? ''
      const provider = workspace.state.sessions[sessionId]?.kind === 'codex' ? 'codex' : 'claude'
      const baseline = extractAssistantInProgress(screen, provider)
      workspace.setStreamingBaseline(sessionId, baseline)
      if (provider === 'codex') {
        // Codex does not reliably give us a structured user message at submit
        // time the way Claude does. Seed the feed immediately from the local
        // composer state so "submit" is visible even if rollout JSON is late.
        workspace.addOptimisticCodexUserEntry(sessionId, input)
      }

      try {
        const hasClaudeImages = provider === 'claude' && draftImages.length > 0
        // Three submit modes live here because the two providers'
        // input stacks are similar but NOT equivalent:
        //
        //   1. Codex: always bracketed-paste, always trailing Enter
        //      outside the paste block, both in one write. This is the
        //      path that fixed Codex swallowing `\r` as pasted text.
        //
        //   2. Claude, normal text: raw text + `\r` in one write. Fast
        //      path for the overwhelmingly common case.
        //
        //   3. Claude, paste-like text (multiline OR long enough to hit
        //      Claude's own paste path): bracketed paste first, THEN a
        //      delayed `\r` in a second write. This is the critical fix
        //      for the "first Enter populates the prompt but does not
        //      actually submit; second Enter finally sends it" bug.
        const isClaudePasteLike =
          provider === 'claude' &&
          (input.includes('\n') || input.length > CLAUDE_PASTE_THRESHOLD)

        if (provider === 'codex') {
          await sendBracketedPasteThenSubmit(send, input)
        } else if (hasClaudeImages) {
          const savedImages = await Promise.all(
            draftImages.map(image =>
              window.api.saveClaudeImage({
                base64Data: image.base64Data,
                mediaType: image.mediaType,
                filename: image.filename,
              }),
            ),
          )
          const imagePaths = savedImages.map(image => image.path)
          if (input.length > 0) {
            await sendClaudeDraftText(send, input)
            // Claude collapses the following path paste into image pills.
            // If the user's prompt ends in a non-whitespace character,
            // inject one separator so the final prompt text does not run
            // directly into the first `[Image #N]` placeholder.
            if (!/\s$/.test(input)) {
              await send(' ')
            }
          }
          const payload = buildClaudeImagePastePayload('', imagePaths)
          await sendBracketedPasteThenSubmit(send, payload, CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS)
        } else if (isClaudePasteLike) {
          // Keep the submit key OUT of the bracketed-paste write and
          // wait past Claude's paste debounce. Sending `\r` in the same
          // PTY chunk races Claude's paste accumulator and can leave the
          // prompt sitting in the composer until a later keypress nudges
          // it through the normal submit path.
          await sendBracketedPasteThenSubmit(send, input, CLAUDE_PASTE_SUBMIT_DELAY_MS)
        } else {
          await send(input + '\r')
        }
        setInputText('')
        if (provider === 'claude' && draftImages.length > 0) {
          setDraftImages(sessionId, [])
        }
      } catch (err) {
        // Keep the draft visible if main no longer has a live session for this
        // pane. Clearing the composer on a dropped write makes the failure look
        // like Codex ignored the prompt when it never received it.
        if (provider === 'codex') {
          workspace.removeOptimisticCodexUserEntry(sessionId, input)
        }
        console.warn('[TileLeaf] submit failed', err)
      }
      // Any submit exits history cycling — the prompt is committed
      // and the next Up should start a fresh walk from the (now
      // updated) newest entry, not continue from wherever we were.
      endHistoryCycle()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      await send('\x1b')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      await send('\x03')
      setInputText('')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      await send('\x04')
      return
    }
    // ---- Prompt history: Up cycles BACKWARD into past prompts ----
    //
    // Entry gate: we ONLY enter cycling when the composer is
    // currently empty. That's deliberately more restrictive than
    // bash's "cycle even with a partial draft and restore on Down".
    // The permissive version caused real confusion — users pressing
    // Up with a mid-typed prompt would watch their draft get
    // replaced with a random historic prompt and think something
    // was injecting text into their input. The anchor-restore
    // mechanism was there but non-obvious. Requiring an empty
    // composer makes the feature discoverable and non-destructive:
    // you have to actively clear your input before you can cycle.
    //
    // Once cycling has STARTED (historyIndex !== null), subsequent
    // Up/Down steps don't re-check emptiness — the composer is
    // showing a historic prompt, not user typing, so stepping
    // further is obviously safe.
    //
    // Modifier combos (Shift/Ctrl/Meta/Alt+Up) fall through to the
    // PTY-forward path so OS line-navigation shortcuts still reach
    // CC when the user wants them.
    // Skip history cycling when the approval overlay is visible —
    // arrow keys need to reach the PTY so Codex can navigate its
    // selection list.
    if (
      e.key === 'ArrowUp' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !runtime.pendingApproval &&
      !runtime.pendingTrustDialog &&
      !runtime.pendingResumePrompt &&
      history.length > 0 &&
      (cyclingHistory || input === '')
    ) {
      e.preventDefault()
      if (!cyclingHistory) {
        // First entry into cycling: the composer is empty (per the
        // gate above), so the anchor is also empty. Storing it
        // anyway keeps the Down-past-newest restore path uniform.
        setHistoryAnchor('')
        setHistoryIndex(0)
        setInputText(history[0])
      } else {
        const next = Math.min(historyIndex! + 1, history.length - 1)
        if (next !== historyIndex) {
          setHistoryIndex(next)
          setInputText(history[next])
        }
      }
      return
    }

    // ---- Prompt history: Down cycles FORWARD toward the anchor ----
    //
    // Only meaningful while we're already cycling. Pressing Down
    // outside a cycle shouldn't do anything (no forward history to
    // cycle to). We also don't need the cursorOnBottomRow check the
    // old version had, because the composer's content during
    // cycling is a historic prompt the user hasn't touched — there's
    // no multi-line-draft caret navigation to preserve.
    if (
      e.key === 'ArrowDown' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !runtime.pendingApproval &&
      !runtime.pendingTrustDialog &&
      !runtime.pendingResumePrompt &&
      cyclingHistory
    ) {
      e.preventDefault()
      const next = historyIndex! - 1
      if (next < 0) {
        // Past the newest historic prompt — restore the anchor
        // (empty, since the Up gate only lets us in from an empty
        // composer) and exit cycle mode so the next Up starts fresh.
        setHistoryIndex(null)
        setInputText(historyAnchor)
      } else {
        setHistoryIndex(next)
        setInputText(history[next])
      }
      return
    }

    // Fallback: any other Up/Down (not cycling, not at top/bottom
    // row, or with a modifier) falls through to the old PTY-forward
    // path so CC's own history / caret navigation still reaches it
    // when appropriate.
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      await send('\x1b[A')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      await send('\x1b[B')
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      await send('\t')
      return
    }
  }

  const running = runtime.exited === null
  const isSessionLive =
    runtime.semantic.currentTurn !== null ||
    runtime.activityStatus !== null ||
    runtime.awaitingAssistant

  return (
    <div
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={onFocusRequest}
    >
      {/*
        WHY the pane header does not key purely off `awaitingAssistant` anymore:
        after moving live rendering toward the semantic stream, that legacy flag
        became only one of several "agent is still busy" signals. Semantic turns
        and explicit activity status are both stronger indicators than the old
        submit lifecycle, especially for tool-heavy or background-agent work.
      */}
      {/* Pane header: compact status strip.
          In status mode, working panes paint with the theme accent;
          idle/exited panes get no fill — the absence of color is the
          signal, so a glance across the grid highlights only the
          panes that still want attention. Previous design used
          green/red, but red read as "error" for merely idle panes. */}
      <div className={`flex items-center justify-between px-3 border-b border-border text-[10px] font-code select-none ${
        workspace.statusMode
          ? isSessionLive
            ? 'bg-accent text-accent-fg'
            : 'bg-surface text-muted'
          : 'bg-surface text-muted'
      } ${workspace.statusMode ? 'py-0 min-h-[5px]' : 'py-1'}`}>
        <span className="truncate" title={runtime.projectDir ?? 'no project dir'}>
          {shortenCwd(runtime.projectDir)}
        </span>
      </div>

      {/* Feed — overflow-auto lives inside Feed itself so it can
          own its own scroll listener for the sticky-bottom logic
          (see Feed.tsx FeedImpl). This wrapper just provides the
          flex cell sizing; the scroller is a child. */}
      <div className="flex-1 min-h-0">
        <Feed
          sessionId={sessionId}
          provider={provider}
          workspaceRoot={workspace.state.sessions[sessionId]?.cwd ?? null}
          entries={runtime.entries}
          // Live text renders ONLY from the semantic channel. The
          // former `streamingScreen` / `streamingScreenMarkdown` /
          // `streamingBaseline` props are gone — Feed no longer
          // parses the TUI buffer at render time. Screen-derived
          // live text now arrives via the semantic channel tagged
          // `source: 'screen'`, published by the headless packages
          // with a baseline gate that prevents the previous turn's
          // text from leaking into the new turn's first delta.
          activityStatus={runtime.activityStatus}
          semanticTurn={runtime.semantic.currentTurn}
          tailMode={runtime.tailMode}
          pickerSelectedUuid={runtime.assistantPicker?.selectedUuid ?? null}
          onScrollInfo={onScrollInfo}
          hasOlderHistory={runtime.hasOlderHistory}
          loadingOlderHistory={runtime.loadingOlderHistory}
          onLoadOlderHistory={async () => {
            await workspace.loadOlderHistory(sessionId)
          }}
          // Bootstrap-replay perf wiring — see workspaceStore +
          // Feed for the WHY. While `bootstrapping` is true Feed
          // suspends per-append auto-scroll and lazy-mount cascades;
          // the indices spare Feed from a useMemo rebuild on every
          // append.
          bootstrapping={runtime.bootstrapping}
          scrollToLatestRequest={runtime.scrollToLatestRequest}
          toolUseIndex={runtime.toolUseIndex}
          toolResultIndex={runtime.toolResultIndex}
        />
      </div>

      {/* Pending queue strip. Renders only when CC's internal message
          queue has items — i.e. the user submitted prompts while CC
          was still generating a previous turn. Lives between Feed and
          composer so it sits in the natural "about to happen" region
          of the screen, and so the user can see their queued text
          without it getting mixed into the feed proper (where it
          would show as either phantom future user rows or as real
          rows that then duplicate themselves when the actual user
          entry materializes in the transcript).

          Feature-gated on queuedMessages.length so the strip is
          zero-DOM when nothing is queued — no layout shift for the
          common path. */}
      {runtime.queuedMessages.length > 0 && (
        <div
          className="flex-shrink-0 border-t border-border bg-surface px-5 py-2"
          aria-label="queued messages"
        >
          <div className="text-muted text-[10px] uppercase tracking-wider mb-1 select-none">
            {runtime.queuedMessages.length} queued
          </div>
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
            {runtime.queuedMessages.map(q => (
              <li
                key={q.timestamp}
                className="flex items-start gap-2 text-[12px] leading-[1.5] text-ink-dim"
              >
                <span
                  className="text-accent flex-shrink-0 select-none opacity-60"
                  aria-hidden="true"
                >
                  ❯
                </span>
                <span className="flex-1 min-w-0 break-words font-code">
                  {q.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Codex approval prompt — rendered inline in the pane, matching
          how Codex's TUI draws it. Sits between feed and composer. */}
      <CodexApprovalModal
        approval={runtime.pendingApproval}
        onSend={send}
      />

      <ResumePromptModal
        prompt={runtime.pendingResumePrompt}
        onSend={send}
      />

      {runtime.pendingCompaction && runtime.pendingCompaction.phase !== 'done' && (
        <div
          className={`flex-shrink-0 border-t px-5 py-2 font-code text-[12px] leading-[1.6] ${
            runtime.pendingCompaction.phase === 'error'
              ? 'text-danger border-danger/30 bg-danger/8'
              : 'text-ink border-border bg-surface'
          }`}
        >
          <div className="font-semibold">
            {runtime.pendingCompaction.phase === 'error'
              ? 'Compaction failed'
              : 'Compacting conversation'}
          </div>
          {((runtime.pendingCompaction.phase === 'error'
            ? runtime.pendingCompaction.errorText
            : runtime.pendingCompaction.statusText)) && (
            <div className="mt-0.5 whitespace-pre-wrap break-words opacity-90">
              {runtime.pendingCompaction.phase === 'error'
                ? runtime.pendingCompaction.errorText
                : runtime.pendingCompaction.statusText}
            </div>
          )}
        </div>
      )}

      {/* Pane toast — transient single-slot feedback (e.g. "Copied to clipboard").
          Renders above the composer so it's contextually tied to this pane,
          not floating over the feed content. Auto-dismissed by the store
          timeout; we just render when non-null. */}
      {runtime.paneToast && (
        <div className="
          flex-shrink-0 flex justify-center
          px-3 py-1.5
          border-t border-border bg-surface
        ">
          <span className="
            toast-enter
            text-[11px] font-code text-white font-semibold
            bg-accent/80
            px-3 py-0.5
          ">
            {runtime.paneToast}
          </span>
        </div>
      )}

      {/* Scroll position indicator — sits just above the composer,
          right-aligned. Shows which entry you're looking at out of
          the total. Feed emits `fraction = 1 - scrollTop/maxScroll`,
          so fraction=0 at the bottom (newest entry visible) and
          fraction=1 at the top (oldest). We invert before display so
          the badge reads natural-order: latest = N/N, oldest = 1/N.
          Floor at 1 so the badge never reads 0/N — even at the
          extreme bottom there's still an entry on screen. */}
      {runtime.entries.length > 0 && (
        <div className="flex-shrink-0 flex justify-end px-3 leading-none">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-code text-muted">
              {providerLabel(workspace.state.sessions[sessionId]?.kind)}
            </span>
            {runtime.tailMode && (
              <span className="text-[10px] font-code uppercase tracking-wider text-accent">
                TAIL
              </span>
            )}
          <span className="text-[12px] font-code tabular-nums text-accent">
            {Math.max(
              1,
              Math.ceil((1 - scrollFraction) * runtime.entries.length),
            )}/{runtime.entries.length}
          </span>
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-border bg-surface px-3 py-2 relative">
        {/* SlashCommandPicker is absolutely positioned relative to this
            composer container so it floats above the input without
            shifting layout. */}
        <SlashCommandPicker state={runtime.picker} />

        {/* The composer is a <textarea> (not <input>) so the box can
            grow vertically to fit a multi-line prompt. See the
            useEffect above that drives the height off scrollHeight.
            The chevron is aligned to the top of the box instead of
            vertically-centered because a 10-line prompt looks odd
            with a chevron floating in the middle of nowhere. */}
        {provider === 'claude' && runtime.draftImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {runtime.draftImages.map(image => (
              <div
                key={image.id}
                className="relative w-24 rounded border border-border bg-canvas p-1"
              >
                <button
                  type="button"
                  className="absolute right-1 top-1 z-10 h-5 w-5 rounded-full bg-surface/90 text-[12px] leading-none text-ink hover:bg-surface"
                  onClick={() => removeDraftImage(image.id)}
                  aria-label={`Remove ${image.filename}`}
                >
                  ×
                </button>
                <img
                  src={image.previewUrl}
                  alt={image.filename}
                  className="h-16 w-full rounded object-cover"
                />
                <div className="mt-1 truncate text-[10px] font-code text-muted">
                  {image.filename}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          <div className="absolute left-2 top-[10px] text-accent text-[12px] pointer-events-none select-none">
            ❯
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            className={`
              w-full bg-canvas border
              ${focused ? 'border-accent' : 'border-border'}
              text-ink text-[12px]
              pl-6 pr-2 py-2 outline-none
              placeholder:text-muted
              transition-colors duration-150
              resize-none overflow-hidden leading-[1.4]
              font-code
            `}
            value={input}
            onChange={e => {
              // In slash mode we manage the value ourselves via
              // onKeyDown; the browser's default onChange (which fires
              // on paste, IME composition end, etc.) would duplicate
              // keystrokes that we already forwarded. Ignore in slash
              // mode — the display value is already in sync because
              // onKeyDown called setInputText.
              if (slashMode) return
              setInputText(e.target.value)
              // ANY user edit (typing, paste, delete) cancels history
              // cycling: once they've touched the recalled prompt it's
              // theirs, and the next Up should start fresh from the
              // newest entry rather than continuing the old cycle.
              // The Up/Down handlers set historyIndex AND call
              // setInputText, which would trigger this onChange and
              // wipe their own state — so we guard against that by
              // only ending the cycle when the NEW value differs from
              // whatever history slot we're currently parked on.
              if (
                historyIndex !== null &&
                e.target.value !== history[historyIndex]
              ) {
                endHistoryCycle()
              }
            }}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            onFocus={onFocusRequest}
            placeholder={
              slashMode
                ? undefined
                : focused
                  ? 'type and press enter… (shift+enter for newline)'
                  : ''
            }
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>

      {/* Per-pane trust dialog: only shown if THIS pane's screen buffer
          contains the trust prompt. Other panes have their own modals. */}
      <TrustDialogModal state={runtime.pendingTrustDialog} onSend={send} />
    </div>
  )
}

function shortenCwd(cwd: string | null): string {
  if (!cwd) return '—'
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return '/' + parts.join('/')
  return '…/' + parts.slice(-2).join('/')
}

function providerLabel(kind: SessionKind | undefined): string {
  switch (kind) {
    case 'codex':
      return 'Codex'
    case 'terminal':
      return 'Terminal'
    case 'claude':
    default:
      return 'Claude Code'
  }
}
