import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises'
import { homedir } from 'os'

import { SessionManager } from './sessionManager.js'
import { LspManager } from './lspManager.js'
import { listSessionsForCwd } from '../core/runtime/sessionList.js'
import { listCodexSessions } from '../core/runtime/codexSessionList.js'

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
const manager = new SessionManager()
const lspManager = new LspManager()

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
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
  manager.on('jsonl-entry', payload => send('session:jsonl-entry', payload))
  manager.on('jsonl-error', ({ sessionId, error }) =>
    send('session:jsonl-error', {
      sessionId,
      message: String(error.message ?? error),
    }),
  )
  manager.on('terminal-data', payload =>
    send('session:terminal-data', payload),
  )
  manager.on('exit', payload => send('session:exit', payload))
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
        if (provider === 'codex') {
          const sessions = await listCodexSessions({
            // Codex sessions are global, not per-cwd, so we read a
            // slightly wider slice first and then filter client-facing
            // results down to the requested cwd.
            limit: Math.max(limit ?? 20, 100),
          })
          return sessions.filter(s => s.cwd === cwd).slice(0, limit ?? 20)
        }
        return await listSessionsForCwd(cwd, { limit })
      } catch (err) {
        // Don't let a listing error brick the modal — return empty.
        // eslint-disable-next-line no-console
        console.warn('[session:list-for-cwd] failed:', err)
        return []
      }
    },
  )

  ipcMain.handle('session:kill', async (_evt, sessionId: string) => {
    return await manager.kill(sessionId)
  })

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
      manager.write(sessionId, data)
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
}

// ---------- App lifecycle ----------

app.whenReady().then(() => {
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
