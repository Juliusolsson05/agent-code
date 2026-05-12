import type { RefObject } from 'react'

import { SlashCommandPicker } from '@providers/claude/renderer/SlashCommandPicker'
import type { ClaudeDraftImage, SlashPickerState } from '@renderer/workspace/workspaceState'
import type { ComposerDictationController } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'

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
  onUserEngagement,
  removeDraftImage,
  dictation,
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
  onUserEngagement: () => void
  removeDraftImage: (imageId: string) => void
  dictation: ComposerDictationController
}) {
  const showDictationPlaceholder = dictation.enabled && dictation.busy && input.length === 0
  const showDictationActivity = dictation.enabled && dictation.busy

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
        {showDictationActivity ? (
          <ComposerDictationActivity
            status={dictation.status}
            levels={dictation.levels}
          />
        ) : null}
        <textarea
          ref={inputRef}
          rows={1}
          className={`
            w-full bg-canvas border
            ${focused ? 'border-accent' : 'border-border'}
            text-ink text-[12px]
            pl-6 ${showDictationActivity ? 'pr-16' : 'pr-2'} py-2 outline-none
            placeholder:text-muted
            transition-colors duration-150
            resize-none overflow-hidden leading-[1.4]
            font-code
          `}
          value={input}
          onChange={e => {
            onUserEngagement()
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
          onPaste={e => {
            onUserEngagement()
            onPaste(e)
          }}
          onPointerDown={() => {
            onUserEngagement()
          }}
          onFocus={onFocusRequest}
          placeholder={
            slashMode
              ? undefined
              : showDictationPlaceholder
                ? 'listening…'
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

function ComposerDictationActivity({
  status,
  levels,
}: {
  status: ComposerDictationController['status']
  levels: number[]
}) {
  const active = status === 'recording'
  const stopping = status === 'stopping'
  // The audio meter and transcript preview are intentionally independent.
  // The May 12 dictation logs showed healthy AUDIO_LEVEL samples while the UI
  // stayed on dots because the main process was temporarily batch-only and
  // therefore never emitted preview text. Hiding bars behind
  // `hasTranscriptPreview` made a provider-preview outage look like a dead
  // microphone. During recording, always show the meter; use dots only for
  // startup/stop states where there is no live analyser frame to trust.
  const showDots = !active || stopping

  return (
    <div
      className={`
        pointer-events-none absolute right-2 top-1/2 z-10 flex h-6 w-12
        -translate-y-1/2 items-center justify-center overflow-hidden
        border-l border-border/70 pl-2
        ${stopping ? 'text-muted' : 'text-accent'}
      `}
      aria-hidden="true"
    >
      {showDots ? (
        <ComposerDictationDots />
      ) : (
        <ComposerDictationBars levels={levels} active={active} />
      )}
    </div>
  )
}

function ComposerDictationBars({
  levels,
  active,
}: {
  levels: number[]
  active: boolean
}) {
  // Same visual model as the standalone MicPill: the bars are real
  // speech-band energy values, with the sine curve only giving the strip a
  // small organic bend. Quiet room means quiet bars; voice bands spike where
  // the mic actually hears speech.
  const phases = [0, 0.11, 0.23, 0.37, 0.52, 0.68, 0.84]
  const t = (Date.now() % 700) / 700
  return (
    <div className="flex h-5 items-center gap-[3px]">
      {phases.map((phase, i) => {
        const voice = levels[i] ?? 0
        const wave = active ? 0.86 + 0.14 * Math.abs(Math.sin((t + phase) * Math.PI * 2)) : 1
        const responsive = active ? Math.max(voice, 0.025) * wave : 0.02
        const height = Math.max(3, Math.round(responsive * 18))
        return (
          <span
            key={phase}
            className="w-[3px] rounded-sm bg-current transition-[height] duration-[28ms]"
            style={{
              height,
              opacity: active ? 0.62 + Math.min(0.38, voice * 0.7) : 0.5,
            }}
          />
        )
      })}
    </div>
  )
}

function ComposerDictationDots() {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-current"
          style={{
            animation: `composer-dictation-pulse 1.1s ${i * 0.18}s ease-in-out infinite`,
          }}
        />
      ))}
      <style>{`@keyframes composer-dictation-pulse { 0%,80%,100%{opacity:.2;transform:scale(.85)} 40%{opacity:1;transform:scale(1)} }`}</style>
    </div>
  )
}
