import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

// PathInput — a generic path-with-completion input for anywhere in Agent Code
// that needs the user to type a filesystem path (PathPickerModal today,
// likely more places soon: file pickers, context attachments, cwd
// changes within a pane, etc).
//
// Responsibilities:
//   - Debounced directory listing via window.api.listDirectory.
//   - Split the user's raw input into { dir, base } so suggestions are
//     scoped to the parent they're typing under, filtered by the trailing
//     token the cursor is on.
//   - Render a dropdown of suggestions below the input with keyboard
//     (ArrowUp/Down) and mouse navigation.
//   - Tab = apply the highlighted suggestion (like bash tab-complete).
//   - Enter = submit the current value (caller validates + acts).
//   - Escape = cancel (if no suggestions open, delegates to onCancel).
//
// What this component deliberately DOESN'T do:
//   - Validate the path. That's the caller's job — usually via
//     window.api.expandCwd on submit. We just help the user construct it.
//   - Constrain to directories. `directoriesOnly` is a hint passed to
//     main; flipping it false lets us reuse the component for file pickers.
//   - Wrap a form. Callers compose <PathInput> into their own form/modal.

export type DirEntry = {
  name: string
  isDirectory: boolean
  path: string
}

type Props = {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  onCancel: () => void
  placeholder?: string
  /** If true (default), the dropdown only lists directories. */
  directoriesOnly?: boolean
  /** If true, include dotfiles in the dropdown. Default false. */
  showHidden?: boolean
  /** Extra classes for the <input> element, so the caller can style. */
  inputClassName?: string
  /** Extra classes for the dropdown container. */
  dropdownClassName?: string
  /** Inline style applied to the input (used for error state). */
  inputStyle?: CSSProperties
  /** Auto-focus the input on mount. */
  autoFocus?: boolean
  /** Disable the input entirely. */
  disabled?: boolean
}

