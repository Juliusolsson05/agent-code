import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import WebSocket from 'ws'
import type { GuestLike } from '../controller/BrowserPocketController.js'

/** Real Chromium behind an Electron-shaped debugger boundary. This fixture
 * launches an isolated headless browser profile, never Electron or the user's
 * running browser. The production transport/actions are exercised unchanged.
 * CI can supply PLAYWRIGHT_CHROMIUM_EXECUTABLE or install Playwright Chromium. */
export const chromiumExecutable = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p))

export async function chromiumHarness() {
  if (!chromiumExecutable) throw new Error('Install Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE')
  const profile = await mkdtemp(join(tmpdir(), 'agent-code-pocket-test-'))
  const context = await chromium.launchPersistentContext(profile, { executablePath: chromiumExecutable, headless: true, viewport: { width: 800, height: 600 }, args: ['--remote-debugging-port=0', '--site-per-process'] })
  const page = context.pages()[0]!
  const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let seq = 0
  const events = new EventEmitter()
  let attachedSession: string | undefined
  const children = new Set<string>()
  socket.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.id) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) call?.reject(new Error(message.error.message))
      else call?.resolve(message.result)
    } else if (message.sessionId === attachedSession || children.has(message.sessionId)) {
      if (message.method === 'Target.attachedToTarget') children.add(message.params.sessionId)
      events.emit('message', {}, message.method, message.params, message.sessionId === attachedSession ? undefined : message.sessionId)
    }
  })
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetInfos } = await send('Target.getTargets')
  const targetId = targetInfos.find((t: { type: string }) => t.type === 'page').targetId
  attachedSession = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
  let attached = false
  const debuggerApi = Object.assign(events, {
    attach: () => { attached = true }, detach: () => { attached = false; events.emit('detach', {}, 'test') }, isAttached: () => attached,
    sendCommand: (method: string, params?: object, sessionId?: string) => send(method, params, sessionId ?? attachedSession),
  })
  const guest: GuestLike = {
    id: 1, debugger: debuggerApi, isDestroyed: () => page.isClosed(), isDevToolsOpened: () => false,
    getURL: () => page.url(), getTitle: () => 'Browser fixture', loadURL: async url => { await page.goto(url) }, reload: () => { void page.reload() },
    capturePage: async () => { throw new Error('Native capture must not be used by agent screenshots') },
    once: () => {},
  }
  return { page, guest, cleanup: async () => { debuggerApi.detach(); socket.close(); await context.close(); await rm(profile, { recursive: true, force: true }) } }
}
