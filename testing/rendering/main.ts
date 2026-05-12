// Rendering-debug harness — dedicated Electron main process.
//
// Setup constraint (NOT an Agent Code bug; see README → "Harness
// architecture notes"). The harness does NOT load `src/main/index.ts`
// because that entrypoint boots tmux detection (noisy startup logs:
// "[tmux] available", "[tmux] recovery: 2 recoverable"), workspace
// persistence, switch-provider, LSP, fs helpers, git status — all
// log noise + timing variance that obscures real rendering bugs.
//
// This file is the minimum surface the harness renderer talks to:
// SessionManager + the IPC channels it actually invokes. Everything
// else is stubbed in registerIpc so the unmodified preload bridge
// keeps working without rejecting calls.
//
// What this main DOES need (the rendering pipeline):
//   1. Spawn an agent session (Claude/Codex) via SessionManager.
//   2. Force useProxy=true on Claude so the proxy SSE adapter
//      drives semantic events. The whole point of this harness is
//      to compare proxy/screen/jsonl layers side by side; without
//      proxy the semantic panel only ever shows screen-fallback.
//   3. Forward exactly the IPC channels the harness renderer + the
//      shared Feed call into. Stub the rest as no-ops so the shared
//      preload bridge keeps working.
//   4. Coalesce jsonl-entry bursts into session:jsonl-entries — same
//      reason main does it: bootstrapTail fires ~200 entries
//      synchronously and forwarding each as a separate IPC message
//      makes the renderer pay 200 React renders for what should be
//      one append.
//
// What we explicitly stub:
//   - tmux registry        — terminals are out of scope
//   - workspace persistence — the harness doesn't keep state
//   - lsp                   — code blocks degrade to static highlight
//   - switch-provider       — out of scope
//   - git, fs, image save   — not used by Feed in this harness
//
// Stubs return shape-compatible no-ops so the unmodified preload
// bridge never rejects a call and the renderer doesn't see
// "no handler registered" errors.

import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { readdir, readFile, stat } from 'fs/promises'

import { SessionManager } from '@main/sessionManager.js'
import {
  listAllClaudeSessions,
  type SessionInfo as ClaudeSessionInfo,
} from '@providers/claude/runtime/sessionList.js'
import {
  listCodexSessions,
  type CodexSessionInfo,
} from '@providers/codex/runtime/sessionList.js'
import { getMainProvider } from '@providers/registry.main.js'

type AgentKind = 'claude' | 'codex'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

// SessionManager constructed with no tmux registry — the harness
// never spawns terminal sessions, so detection would just print log
// lines for nothing. This keeps the harness boot quiet.
const manager: SessionManager = new SessionManager(null)

// --- IPC sender ----------------------------------------------------

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

// --- jsonl-entries coalescer (mirrored from src/main/index.ts) -----
//
// WHY: bootstrapTail synchronously emits ~200 jsonl-entry events on
// resume. One IPC send per event = 200 renderer renders. Coalesce
// each setImmediate tick into a single bulk delivery. Live single
// entries become 1-element bulk arrays — same channel, same shape.

type PendingJsonlBuffer = {
  entries: Array<{ entry: Record<string, unknown>; file: string }>
  flushScheduled: boolean
}

const jsonlPending = new Map<string, PendingJsonlBuffer>()

function flushJsonlFor(sessionId: string): void {
  const pending = jsonlPending.get(sessionId)
  if (!pending) return
  pending.flushScheduled = false
  if (pending.entries.length === 0) return
  const payload = { sessionId, entries: pending.entries }
  pending.entries = []
  send('session:jsonl-entries', payload)
}

function enqueueJsonl(
  sessionId: string,
  entry: Record<string, unknown>,
  file: string,
): void {
  let pending = jsonlPending.get(sessionId)
  if (!pending) {
    pending = { entries: [], flushScheduled: false }
    jsonlPending.set(sessionId, pending)
  }
  pending.entries.push({ entry, file })
  if (!pending.flushScheduled) {
    pending.flushScheduled = true
    setImmediate(() => flushJsonlFor(sessionId))
  }
}

// --- Manager → IPC wiring ------------------------------------------