export function PathInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  directoriesOnly = true,
  showHidden = false,
  inputClassName = '',
  dropdownClassName = '',
  inputStyle,
  autoFocus = false,
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [highlighted, setHighlighted] = useState(0)
  // When true the dropdown is hidden even if we have suggestions —
  // user explicitly dismissed it with Escape or by clicking outside.
  // Gets reset whenever the user types something new or focuses back
  // into the input, so the dropdown comes right back without any
  // special gesture.
  const [dismissed, setDismissed] = useState(false)
  // The request version lets us ignore stale async responses that come
  // back after a newer request has already fired — without this, fast
  // typing would flicker the dropdown with old results.
  const reqVersionRef = useRef(0)

  // Split "/Users/jul" into { dir: "/Users", base: "jul" }.
  // The split controls what we ask main to list (the dir) and how we
  // filter the results client-side (the base). Trailing slashes mean
  // "list this directory, no filter."
  const { dir, base } = useMemo(() => splitPath(value), [value])

  // Debounced directory listing. 60ms is fast enough to feel live
  // while typing, slow enough that character-by-character typing doesn't
  // spam main with requests.
  useEffect(() => {
    const v = ++reqVersionRef.current
    const t = setTimeout(async () => {
      const result = await window.api.listDirectory(dir, {
        directoriesOnly,
        showHidden,
      })
      // Stale response guard: a newer request fired while we were waiting.
      if (v !== reqVersionRef.current) return
      if (!result.ok) {
        setEntries([])
        return
      }
      setEntries(result.entries)
      setHighlighted(0)
    }, 60)
    return () => clearTimeout(t)
  }, [dir, directoriesOnly, showHidden])

  // Filtered + case-insensitive-startswith subset of entries that
  // actually match the current base token. Memoized so the render loop
  // doesn't re-filter on unrelated re-renders.
  const suggestions = useMemo(() => {
    if (!base) return entries.slice(0, MAX_SUGGESTIONS)
    const lower = base.toLowerCase()
    return entries
      .filter(e => e.name.toLowerCase().startsWith(lower))
      .slice(0, MAX_SUGGESTIONS)
  }, [entries, base])

  // Clamp highlighted when suggestions shrink.
  useEffect(() => {
    if (highlighted >= suggestions.length) setHighlighted(0)
  }, [highlighted, suggestions.length])

  // Apply a specific suggestion to the input value. Appends a trailing
  // slash for directories so the user can keep typing into the
  // completed path without reaching for the `/` key.
  const applySuggestion = useCallback(
    (entry: DirEntry) => {
      // Reconstruct the path: take the (parent) dir part of current
      // value and append the entry's name.
      // We use `dir` from the split, not `value`, so "/Users/jul" with
      // entry "julius" → "/Users/julius" (not "/Users/juljulius").
      const prefix = dir === '.' ? '' : dir
      const sep = prefix === '' || prefix.endsWith('/') ? '' : '/'
      const trail = entry.isDirectory ? '/' : ''
      onChange(prefix + sep + entry.name + trail)
      // Keep focus in the input so the user can keep typing.
      inputRef.current?.focus()
    },
    [dir, onChange],
  )

  // The dropdown is visible when we have suggestions AND the user
  // hasn't dismissed it. `dropdownOpen` is the single source of truth
  // every key / render path checks.
  const dropdownOpen = suggestions.length > 0 && !dismissed

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Stop propagation so global keybinds (⌘T, ⌘W, ⌥D, …) don't fire
    // while the user is typing / completing.
    e.stopPropagation()

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!dropdownOpen) {
        // Re-open with the first item highlighted — lets the user
        // press ↓ to "peek" at suggestions after dismissing once.
        if (suggestions.length > 0) {
          setDismissed(false)
          setHighlighted(0)
        }
        return
      }
      setHighlighted(i => (i + 1) % suggestions.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!dropdownOpen) return
      setHighlighted(i => (i - 1 + suggestions.length) % suggestions.length)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (suggestions.length === 0) return
      // Tab always operates on suggestions, even when the dropdown is
      // hidden — users expect tab-complete to work regardless of
      // dropdown visibility. Applying also re-opens the dropdown so
      // they can see the next level of completion.
      setDismissed(false)
      applySuggestion(suggestions[highlighted] ?? suggestions[0])
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onSubmit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (dropdownOpen) {
        // First Escape: dismiss the dropdown but stay in the modal.
        // User can press Escape again to actually cancel the modal,
        // or keep typing / interacting with whatever was behind.
        setDismissed(true)
        return
      }
      onCancel()
      return
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        className={inputClassName}
        style={inputStyle}
        value={value}
        onChange={e => {
          // Typing re-opens the dropdown — if the user dismissed
          // before and then started typing again, they clearly want
          // to see suggestions for the new prefix.
          if (dismissed) setDismissed(false)
          onChange(e.target.value)
        }}
        onFocus={() => {
          // Refocusing the input after a click-outside should bring
          // the dropdown back. If the user wants it gone they press
          // Escape.
          if (dismissed) setDismissed(false)
        }}
        onBlur={() => {
          // When focus leaves the input (the user clicked somewhere
          // else in the modal — a resume row, the cancel button, the
          // new session button), hide the dropdown so it doesn't
          // overlap whatever they're about to interact with. Clicking
          // the dropdown items themselves does NOT trigger blur
          // because the item handler calls e.preventDefault() on
          // mousedown.
          setDismissed(true)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {dropdownOpen && (
        <div
          className={`
            absolute left-0 right-0 top-full mt-1 z-50
            bg-surface border border-border-hi
            max-h-[280px] overflow-auto
            shadow-[0_10px_30px_rgba(0,0,0,0.4)]
            ${dropdownClassName}
          `}
        >
          {suggestions.map((s, i) => {
            const active = i === highlighted
            return (
              <div
                key={s.path}
                // onMouseDown (not onClick) so the input doesn't blur
                // before the handler runs. Clicks on the dropdown item
                // shouldn't lose focus from the input.
                onMouseDown={e => {
                  e.preventDefault()
                  applySuggestion(s)
                }}
                onMouseEnter={() => setHighlighted(i)}
                className={`
                  flex items-center gap-2
                  px-3 py-1.5 text-[11.5px] font-code cursor-pointer
                  transition-colors duration-75
                  ${
                    active
                      ? 'bg-accent-soft text-ink'
                      : 'text-ink-dim hover:bg-surface-hi'
                  }
                `}
              >
                <span
                  className={`
                    text-[10px] w-3 inline-block
                    ${active ? 'text-accent' : 'text-muted'}
                  `}
                >
                  {s.isDirectory ? '▸' : '·'}
                </span>
                <span className="flex-1 truncate">
                  {s.name}
                  {s.isDirectory ? '/' : ''}
                </span>
              </div>
            )
          })}
          {suggestions.length === MAX_SUGGESTIONS && (
            <div className="px-3 py-1 text-[10px] text-muted border-t border-border">
              showing {MAX_SUGGESTIONS} of many — keep typing to narrow
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_SUGGESTIONS = 80

/**
 * Split raw user input into the directory to list and the base token
 * to filter by. Mirrors the behavior shells use for path completion.
 *
 *   ""             → { dir: "~",        base: "" }     home dir, no filter
 *   "~"            → { dir: "~",        base: "" }     same
 *   "~/"           → { dir: "~",        base: "" }     same
 *   "~/Desk"       → { dir: "~",        base: "Desk" }
 *   "~/Desktop/"   → { dir: "~/Desktop", base: "" }
 *   "~/Desktop/dv" → { dir: "~/Desktop", base: "dv" }
 *   "/Users/jul"   → { dir: "/Users",    base: "jul" }
 *   "/Users/"      → { dir: "/Users",    base: "" }
 *   "/"            → { dir: "/",         base: "" }
 *   "rel/path"     → { dir: "rel",       base: "path" }   (relative — main resolves)
 *   "rel"          → { dir: ".",         base: "rel" }
 */
function splitPath(raw: string): { dir: string; base: string } {
  if (!raw) return { dir: '~', base: '' }
  if (raw === '~') return { dir: '~', base: '' }
  if (raw === '/') return { dir: '/', base: '' }

  // Trailing slash → list that directory, no filter.
  if (raw.endsWith('/')) {
    const dir = raw.slice(0, -1)
    return { dir: dir === '' ? '/' : dir, base: '' }
  }

  const lastSlash = raw.lastIndexOf('/')
  if (lastSlash === -1) {
    // No slash at all → relative single-segment, filter current dir.
    return { dir: '.', base: raw }
  }
  if (lastSlash === 0) {
    // "/foo" — dir is root, filter is "foo".
    return { dir: '/', base: raw.slice(1) }
  }
  return {
    dir: raw.slice(0, lastSlash),
    base: raw.slice(lastSlash + 1),
  }
}
