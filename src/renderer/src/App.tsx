import { useEffect, useRef, useState } from 'react'
import { Feed } from './feed/Feed'
import { TrustDialogModal } from './feed/TrustDialogModal'
import { ThemePicker } from './feed/ThemePicker'
import type { Entry } from '../../core/types/transcript'
import { extractAssistantInProgress } from '../../core/parsers/streamingScreen'
import { applyTheme, loadThemeFromStorage, type ThemeId } from './themes'

// Apply the persisted theme BEFORE the first render so the initial paint
// uses the right tokens. If we did this in useEffect the user would see
// a flash of the default theme before their saved one snapped in — the
// classic FOUC. applyTheme is a pure DOM mutation, not React state, so
// we can call it directly at module evaluation time.
applyTheme(loadThemeFromStorage())

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [screen, setScreen] = useState('')
  const [input, setInput] = useState('')
  const [exited, setExited] = useState<number | null>(null)
  const [entryCount, setEntryCount] = useState(0)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(true)
  const [awaitingAssistant, setAwaitingAssistant] = useState(false)
  const [streamingBaseline, setStreamingBaseline] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeId>(loadThemeFromStorage())
  const seenUuids = useRef<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const screenRef = useRef<HTMLPreElement>(null)
  const latestScreenRef = useRef<string>('')

  // Mirror `screen` into a ref so the Enter handler can read the freshest
  // value synchronously without being recreated 60 times per second.
  useEffect(() => {
    latestScreenRef.current = screen
  }, [screen])

  useEffect(() => {
    const offScreen = window.api.onScreen(setScreen)
    const offExit = window.api.onExit(code => setExited(code))
    const offEntry = window.api.onJsonlEntry(({ entry }) => {
      const uuid = (entry as { uuid?: string }).uuid
      if (uuid) {
        if (seenUuids.current.has(uuid)) return
        seenUuids.current.add(uuid)
      }
      setEntries(prev => [...prev, entry as Entry])
      setEntryCount(c => c + 1)
      if ((entry as { type?: string }).type === 'assistant') {
        setAwaitingAssistant(false)
      }
    })
    const offProjectDir = window.api.onJsonlProjectDir(setProjectDir)
    const offJsonlError = window.api.onJsonlError(msg => {
      // eslint-disable-next-line no-console
      console.warn('[jsonl] error:', msg)
    })
    return () => {
      offScreen()
      offExit()
      offEntry()
      offProjectDir()
      offJsonlError()
    }
  }, [])

  useEffect(() => {
    const el = screenRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [screen])

  const sendKey = async (data: string) => {
    await window.api.sendInput(data)
  }

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const baseline = extractAssistantInProgress(latestScreenRef.current)
      setStreamingBaseline(baseline)
      await sendKey(input + '\r')
      setInput('')
      setAwaitingAssistant(true)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      await sendKey('\x1b')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      await sendKey('\x03')
      setInput('')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      await sendKey('\x04')
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      await sendKey('\x1b[A')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      await sendKey('\x1b[B')
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      await sendKey('\t')
      return
    }
  }

  return (
    <div className="h-screen flex flex-col bg-canvas text-ink font-body min-h-0">
      {/* ---------- Header ---------- */}
      <header
        className="
          flex items-center justify-between
          px-4 py-2.5
          bg-surface border-b border-border
          select-none flex-shrink-0
          [-webkit-app-region:drag]
        "
      >
        <div className="flex items-baseline gap-3 pl-[68px]">
          <span className="font-display text-[15px] font-semibold tracking-tight text-ink leading-none">
            cc-shell
          </span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted font-code">
            {theme}
          </span>
        </div>

        <div className="flex items-center gap-2.5 [-webkit-app-region:no-drag]">
          <ThemePicker current={theme} onChange={setTheme} />

          <button
            type="button"
            onClick={() => setShowTerminal(s => !s)}
            title="show / hide live terminal preview"
            className="
              flex items-center gap-1.5 px-2.5 py-1
              text-[11px] text-ink-dim
              rounded-md border border-border
              hover:border-border-hi hover:text-ink
              transition-colors duration-150
            "
          >
            <span className="font-code font-medium">
              {showTerminal ? '▼' : '▶'} terminal
            </span>
          </button>

          <span
            className="font-code text-[11px] text-muted tabular-nums px-2 py-1"
            title={projectDir ?? 'no project dir yet'}
          >
            jsonl: {entryCount}
          </span>

          <StatusDot exited={exited} />
        </div>
      </header>

      {/* ---------- Feed ---------- */}
      <main className="flex-1 overflow-auto min-h-0">
        <Feed
          entries={entries}
          streamingScreen={awaitingAssistant ? screen : null}
          streamingBaseline={streamingBaseline}
        />
      </main>

      {/* ---------- Live terminal preview (togglable debug pane) ---------- */}
      {showTerminal && (
        <section
          className="
            flex-shrink-0
            border-t border-border
            bg-surface
            px-4 pt-2 pb-3
            max-h-[220px] overflow-hidden
            flex flex-col
          "
        >
          <div className="text-[9px] uppercase tracking-[0.15em] text-muted mb-1.5 font-code">
            live preview · raw terminal
          </div>
          <pre
            ref={screenRef}
            className="
              flex-1 overflow-auto
              font-code text-[11px] leading-[1.45]
              text-ink-dim whitespace-pre
              opacity-75
            "
          >
            {screen || ' '}
          </pre>
        </section>
      )}

      {/* ---------- Composer ---------- */}
      <footer className="flex-shrink-0 border-t border-border bg-surface px-4 py-3">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 font-code text-accent text-[13px] pointer-events-none">
            ❯
          </div>
          <input
            ref={inputRef}
            className="
              w-full
              bg-canvas border border-border rounded-lg
              text-ink font-code text-[13px]
              pl-8 pr-3 py-2.5
              outline-none
              placeholder:text-muted
              focus:border-border-hi
              transition-colors duration-150
            "
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type and press Enter…  (Esc · Ctrl-C · Ctrl-D · ↑ ↓ · Tab)"
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </footer>

      {/* ---------- Trust dialog overlay ---------- */}
      <TrustDialogModal screen={screen} onSend={sendKey} />
    </div>
  )
}

function StatusDot({ exited }: { exited: number | null }) {
  const running = exited === null
  return (
    <span
      className={`
        flex items-center gap-1.5 text-[11px] tabular-nums font-code px-2 py-1
        ${running ? 'text-accent' : 'text-muted'}
      `}
    >
      <span
        className={`
          inline-block w-1.5 h-1.5 rounded-full
          ${running ? 'bg-accent streaming-dot' : 'bg-muted'}
        `}
      />
      {running ? 'running' : `exited (${exited})`}
    </span>
  )
}
