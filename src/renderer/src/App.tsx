import { useEffect, useRef, useState } from 'react'
import { Feed } from './feed/Feed'
import { TrustDialogModal } from './feed/TrustDialogModal'
import { ThemePicker } from './feed/ThemePicker'
import type { Entry } from '../../core/types/transcript'
import { extractAssistantInProgress } from '../../core/parsers/streamingScreen'
import { applyTheme, loadSettings, type Settings } from './themes'

// Apply the persisted settings BEFORE the first render so initial paint
// uses the right theme. Pure DOM mutation, not React state.
applyTheme(loadSettings())

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [screen, setScreen] = useState('')
  const [input, setInput] = useState('')
  const [exited, setExited] = useState<number | null>(null)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [awaitingAssistant, setAwaitingAssistant] = useState(false)
  const [streamingBaseline, setStreamingBaseline] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>(loadSettings())
  const seenUuids = useRef<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const screenRef = useRef<HTMLPreElement>(null)
  const latestScreenRef = useRef<string>('')

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

  const running = exited === null

  return (
    <div className="h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
      {/* ---------- Header: minimal. App name on left, status + settings on right ---------- */}
      <header
        className="
          flex items-center justify-between
          px-4 py-2
          border-b border-border
          select-none flex-shrink-0
          [-webkit-app-region:drag]
        "
      >
        <div className="flex items-center gap-2 pl-[68px]">
          <span className="text-[12px] font-semibold tracking-wide text-ink">
            cc-shell
          </span>
        </div>

        <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
          <span
            className="flex items-center gap-1.5 text-[11px] text-muted"
            title={projectDir ?? 'no project dir yet'}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-accent streaming-dot' : 'bg-muted'}`}
            />
            <span className="tabular-nums">
              {running ? 'running' : `exited ${exited}`}
            </span>
          </span>

          <ThemePicker settings={settings} onChange={setSettings} />
        </div>
      </header>

      {/* ---------- Feed ---------- */}
      <main className="flex-1 overflow-auto min-h-0">
        <Feed
          entries={entries}
          streamingScreen={awaitingAssistant ? screen : null}
          streamingBaseline={streamingBaseline}
          showSystemEvents={settings.showSystemEvents}
        />
      </main>

      {/* ---------- Live terminal preview (debug, togglable via settings) ---------- */}
      {settings.showTerminalPreview && (
        <section className="flex-shrink-0 border-t border-border bg-surface px-4 pt-2 pb-3 max-h-[200px] overflow-hidden flex flex-col">
          <div className="text-[9px] uppercase tracking-[0.15em] text-muted mb-1.5">
            live preview · raw terminal
          </div>
          <pre
            ref={screenRef}
            className="flex-1 overflow-auto text-[11px] leading-[1.45] text-ink-dim whitespace-pre opacity-75"
          >
            {screen || ' '}
          </pre>
        </section>
      )}

      {/* ---------- Composer ---------- */}
      <footer className="flex-shrink-0 border-t border-border px-4 py-3">
        <div className="relative max-w-[880px] mx-auto">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-accent text-[13px] pointer-events-none select-none">
            ❯
          </div>
          <input
            ref={inputRef}
            className="
              w-full
              bg-surface border border-border
              text-ink text-[13px]
              pl-8 pr-3 py-2.5
              outline-none
              placeholder:text-muted
              focus:border-border-hi
              transition-colors duration-150
            "
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="type and press enter…  esc · ctrl-c · ctrl-d · ↑ ↓ · tab"
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </footer>

      <TrustDialogModal screen={screen} onSend={sendKey} />
    </div>
  )
}
