import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { BrowserPocketController, type GuestLike, type ImageLike } from '@main/browserPocket/controller/BrowserPocketController.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

// The MCP surface over the REAL controller, whose guest answers with recorded
// Chrome responses. What is pinned: which tools exist when, that every tool
// targets the caller's own pocket, and that refusals reach the agent as tool
// errors with a code it can act on.
const FIX = join(__dirname, '../../main/browserPocket/__fixtures__')
const axForm = JSON.parse(readFileSync(join(FIX, 'axtree.form.json'), 'utf8'))

const SMALL_IMAGE: ImageLike = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), resize: () => SMALL_IMAGE, toJPEG: () => Buffer.from('jpeg') }
const BIG_IMAGE: ImageLike = { isEmpty: () => false, getSize: () => ({ width: 2560, height: 1600 }), resize: () => SMALL_IMAGE, toJPEG: () => Buffer.from('full-size') }

function guest(): GuestLike & { sent: string[] } {
  const sent: string[] = []
  let attached = false
  return {
    id: 1, sent,
    debugger: {
      attach: () => { attached = true }, detach: () => { attached = false }, isAttached: () => attached,
      sendCommand: async (method: string) => { sent.push(method); return method === 'Accessibility.getFullAXTree' ? { nodes: axForm.nodes } : {} },
      on: () => {},
    },
    isDestroyed: () => false, isDevToolsOpened: () => false,
    getURL: () => 'http://localhost:5173/login', getTitle: () => 'Sign in',
    loadURL: async () => {}, reload: () => {},
    capturePage: async (): Promise<ImageLike> => BIG_IMAGE,
    once: () => {},
  }
}

function setup(opts: { enabled?: boolean; evaluate?: boolean } = {}) {
  const requestOpen = vi.fn()
  const controller = new BrowserPocketController({
    now: () => Date.now(), emitDriving: () => {}, requestOpen, setWatchedSessions: () => {},
    lanePorts: sid => (sid === 'session-1' ? [{ port: 5173, pid: 42, url: 'http://localhost:5173/', kind: 'html' }] : []),
    requestViewport: vi.fn(),
  })
  controller.setFlags({ enabled: opts.enabled ?? true, allowEvaluate: opts.evaluate ?? false })
  return { controller, requestOpen }
}

