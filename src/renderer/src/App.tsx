import { useEffect, useRef, useState } from 'react'
import { Feed } from './feed/Feed'
import type { Entry } from '../../core/types/transcript'

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [screen, setScreen] = useState('')
  const [input, setInput] = useState('')
  const [exited, setExited] = useState<number | null>(null)
  const [entryCount, setEntryCount] = useState(0)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(true)
  // True between "user pressed Enter" and "an assistant entry lands in JSONL".
  // While true, we render a streaming card in the feed sourced from the screen
  // buffer. JSONL doesn't stream — only complete turns are written — so this
  // is the only way to show in-flight tokens.
  const [awaitingAssistant, setAwaitingAssistant] = useState(false)
  const seenUuids = useRef<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const screenRef = useRef<HTMLPreElement>(null)

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
      // The moment any assistant entry shows up, the streaming preview is
      // stale — the structured version is now in the feed.
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

  // Auto-scroll the live preview to the bottom on each update.
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
    <div className="app">
      <header className="bar">
        <div className="title">cc-shell</div>
        <div className="header-meta">
          <button
            type="button"
            className="toggle-btn"
            onClick={() => setShowTerminal(s => !s)}
            title="show / hide live terminal preview"
          >
            {showTerminal ? '▼' : '▶'} terminal
          </button>
          <span className="entries" title={projectDir ?? 'no project dir yet'}>
            jsonl: {entryCount}
          </span>
          <span className={`status ${exited === null ? 'ok' : 'dead'}`}>
            {exited === null ? '● running' : `○ exited (${exited})`}
          </span>
        </div>
      </header>

      <main className="feed-wrap">
        <Feed entries={entries} streamingScreen={awaitingAssistant ? screen : null} />
      </main>

      {showTerminal && (
        <section className="preview-wrap">
          <div className="preview-label">live preview · raw terminal</div>
          <pre ref={screenRef} className="preview-screen">
            {screen || ' '}
          </pre>
        </section>
      )}

      <footer className="composer">
        <input
          ref={inputRef}
          className="prompt"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type and press Enter…  (Esc · Ctrl-C · Ctrl-D · ↑ ↓ · Tab)"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </footer>
    </div>
  )
}
