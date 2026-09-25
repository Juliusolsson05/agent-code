import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { BrowserPocketController, type GuestLike, type ImageLike } from '@main/browserPocket/controller/BrowserPocketController.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

// MCP serialization and scope checks use a page-engine seam. The production
// adapter is exercised against actual Chromium in playwrightActions.system.
vi.mock('@main/browserPocket/controller/playwrightPage.js', () => ({
  withPocketPage: async (ctx: { guest: GuestLike }, action: (page: unknown) => unknown) => action({
    ariaSnapshot: async () => '- button "Sign in" [ref=e1]',
    url: () => ctx.guest.getURL(), title: async () => ctx.guest.getTitle(),
    screenshot: async () => Buffer.from('jpeg'),
  }),
}))

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
      sendCommand: async (method: string) => { sent.push(method); return method === 'Accessibility.getFullAXTree' ? { nodes: axForm.nodes } : method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : method === 'Page.createIsolatedWorld' ? { executionContextId: 1 } : method === 'Runtime.evaluate' ? { result: { value: 2 } } : method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } } : {} },
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

const BASE_TOOLS = ['browser_status', 'browser_lane_ports', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait_for', 'browser_console', 'browser_network', 'browser_resize', 'browser_set_appearance', 'browser_evaluate']

describe('tool availability', () => {
  it('registers a stable browser catalog and teaches it in instructions', async () => {
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

  it('discovers once while disabled, enables without reconnecting, and gates every buffered read after disabling', async () => {
    const { controller } = setup({ enabled: false })
    const { client, close } = await connect(controller)
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names.sort()).toEqual([...BASE_TOOLS].sort())
    expect(client.getInstructions()).toContain('browser pocket')
    const g = guest()
    controller.register('p1', 'session-1', g)
    const call = (name: string) => client.callTool({ name, arguments: {} })
    expect((await call('browser_status')).isError).toBe(true)
    controller.setFlags({ enabled: true, allowEvaluate: false })
    expect((await call('browser_status')).isError).not.toBe(true)
    expect((await call('browser_lane_ports')).isError).not.toBe(true)
    controller.setFlags({ enabled: false, allowEvaluate: false })
    for (const name of ['browser_status', 'browser_console', 'browser_network', 'browser_lane_ports']) {
      const result = await call(name)
      expect(result.isError, name).toBe(true)
      expect(JSON.stringify(result.content)).toContain('disabled')
      expect(JSON.stringify(result.content)).not.toContain('5173')
    }
    expect(g.sent).not.toContain('Runtime.evaluate')
    await close()
  })

  it('evaluation is discoverable but gated at call time, including revocation', async () => {
    const { controller } = setup()
    const { client, close } = await connect(controller)
    const g = guest()
    controller.register('p1', 'session-1', g)
    const call = () => client.callTool({ name: 'browser_evaluate', arguments: { expression: '1 + 1' } })
    expect((await call()).isError).toBe(true)
    expect(g.sent).not.toContain('Runtime.evaluate')
    controller.setFlags({ enabled: true, allowEvaluate: true })
    await call()
    expect(g.sent).toContain('Runtime.evaluate')
    g.sent.length = 0
    controller.setFlags({ enabled: true, allowEvaluate: false })
    expect((await call()).isError).toBe(true)
    expect(g.sent).not.toContain('Runtime.evaluate')
    await close()
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

  it('browser_snapshot serializes page text with refs and a console section', async () => {
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

  it('browser_screenshot returns the page engine image as JPEG content', async () => {
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