async function connect(controller: BrowserPocketController, domains: BuiltInMcpDomain[] = ['browser'], sessionId = 'session-1') {
  const server = createBuiltInMcpServer({ sessionId, cwd: '/tmp/p', domains }, { browserPockets: controller })
  const client = new Client({ name: 'browser-domain-test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return { client, close: async () => { await client.close(); await server.close() } }
}

const BASE_TOOLS = ['browser_status', 'browser_lane_ports', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait_for', 'browser_console', 'browser_network', 'browser_resize', 'browser_set_appearance']

describe('tool availability', () => {
  it('registers the browser tools, without evaluate by default, and teaches them in instructions', async () => {
    const { controller } = setup()
    const { client, close } = await connect(controller)
    const names = (await client.listTools()).tools.map(t => t.name)
    const instructions = client.getInstructions()
    await close()
    expect(names.sort()).toEqual([...BASE_TOOLS].sort())
    expect(instructions).toContain('browser pocket')
  })

  it('adds browser_evaluate only when the user allowed it', async () => {
    const { controller } = setup({ evaluate: true })
    const { client, close } = await connect(controller)
    const names = (await client.listTools()).tools.map(t => t.name)
    await close()
    expect(names).toContain('browser_evaluate')
  })

  it('while the feature is off, only browser_status remains and it answers "disabled" (never an empty tool list)', async () => {
    const { controller } = setup({ enabled: false })
    const { client, close } = await connect(controller)
    const names = (await client.listTools()).tools.map(t => t.name)
    const res = await client.callTool({ name: 'browser_status', arguments: {} })
    await close()
    expect(names).toEqual(['browser_status'])
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('disabled')
  })

  it('has no browser tools when the agent was not granted the domain', async () => {
    const { controller } = setup()
    const { client, close } = await connect(controller, ['tldr'])
    const names = (await client.listTools()).tools.map(t => t.name)
    await close()
    expect(names.filter(n => n.startsWith('browser_'))).toEqual([])
  })

  it('no tool accepts a session or pocket parameter — targets come from the authenticated scope only', async () => {
    const { controller } = setup({ evaluate: true })
    const { client, close } = await connect(controller)
    const tools = (await client.listTools()).tools
    await close()
    for (const tool of tools) {
      const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      expect(props.filter(p => /session|pocket|tab|target/i.test(p)), tool.name).toEqual([])
    }
  })
})

describe('behaviour through the protocol', () => {
  it('browser_lane_ports reports the caller\'s ports and no one else\'s', async () => {
    const { controller } = setup()
    const mine = await connect(controller)
    const theirs = await connect(controller, ['browser'], 'session-2')
    const a = await mine.client.callTool({ name: 'browser_lane_ports', arguments: {} })
    const b = await theirs.client.callTool({ name: 'browser_lane_ports', arguments: {} })
    await mine.close(); await theirs.close()
    expect(JSON.stringify(a.content)).toContain('5173')
    expect(JSON.stringify(b.content)).not.toContain('5173')
  })

  it('browser_snapshot returns the recorded page as text with refs and a console section', async () => {
    const { controller } = setup()
    controller.register('p1', 'session-1', guest())
    const { client, close } = await connect(controller)
    const res = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    await close()
    const body = (res.content as Array<{ text: string }>)[0]!.text
    expect(body).toContain('url: http://localhost:5173/login')
    expect(body).toMatch(/- button "Sign in" \[ref=e\d+\]/)
    expect(body).toContain('console since last snapshot: none')
    expect(res.content).toHaveLength(1) // text only, never an image
  })

  it('browser_screenshot returns a downscaled JPEG image', async () => {
    const { controller } = setup()
    controller.register('p1', 'session-1', guest())
    const { client, close } = await connect(controller)
    const res = await client.callTool({ name: 'browser_screenshot', arguments: {} })
    await close()
    expect(res.content).toEqual([{ type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' }])
  })

  it('browser_open on an agent without a pocket asks the app to attach one (collapsed)', async () => {
    const { controller, requestOpen } = setup()
    const { client, close } = await connect(controller)
    const pending = client.callTool({ name: 'browser_open', arguments: { port: 5173 } })
    await vi.waitFor(() => expect(requestOpen).toHaveBeenCalledWith('session-1', 'http://localhost:5173/'))
    controller.register('p1', 'session-1', guest())
    const res = await pending
    await close()
    expect(res.isError).toBeFalsy()
  })

  it('browser_open refuses a non-web URL without asking the app for a pocket', async () => {
    const { controller, requestOpen } = setup()
    const { client, close } = await connect(controller)
    const res = await client.callTool({ name: 'browser_open', arguments: { url: 'javascript:alert(1)' } })
    await close()
    expect(res.isError).toBe(true)
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it('refuses non-web URLs and bad refs before touching the page', async () => {
    const { controller } = setup()
    const g = guest()
    controller.register('p1', 'session-1', g)
    const { client, close } = await connect(controller)
    const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: 'file:///etc/passwd' } })
    const click = await client.callTool({ name: 'browser_click', arguments: { ref: 'button' } })
    await close()
    expect(nav.isError).toBe(true)
    expect(click.isError).toBe(true)
    expect(g.sent).toEqual([])
  })

  it('a user takeover reaches the agent as paused_by_user on mutations, while reads still work', async () => {
    const { controller } = setup()
    controller.register('p1', 'session-1', guest())
    controller.takeOver('p1')
    const { client, close } = await connect(controller)
    const click = await client.callTool({ name: 'browser_click', arguments: { x: 10, y: 10 } })
    const read = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    await close()
    expect(click.isError).toBe(true)
    expect(JSON.stringify(click.content)).toContain('paused_by_user')
    expect(read.isError).toBeFalsy()
  })
})
