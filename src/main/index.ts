import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { homedir } from 'os'

import { SessionManager } from './sessionManager.js'

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
const manager = new SessionManager()

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

// Wire every manager event to a matching IPC channel. Each payload
// carries the sessionId so the renderer can route to the right tile.
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
  manager.on('exit', payload => send('session:exit', payload))
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
  })

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
    async (_evt, options: { cwd: string; cols?: number; rows?: number }) => {
      return await manager.spawn(options)
    },
  )

  ipcMain.handle('session:kill', async (_evt, sessionId: string) => {
    return await manager.kill(sessionId)
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

  // --- CWD picker (native folder dialog) ---
  // Returns an absolute path, or null if the user cancelled.
  // Used by "new tab" flow where the user needs to pick a directory
  // for the new session.
  ipcMain.handle('dialog:pickDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a working directory',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

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
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void manager.killAll()
})
