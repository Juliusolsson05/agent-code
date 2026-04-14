import electron from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { DemoSession } from './session.mjs'

const { app, BrowserWindow, ipcMain } = electron

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow = null
let demoSession = null

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    backgroundColor: '#111317',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  })

  await mainWindow.loadFile(join(__dirname, 'renderer.html'))

  demoSession = new DemoSession()
  wireSession(demoSession)
  await demoSession.start()
}

function wireSession(session) {
  session.on('terminal-data', (data) => {
    mainWindow?.webContents.send('demo:terminal-data', data)
  })
  session.on('stream-text', (text) => {
    mainWindow?.webContents.send('demo:stream-text', text)
  })
  session.on('stream-event', (payload) => {
    mainWindow?.webContents.send('demo:stream-event', payload)
  })
  session.on('status', (status) => {
    mainWindow?.webContents.send('demo:status', status)
  })
  session.on('ready', (info) => {
    mainWindow?.webContents.send('demo:ready', info)
  })
  session.on('proxy-log', (text) => {
    mainWindow?.webContents.send('demo:proxy-log', text)
  })
}

ipcMain.handle('demo:write', async (_event, data) => {
  demoSession?.write(String(data))
})

ipcMain.handle('demo:resize', async (_event, payload) => {
  if (!payload) return
  demoSession?.resize(Number(payload.cols) || 120, Number(payload.rows) || 40)
})

app.whenReady().then(createWindow)

app.on('window-all-closed', async () => {
  await demoSession?.stop()
  demoSession = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await demoSession?.stop()
})
