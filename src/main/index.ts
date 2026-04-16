import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { dirname, extname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises'
import { homedir } from 'os'

import { SessionManager } from './sessionManager.js'
import { LspManager } from './lspManager.js'
import { TmuxRegistry } from './tmux/TmuxRegistry.js'
import { reconcile, type PersistedTerminalRef } from './tmux/tmuxRecovery.js'
import { getMainProvider } from '../providers/registry.main.js'
import { switchProvider } from './providerSwitch/switchProvider.js'
import { listAllClaudeSessions } from '../providers/claude/runtime/sessionList.js'
import { listCodexSessions } from '../providers/codex/runtime/sessionList.js'

// Main process — thin Electron host over SessionManager.
//
// Responsibilities:
//   1. Create the BrowserWindow.
//   2. Own ONE SessionManager instance for the lifetime of the app.
//   3. Forward every session event to the renderer via sessionId-scoped
//      IPC channels.
//   4. Accept spawn / kill / write / resize commands from the renderer.
//   5. Load + save the workspace state JSON (tile tree + cwds).
//   6. Kill all sessions cleanly on app quit.
//
// The tile tree itself lives in the renderer — main has no idea what a
// "tab" or a "split" is. It just manages PTYs and shuffles bytes.

const __dirname = dirname(fileURLToPath(import.meta.url))

// Path to the workspace state file. Follows XDG on Linux but uses
// ~/.config on macOS too (it's simpler than mirroring Electron's
// per-platform userData logic and the file is tiny).
const STATE_DIR = join(homedir(), '.config', 'cc-shell')
const STATE_FILE = join(STATE_DIR, 'workspace.json')

let mainWindow: BrowserWindow | null = null

/**
 * Push the traffic light (close/minimize/zoom) right-edge inset to the
 * renderer as a CSS custom property. The renderer uses this to pad the
 * tab bar so tabs don't sit under the buttons — zoom-safe, scale-safe,
 * no magic pixel values.
 *
 * On non-macOS platforms or when the position isn't available, falls
 * back to 0 (no inset needed — the title bar is separate).
 */
function pushTrafficLightInset(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // getWindowButtonPosition returns { x, y } of the top-left of the
  // FIRST button (close). The three buttons are each ~14px wide with
  // ~6px gaps, arranged left-to-right: close, minimize, zoom. The
  // right edge of the zoom button is roughly x + 68 CSS pixels at 1x
  // scale. But we want to be precise, so we add a comfortable margin
  // past the reported x position. The x value already accounts for
  // the hiddenInset padding.
  try {
    const pos = mainWindow.getWindowButtonPosition()
    if (pos) {
      // pos.x is the left edge of the close button. The three buttons
      // span ~54px total, plus we want ~8px breathing room after the
      // last button. Round up to avoid sub-pixel clipping.
      const inset = Math.ceil(pos.x + 62)
      mainWindow.webContents.send('traffic-light-inset', inset)
    }
  } catch {
    // getWindowButtonPosition throws on non-macOS. Silently skip —
    // the renderer defaults to 0.
  }
}
// SessionManager is constructed inside whenReady so we can await
// TmuxRegistry.detectAvailability() first — terminal sessions need
// to know during spawn whether a tmux backend is available, and
// detection requires a child-process roundtrip. The 'let' is
// load-bearing: every other module-scope reference is inside
// callbacks that fire after the assignment.
let manager: SessionManager = null as unknown as SessionManager
let tmuxRegistry: TmuxRegistry | null = null
const lspManager = new LspManager()

function extractClaudeHistoryMarker(entry: Record<string, unknown>): string | null {
  if (typeof entry.uuid === 'string' && entry.uuid.length > 0) return entry.uuid
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  return typeof embedded?.uuid === 'string' && embedded.uuid.length > 0
    ? embedded.uuid
    : null
}

function extractCodexHistoryMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}

