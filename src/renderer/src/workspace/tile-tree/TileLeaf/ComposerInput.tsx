import type { RefObject } from 'react'

import { SlashCommandPicker } from '@providers/claude/renderer/SlashCommandPicker'
import type { ClaudeDraftImage, SlashPickerState } from '@renderer/workspace/workspaceState'

// Composer input — the textarea at the bottom of the pane plus its
// two siblings: the Claude draft-images preview strip and the
// SlashCommandPicker overlay. All three live in one flex-shrink-0
// container so the composer never gets squeezed out of the pane's
// vertical budget.
//
// Why this component owns the onChange logic:
//   - slash-mode suppression: while slashMode is true, every
//     keystroke has already been forwarded to CC by the keybind
//     hook AND the React state has been mirrored inside that same
//     handler. The browser's own onChange fires on paste and IME
//     composition-end events that the keybind hook doesn't cover,
//     and without this guard we'd double-apply those writes.
//   - history-cycle cancel: any user-originated edit ends an
//     active cycle so the next Up starts fresh. The Up/Down keybind
//     code *also* calls setInputText, which would recursively
//     cancel its own cycle; we guard against that by only ending
//     the cycle when the new value differs from the currently-
//     parked history slot.
export function ComposerInput({
  inputRef,
  input,
  focused,
  slashMode,
  provider,
  draftImages,
  pickerState,
  historyIndex,
  history,
  setInputText,
  endHistoryCycle,
  onKeyDown,
  onPaste,
  onFocusRequest,
  removeDraftImage,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  input: string
  focused: boolean
  slashMode: boolean
  provider: 'claude' | 'codex'
  draftImages: ClaudeDraftImage[]
  pickerState: SlashPickerState | null
  historyIndex: number | null
  history: string[]
  setInputText: (next: string) => void
  endHistoryCycle: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onFocusRequest: () => void
  removeDraftImage: (imageId: string) => void
}) {
  return (
    <div className="flex-shrink-0 border-t border-border bg-surface px-3 py-2 relative">
      {/* SlashCommandPicker is absolutely positioned relative to this
          composer container so it floats above the input without
          shifting layout. */}
      <SlashCommandPicker state={pickerState} />

      {/* The composer is a <textarea> (not <input>) so the box can
          grow vertically to fit a multi-line prompt. See
          useComposerAutoGrow for the height effect that drives the
          reflow off scrollHeight. The chevron is aligned to the top
          of the box instead of vertically-centered because a
          10-line prompt looks odd with a chevron floating in the
          middle of nowhere. */}
      {provider === 'claude' && draftImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {draftImages.map(image => (
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
            // onKeyDown; the browser's default onChange (which
            // fires on paste, IME composition end, etc.) would
            // duplicate keystrokes that we already forwarded.
            // Ignore in slash mode — the display value is already
            // in sync because onKeyDown called setInputText.
            if (slashMode) return
            setInputText(e.target.value)
            // ANY user edit (typing, paste, delete) cancels
            // history cycling: once they've touched the recalled
            // prompt it's theirs, and the next Up should start
            // fresh from the newest entry rather than continuing
            // the old cycle. The Up/Down handlers set
            // historyIndex AND call setInputText, which would
            // trigger this onChange and wipe their own state —
            // so we guard against that by only ending the cycle
            // when the NEW value differs from whatever history
            // slot we're currently parked on.
            if (
              historyIndex !== null &&
              e.target.value !== history[historyIndex]
            ) {
              endHistoryCycle()
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
  )
}
