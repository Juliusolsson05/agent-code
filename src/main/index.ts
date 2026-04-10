import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { ClaudeSession } from '../core/runtime/claudeSession.js'

// Thin Electron shell over ClaudeSession. All process management,
// terminal parsing, and JSONL tailing lives in src/core/runtime/ so the
// same machinery powers cc-shell, the testbench, and (eventually) the
// dispatch-to-native-terminal mode.

const __dirname = dirname(fileURLToPath(import.meta.url))

const COLS = 120
const ROWS = 40

// The cwd we spawn `claude` with. process.cwd() during dev is the cc-shell
// project root — that's a sensible default while we have no project picker UI.
// Override with $CC_SHELL_CWD if you want CC pointed elsewhere.
const SPAWN_CWD = process.env.CC_SHELL_CWD || process.cwd()

let mainWindow: BrowserWindow | null = null
let session: ClaudeSession | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

async function startSession(): Promise<void> {
  session = new ClaudeSession({
    cwd: SPAWN_CWD,
    cols: COLS,
    rows: ROWS,
    snapshotIntervalMs: 16,
  })

  session.on('started', ({ projectDir }) => send('jsonl:project-dir', projectDir))
  session.on('screen', text => send('pty:screen', text))
  session.on('jsonl-entry', (entry, file) => send('jsonl:entry', { entry, file }))
  session.on('jsonl-error', err => send('jsonl:error', String(err.message ?? err)))
  session.on('exit', ({ exitCode }) => {
    send('pty:exit', exitCode)
    session = null
  })

  await session.start()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0b0b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    void startSession()
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

app.whenReady().then(() => {
  ipcMain.handle('pty:input', (_evt, data: string) => {
    session?.write(data)
  })

  ipcMain.handle('pty:resize', (_evt, cols: number, rows: number) => {
    session?.resize(cols, rows)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void session?.stop()
  session = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void session?.stop()
  session = null
})