async function findCodexRolloutPathByThreadId(
  sessionsDir: string,
  threadId: string,
): Promise<string | null> {
  try {
    const years = await readdir(sessionsDir)
    for (const year of years.sort().reverse()) {
      const yearDir = join(sessionsDir, year)
      const yStat = await stat(yearDir).catch(() => null)
      if (!yStat?.isDirectory()) continue
      const months = await readdir(yearDir)
      for (const month of months.sort().reverse()) {
        const monthDir = join(yearDir, month)
        const mStat = await stat(monthDir).catch(() => null)
        if (!mStat?.isDirectory()) continue
        const days = await readdir(monthDir)
        for (const day of days.sort().reverse()) {
          const dayDir = join(monthDir, day)
          const dStat = await stat(dayDir).catch(() => null)
          if (!dStat?.isDirectory()) continue
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

async function loadOlderHistoryChunk(params: {
  kind: 'claude' | 'codex'
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
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null)

  const markerOf = params.kind === 'claude'
    ? extractClaudeHistoryMarker
    : extractCodexHistoryMarker

  const anchorIndex = parsed.findIndex(entry => markerOf(entry) === params.beforeMarker)
  const cutoff = anchorIndex === -1 ? parsed.length : anchorIndex
  const older = parsed.slice(0, cutoff)
  if (older.length === 0) return { entries: [], hasMore: false }

  const start = Math.max(0, older.length - params.limit)
  return {
    entries: older.slice(start),
    hasMore: start > 0,
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function extensionForMediaType(mediaType: string, filename?: string): string {
  const fromName = extname(filename ?? '').trim().toLowerCase()
  if (fromName) return fromName
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/png':
    default:
      return '.png'
  }
}

function getClaudeImageCacheDir(): string {
  return join(app.getPath('temp'), 'cc-shell', 'claude-images')
}

// Per-session jsonl-entry coalescer.
//
// WHY: on a resumed Claude/Codex session, the headless `bootstrapTail`
// parses the last ~200 lines from the JSONL file synchronously and
// emits one `jsonl-entry` event per line. Forwarding each as its own
// IPC `webContents.send` produced ~200 round-trips per pane × N panes
// on restart — which on the renderer side became 200N React renders,
// 200N O(N) spreads, and 200N auto-scroll pins. That's the "feels
// like I'm being scrolled through the whole conversation" bug.
//
// Coalescing: we buffer entries per sessionId, schedule ONE
// setImmediate flush, and deliver the whole burst as a single
// `session:jsonl-entries` payload. setImmediate (not Promise.resolve
// or process.nextTick) runs after the current I/O tick finishes, so
// the whole bootstrapTail loop drains before we schedule a send. Live
// mid-conversation entries land one per tick and are flushed
// immediately after — no added latency for the streaming path.
//
// Singular `session:jsonl-entry` is intentionally kept alive: any
// non-bulk consumer (tests, future single-entry subscribers) can
// still listen, and keeping both channels means this change is
// strictly additive from the renderer's perspective. The renderer
// subscribes to BOTH and picks whichever it prefers.
type PendingJsonlBuffer = {
  entries: Array<{ entry: import('claude-code-headless').JsonlEntry; file: string }>
  flushScheduled: boolean
}
const jsonlPending = new Map<string, PendingJsonlBuffer>()

function flushJsonlFor(sessionId: string): void {
  const pending = jsonlPending.get(sessionId)
  if (!pending || pending.entries.length === 0) return
  const payload = {
    sessionId,
    entries: pending.entries,
  }
  pending.entries = []
  pending.flushScheduled = false
  send('session:jsonl-entries', payload)
}

function enqueueJsonl(
  sessionId: string,
  entry: import('claude-code-headless').JsonlEntry,
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

// Wire every manager event to a matching IPC channel. Each payload
// carries the sessionId so the renderer can route to the right tile.
//
// Note: terminal-data is a new channel specific to plain shell
// sessions. Claude sessions use screen / jsonl-entry / jsonl-error
// to surface their structured state; terminal sessions just forward
// raw PTY bytes for xterm.js to render. Keeping them on separate
// channels avoids making every Claude pane listener unpack/ignore
// terminal bytes it doesn't care about.
function wireManagerIPC(): void {
  manager.on('started', payload => send('session:started', payload))
  manager.on('screen', payload => send('session:screen', payload))
  // Bulk-only forwarding. We used to dual-emit (singular +
  // coalesced) for "backward compatibility," but the singular IPC
  // queue beat the coalescer to the renderer on every burst —
  // 200 singular messages got processed first, the renderer's
  // singular handler did 200 separate setRuntimes calls, and by
  // the time the bulk message arrived the seenUuidsRef dedupe made
  // it a no-op. The user-visible result was the exact "scroll
  // through the whole conversation, takes 5 seconds" symptom we
  // were trying to fix.
  //
  // Now: every entry goes through enqueueJsonl. Live single
  // entries become 1-element bulk messages with ~1ms latency from
  // setImmediate — imperceptible. Bootstrap bursts coalesce into
  // one bulk delivery. The renderer subscribes ONLY to the bulk
  // channel.
  manager.on('jsonl-entry', payload => {
    enqueueJsonl(payload.sessionId, payload.entry, payload.file)
  })
  manager.on('jsonl-error', ({ sessionId, error }) =>
    send('session:jsonl-error', {
      sessionId,
      message: String(error.message ?? error),
    }),
  )
  manager.on('terminal-data', payload =>
    send('session:terminal-data', payload),
  )
  manager.on('process-state', payload => send('session:process-state', payload))
  manager.on('trust-dialog', payload => send('session:trust-dialog', payload))
  manager.on('resume-prompt', payload => send('session:resume-prompt', payload))
  manager.on('compaction-state', payload => send('session:compaction-state', payload))
  manager.on('semantic-event', payload => send('session:semantic-event', payload))
  manager.on('exit', payload => {
    // Final flush — any entries still buffered from the last
    // bootstrapTail tick must land before exit so the renderer sees a
    // consistent final entries list.
    flushJsonlFor(payload.sessionId)
    jsonlPending.delete(payload.sessionId)
    send('session:exit', payload)
  })
  lspManager.on('diagnostics', payload => send('lsp:diagnostics', payload))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    pushTrafficLightInset()
  })

  // Recompute the traffic light inset whenever the window geometry
  // changes — zoom level, display scale, fullscreen toggle. Electron
  // doesn't offer a "traffic light moved" event, but resize covers
  // every case that shifts them.
  mainWindow.on('resize', pushTrafficLightInset)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------- IPC handlers ----------

function registerIpc(): void {
  // --- Session lifecycle ---
  ipcMain.handle(
    'session:spawn',
    async (
      _evt,
      options: {
        kind?: 'claude' | 'codex' | 'terminal'
        cwd: string
        cols?: number
        rows?: number
        resumeSessionId?: string
        dangerousMode?: boolean
        useProxy?: boolean
      },
    ) => {
      return await manager.spawn(options)
    },
  )

  // --- Session listing for the resume picker ---
  //
  // Called by PathPickerModal when the user types a cwd — returns a
  // list of previous sessions in that directory so they can resume one
  // instead of starting fresh. Empty array when the cwd has no
  // recorded history yet.
  ipcMain.handle(
    'session:list-for-cwd',
    async (
      _evt,
      cwd: string,
      limit?: number,
      provider: 'claude' | 'codex' = 'claude',
    ) => {
      try {
        // Dispatch session listing through the provider registry.
        // Each provider's listSessions handles its own storage format.
        const providerConfig = getMainProvider(provider)
        return await providerConfig.listSessions(cwd, limit ?? 20)
      } catch (err) {
        // Don't let a listing error brick the modal — return empty.
        // eslint-disable-next-line no-console
        console.warn('[session:list-for-cwd] failed:', err)
        return []
      }
    },
  )

  // --- Global session listing (used by the rendering-debug harness) ---
  //
  // Returns every known Claude + Codex session across all project
  // dirs, newest first, tagged with provider. The main app routes
  // through `session:list-for-cwd` because it filters by the focused
  // pane's cwd; the harness needs a global list because it has no
  // notion of "current cwd".
  ipcMain.handle(
    'session:list-all',
    async (_evt, limit?: number) => {
      const cap = typeof limit === 'number' && limit > 0 ? limit : 200
      try {
        const [claude, codex] = await Promise.all([
          listAllClaudeSessions({ limit: cap }).catch(() => []),
          listCodexSessions({ limit: cap }).catch(() => []),
        ])
        const tagged = [
          ...claude.map(s => ({ ...s, provider: 'claude' as const })),
          ...codex.map(s => ({ ...s, provider: 'codex' as const })),
        ]
        tagged.sort((a, b) => b.lastModified - a.lastModified)
        return tagged.slice(0, cap)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[session:list-all] failed:', err)
        return []
      }
    },
  )

  ipcMain.handle(
    'session:load-older-history',
    async (
      _evt,
      params: {
        kind: 'claude' | 'codex'
        cwd: string
        providerSessionId: string
        beforeMarker: string
        limit?: number
      },
    ) => {
      return await loadOlderHistoryChunk({
        ...params,
        limit: params.limit ?? 200,
      })
    },
  )

  ipcMain.handle('session:kill', async (_evt, sessionId: string) => {
    return await manager.kill(sessionId)
  })

  ipcMain.handle(
    'session:switch-provider',
    async (
      _evt,
      params: {
        sourceKind: 'claude' | 'codex'
        sourceProviderSessionId: string
        cwd: string
      },
    ) => {
      return await switchProvider(params)
    },
  )

  // --- Terminal attach/replay ---
  //
  // Called once by TerminalLeaf on mount. Returns the full buffered
  // output of the terminal session so far, AND flips the manager's
  // "attached" flag so subsequent PTY data events broadcast live.
  //
  // The race being fixed: between the spawnSession IPC resolving
  // and TerminalLeaf's useEffect running, the shell has already
  // printed its prompt. Without this buffered replay the renderer
  // would see nothing but a blinking cursor — exactly the bug the
  // user reported. See the big block comment on
  // SessionManager.terminalBuffers for the full reasoning.
  ipcMain.handle('session:terminal-attach', (_evt, sessionId: string) => {
    return manager.attachTerminal(sessionId)
  })

  // --- Per-session I/O ---
  ipcMain.handle(
    'session:input',
    (_evt, sessionId: string, data: string) => {
      const ok = manager.write(sessionId, data)
      if (!ok) {
        // eslint-disable-next-line no-console
        console.warn('[session:input] dropped write for missing session', {
          sessionId,
          dataLength: data.length,
        })
      }
      return ok
    },
  )

  ipcMain.handle(
    'session:resize',
    (_evt, sessionId: string, cols: number, rows: number) => {
      manager.resize(sessionId, cols, rows)
    },
  )

  // --- LSP-backed code intelligence for Monaco code blocks ---
  ipcMain.handle(
    'lsp:ensure-legend',
    async (_evt, workspaceRoot: string, language: string) => {
      return await lspManager.ensureSemanticLegend(workspaceRoot, language)
    },
  )

  ipcMain.handle(
    'lsp:open-document',
    async (
      _evt,
      params: {
        clientUri: string
        content: string
        language: string
        workspaceRoot: string
        filePath?: string | null
      },
    ) => {
      await lspManager.openDocument(params)
    },
  )

  ipcMain.handle(
    'lsp:change-document',
    async (_evt, clientUri: string, content: string) => {
      await lspManager.changeDocument(clientUri, content)
    },
  )

  ipcMain.handle('lsp:close-document', async (_evt, clientUri: string) => {
    await lspManager.closeDocument(clientUri)
  })

  ipcMain.handle('lsp:get-semantic-tokens', async (_evt, clientUri: string) => {
    return await lspManager.getSemanticTokens(clientUri)
  })

  // --- Directory listing (used by PathInput for completion) ---
  // Given a directory path (raw user input that may include ~ or be
  // relative), return its entries as { name, isDirectory } for the
  // renderer to filter + display as a suggestion dropdown.
  //
  // Options:
  //   directoriesOnly — filter out regular files (default true for
  //                     cwd pickers, false for file pickers)
  //   showHidden      — include .dotfile entries (default false)
  //
  // Returns { ok: true, entries, expanded } on success — `expanded`
  // lets the renderer display the resolved path in the UI if it wants.
  // On failure (ENOENT, not a directory, EACCES, etc.) returns a
  // discriminated error the caller can show inline instead of throwing.
  type DirEntry = { name: string; isDirectory: boolean; path: string }
  type ListResult =
    | { ok: true; entries: DirEntry[]; expanded: string }
    | { ok: false; error: string }

  ipcMain.handle(
    'fs:listDirectory',
    async (
      _evt,
      rawPath: string,
      opts?: { directoriesOnly?: boolean; showHidden?: boolean },
    ): Promise<ListResult> => {
      const directoriesOnly = opts?.directoriesOnly ?? true
      const showHidden = opts?.showHidden ?? false

      // Expand ~ and resolve to absolute. Empty / `.` / `~` all mean
      // "home directory" — that's the natural starting point for path
      // completion in a picker.
      let expanded = rawPath.trim()
      if (expanded === '' || expanded === '~') {
        expanded = homedir()
      } else if (expanded.startsWith('~/')) {
        expanded = join(homedir(), expanded.slice(2))
      }
      expanded = resolve(expanded)

      try {
        const dirents = await readdir(expanded, { withFileTypes: true })
        const entries: DirEntry[] = []
        for (const d of dirents) {
          if (!showHidden && d.name.startsWith('.')) continue
          const isDirectory = d.isDirectory()
          if (directoriesOnly && !isDirectory) continue
          entries.push({
            name: d.name,
            isDirectory,
            path: join(expanded, d.name),
          })
        }
        // Sort: directories first, then alpha (case-insensitive).
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
        return { ok: true, entries, expanded }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return { ok: false, error: 'does not exist' }
        if (e.code === 'ENOTDIR') return { ok: false, error: 'not a directory' }
        if (e.code === 'EACCES') return { ok: false, error: 'permission denied' }
        return { ok: false, error: e.message ?? 'read failed' }
      }
    },
  )

  ipcMain.handle(
    'fs:saveClaudeImage',
    async (
      _evt,
      params: { base64Data: string; mediaType: string; filename?: string },
    ) => {
      const cacheDir = getClaudeImageCacheDir()
      await mkdir(cacheDir, { recursive: true })
      const ext = extensionForMediaType(params.mediaType, params.filename)
      const filePath = join(cacheDir, `${randomUUID()}${ext}`)
      await writeFile(filePath, Buffer.from(params.base64Data, 'base64'))
      return { path: filePath }
    },
  )

  // --- Path expansion + validation ---
  // Replaces the native folder picker. Renderer shows a text input
  // modal where the user types a path; we expand `~`, resolve to an
  // absolute path, and check that it exists and is a directory. If any
  // of that fails the renderer keeps the modal open and shows the
  // error inline.
  //
  // Why not the native dialog: user explicitly wanted a path writer,
  // not a clicky picker. Keyboard-first is faster for power users and
  // matches the rest of cc-shell's terminal-native vibe.
  ipcMain.handle(
    'fs:expandCwd',
    async (
      _evt,
      raw: string,
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      const trimmed = raw.trim()
      if (!trimmed) return { ok: false, error: 'path is empty' }
      // Tilde expansion. We ONLY expand bare `~` and `~/…` — not `~user`,
      // because that requires passwd lookup and nobody uses it.
      let expanded: string
      if (trimmed === '~') {
        expanded = homedir()
      } else if (trimmed.startsWith('~/')) {
        expanded = join(homedir(), trimmed.slice(2))
      } else {
        expanded = trimmed
      }
      const abs = resolve(expanded)
      try {
        const s = await stat(abs)
        if (!s.isDirectory()) {
          return { ok: false, error: 'not a directory' }
        }
        return { ok: true, path: abs }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return { ok: false, error: 'does not exist' }
        if (e.code === 'EACCES') return { ok: false, error: 'permission denied' }
        return { ok: false, error: e.message ?? 'stat failed' }
      }
    },
  )

  // --- Workspace state persistence ---
  // The renderer is the source of truth for the tile tree. We just
  // read / write bytes. Main doesn't interpret the JSON — that's the
  // renderer's concern.
  ipcMain.handle('workspace:load', async () => {
    try {
      const text = await readFile(STATE_FILE, 'utf8')
      return text
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return null // fresh install, no state yet
      throw err
    }
  })

  ipcMain.handle('workspace:save', async (_evt, json: string) => {
    await mkdir(STATE_DIR, { recursive: true })
    // Atomic write pattern: write to a temp sibling then rename. Keeps
    // us from corrupting the file if the process dies mid-write.
    const tmp = STATE_FILE + '.tmp'
    await writeFile(tmp, json, 'utf8')
    const { rename } = await import('fs/promises')
    await rename(tmp, STATE_FILE)
  })

  // --- Default cwd helper ---
  // Renderer calls this on first launch when there's no saved state
  // and no user-picked cwd yet. Returns the process's cwd (the project
  // the Electron app was launched from).
  ipcMain.handle('workspace:defaultCwd', () => {
    return process.env.CC_SHELL_CWD || process.cwd()
  })

  // --- Git info (used by GitBar) ---
  //
  // Runs git commands in a given cwd and returns structured data.
  // All commands are read-only — no mutations. Errors return empty
  // results so the UI degrades gracefully for non-git directories.

  ipcMain.handle('git:status', async (_evt, cwd: string) => {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const exec = promisify(execFile)

      // git diff --numstat gives us per-file +/- counts.
      // Includes both staged and unstaged changes.
      const { stdout: diffStat } = await exec(
        'git', ['diff', 'HEAD', '--numstat'],
        { cwd, timeout: 5000 },
      )

      const files: Array<{
        file: string
        additions: number
        deletions: number
      }> = []

      for (const line of diffStat.trim().split('\n')) {
        if (!line) continue
        const [add, del, file] = line.split('\t')
        if (!file) continue
        files.push({
          file,
          // Binary files show '-' for both counts.
          additions: add === '-' ? 0 : parseInt(add, 10) || 0,
          deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
        })
      }

      // Latest 5 commits: hash, subject, author, relative date.
      const { stdout: logOut } = await exec(
        'git',
        ['log', '--oneline', '--format=%h\t%s\t%an\t%cr', '-5'],
        { cwd, timeout: 5000 },
      )

      const commits: Array<{
        hash: string
        subject: string
        author: string
        relativeDate: string
      }> = []

      for (const line of logOut.trim().split('\n')) {
        if (!line) continue
        const [hash, subject, author, relativeDate] = line.split('\t')
        if (!hash) continue
        commits.push({
          hash,
          subject: subject ?? '',
          author: author ?? '',
          relativeDate: relativeDate ?? '',
        })
      }

      // Current branch name.
      const { stdout: branchOut } = await exec(
        'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd, timeout: 5000 },
      )

      return {
        ok: true as const,
        branch: branchOut.trim(),
        files,
        commits,
      }
    } catch {
      return { ok: false as const }
    }
  })
}

// ---------- App lifecycle ----------

app.whenReady().then(async () => {
  // Tmux availability is checked once at startup. The cost is a
  // child-process roundtrip on `tmux -V` — cheap enough to await
  // before any IPC is wired. Result is cached on the registry; call
  // sites use isAvailable() synchronously thereafter.
  tmuxRegistry = new TmuxRegistry()
  const tmuxAvailable = await tmuxRegistry.detectAvailability()
  console.log(
    tmuxAvailable
      ? '[tmux] available — terminals will persist across restarts'
      : '[tmux] not installed — terminals will use direct PTY (non-persistent)',
  )

  // Recovery runs BEFORE SessionManager is constructed so the
  // renderer's first session-spawn can ask to recover an alive
  // tmux session by name. Reads the persisted workspace.json
  // directly — it's the same file the renderer will load shortly via
  // workspace:load IPC, but we need the tmuxName values earlier.
  let recoveryReport: { recoverable: PersistedTerminalRef[]; lost: string[]; orphans: string[] } = {
    recoverable: [],
    lost: [],
    orphans: [],
  }
  if (tmuxAvailable) {
    try {
      const raw = await readFile(STATE_FILE, 'utf8')
      // workspace.json is wrapped: { workspace: { sessions: {...} } }.
      // The renderer's saveWorkspace() writes { workspace: workspaceState }
      // — so persisted sessions live one level deep, not at the root.
      // Reading parsed.sessions directly (as the original code did)
      // always returned undefined, which is why recovery silently
      // reported "0 recoverable" even when tmuxName WAS persisted.
      const parsed = JSON.parse(raw) as {
        workspace?: {
          sessions?: Record<string, { kind?: string; tmuxName?: string }>
        }
      }
      const persisted: PersistedTerminalRef[] = Object.entries(
        parsed.workspace?.sessions ?? {},
      )
        .filter(([, meta]) => meta?.kind === 'terminal' && typeof meta?.tmuxName === 'string')
        .map(([sessionId, meta]) => ({ sessionId, tmuxName: meta!.tmuxName! }))
      recoveryReport = await reconcile(tmuxRegistry, persisted)
      console.log(
        `[tmux] recovery: ${recoveryReport.recoverable.length} recoverable, ${recoveryReport.lost.length} lost, ${recoveryReport.orphans.length} orphans cleaned`,
      )
    } catch (err) {
      // Missing/corrupt workspace.json is fine — fresh launch falls
      // through with empty buckets. Log so a real failure is visible.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[tmux] recovery failed (treating all sessions as fresh):', err)
      }
    }
  }

  manager = new SessionManager(tmuxAvailable ? tmuxRegistry : null)

  wireManagerIPC()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void manager.killAll()
  void lspManager.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void manager.killAll()
  void lspManager.dispose()
})