function wireManager(): void {
  manager.on('started', p => send('session:started', p))
  manager.on('screen', p => send('session:screen', p))
  manager.on('jsonl-entry', p => enqueueJsonl(p.sessionId, p.entry as Record<string, unknown>, p.file))
  manager.on('jsonl-error', ({ sessionId, error }) =>
    send('session:jsonl-error', { sessionId, message: String(error.message ?? error) }),
  )
  manager.on('process-state', p => send('session:process-state', p))
  manager.on('trust-dialog', p => send('session:trust-dialog', p))
  manager.on('resume-prompt', p => send('session:resume-prompt', p))
  manager.on('compaction-state', p => send('session:compaction-state', p))
  manager.on('semantic-event', p => send('session:semantic-event', p))
  manager.on('exit', p => {
    flushJsonlFor(p.sessionId)
    jsonlPending.delete(p.sessionId)
    send('session:exit', p)
  })
}

// --- Older-history loader (ported from src/main/index.ts) ----------
//
// Walks the on-disk JSONL backwards from a known marker so the
// renderer can prepend earlier history when the user scrolls up.

async function findCodexRolloutPathByThreadId(
  sessionsDir: string,
  threadId: string,
): Promise<string | null> {
  try {
    const years = await readdir(sessionsDir)
    for (const year of years.sort().reverse()) {
      const yearDir = join(sessionsDir, year)
      if (!(await stat(yearDir).catch(() => null))?.isDirectory()) continue
      const months = await readdir(yearDir)
      for (const month of months.sort().reverse()) {
        const monthDir = join(yearDir, month)
        if (!(await stat(monthDir).catch(() => null))?.isDirectory()) continue
        const days = await readdir(monthDir)
        for (const day of days.sort().reverse()) {
          const dayDir = join(monthDir, day)
          if (!(await stat(dayDir).catch(() => null))?.isDirectory()) continue
          const files = await readdir(dayDir)
          const match = files.find(f => f.includes(threadId) && f.endsWith('.jsonl'))
          if (match) return join(dayDir, match)
        }
      }
    }
  } catch {
    return null
  }
  return null
}

function extractClaudeMarker(entry: Record<string, unknown>): string | null {
  if (typeof entry.uuid === 'string' && entry.uuid.length > 0) return entry.uuid
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  return typeof embedded?.uuid === 'string' && embedded.uuid.length > 0 ? embedded.uuid : null
}

function extractCodexMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(
    payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type,
  )}`
}

async function loadOlderHistoryChunk(params: {
  kind: AgentKind
  cwd: string
  providerSessionId: string
  beforeMarker: string
  limit: number
}): Promise<{ entries: Record<string, unknown>[]; hasMore: boolean }> {
  const provider = getMainProvider(params.kind)
  let filePath: string | null = null

  if (params.kind === 'claude') {
    const projectDir = await provider.getProjectDir(params.cwd)
    filePath = join(projectDir, `${params.providerSessionId}.jsonl`)
  } else {
    const sessionsDir = await provider.getProjectDir(params.cwd)
    filePath = await findCodexRolloutPathByThreadId(sessionsDir, params.providerSessionId)
  }

  if (!filePath) return { entries: [], hasMore: false }
  const text = await readFile(filePath, 'utf8').catch(() => null)
  if (!text) return { entries: [], hasMore: false }

  const parsed = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)

  const markerOf = params.kind === 'claude' ? extractClaudeMarker : extractCodexMarker
  const anchorIndex = parsed.findIndex(e => markerOf(e) === params.beforeMarker)
  const cutoff = anchorIndex === -1 ? parsed.length : anchorIndex
  const older = parsed.slice(0, cutoff)
  if (older.length === 0) return { entries: [], hasMore: false }
  const start = Math.max(0, older.length - params.limit)
  return { entries: older.slice(start), hasMore: start > 0 }
}

// --- IPC handlers --------------------------------------------------

function registerIpc(): void {
  // Real handlers — what the rendering pipeline calls.

  ipcMain.handle(
    'session:spawn',
    async (
      _evt,
      options: {
        kind?: AgentKind | 'terminal'
        cwd: string
        cols?: number
        rows?: number
        resumeSessionId?: string
        dangerousMode?: boolean
        useProxy?: boolean
      },
    ) => {
      const kind: AgentKind = options.kind === 'codex' ? 'codex' : 'claude'
      // Force proxy on by default. The whole purpose of the harness is
      // to surface the proxy SSE pipeline so we can compare it against
      // jsonl + screen. The caller can still pass useProxy:false to
      // explicitly opt out (useful when bisecting whether a bug is in
      // the proxy adapter vs the screen path).
      const useProxy = options.useProxy ?? true
      return await manager.spawn({
        kind,
        cwd: options.cwd,
        cols: options.cols ?? 160,
        rows: options.rows ?? 48,
        resumeSessionId: options.resumeSessionId,
        dangerousMode: options.dangerousMode,
        useProxy,
      })
    },
  )

  ipcMain.handle('session:kill', async (_evt, sessionId: string) => {
    return await manager.kill(sessionId)
  })

  ipcMain.handle('session:input', (_evt, sessionId: string, data: string) => {
    return manager.write(sessionId, data)
  })

  ipcMain.handle(
    'session:resize',
    (_evt, sessionId: string, cols: number, rows: number) => {
      manager.resize(sessionId, cols, rows)
    },
  )

  ipcMain.handle('session:list-all', async (_evt, limit?: number) => {
    const cap = typeof limit === 'number' && limit > 0 ? limit : 200
    const [claude, codex] = await Promise.all([
      listAllClaudeSessions({ limit: cap }).catch<ClaudeSessionInfo[]>(() => []),
      listCodexSessions({ limit: cap }).catch<CodexSessionInfo[]>(() => []),
    ])
    const tagged = [
      ...claude.map(s => ({ ...s, provider: 'claude' as const })),
      ...codex.map(s => ({ ...s, provider: 'codex' as const })),
    ]
    tagged.sort((a, b) => b.lastModified - a.lastModified)
    return tagged.slice(0, cap)
  })

  ipcMain.handle(
    'session:load-older-history',
    async (
      _evt,
      params: {
        kind: AgentKind
        cwd: string
        providerSessionId: string
        beforeMarker: string
        limit?: number
      },
    ) => loadOlderHistoryChunk({ ...params, limit: params.limit ?? 200 }),
  )

  // Stubs — required so the unmodified preload bridge doesn't reject.
  // Each returns the most-benign shape its caller expects.

  ipcMain.handle('session:list-for-cwd', async () => [])
  ipcMain.handle('session:switch-provider', async () => {
    throw new Error('switch-provider is disabled in the rendering harness')
  })
  ipcMain.handle('session:terminal-attach', () => '')

  ipcMain.handle('lsp:ensure-legend', async () => null)
  ipcMain.handle('lsp:open-document', async () => undefined)
  ipcMain.handle('lsp:change-document', async () => undefined)
  ipcMain.handle('lsp:close-document', async () => undefined)
  ipcMain.handle('lsp:get-semantic-tokens', async () => null)

  ipcMain.handle('workspace:load', async () => null)
  ipcMain.handle('workspace:save', async () => undefined)
  ipcMain.handle('workspace:defaultCwd', () => homedir())

  ipcMain.handle('fs:expandCwd', async (_evt, raw: string) => {
    if (typeof raw !== 'string' || raw.length === 0) {
      return { ok: false, error: 'empty path' }
    }
    const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    return { ok: true, path: expanded }
  })

  ipcMain.handle('fs:listDirectory', async () => ({
    ok: true,
    entries: [],
    expanded: '',
  }))

  ipcMain.handle('fs:saveClaudeImage', async () => ({ path: '' }))

  ipcMain.handle('git:status', async () => ({ ok: false }))
}

// --- Window --------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#111111',
    title: 'Agent Code rendering debug',
    autoHideMenuBar: true,
    webPreferences: {
      // Reuse the existing preload bridge so the renderer's
      // `window.api` shape matches the main app exactly. All channels
      // it calls are either real handlers above or stubs.
      preload: join(__dirname, '@preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- App lifecycle -------------------------------------------------

app.whenReady().then(() => {
  wireManager()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
