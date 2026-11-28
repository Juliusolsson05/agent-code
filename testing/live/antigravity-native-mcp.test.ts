import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost'
import { TldrStore } from '@main/tldr/TldrStore'
import { Terminal } from '@xterm/headless'
import { expect, it, vi } from 'vitest'
import { getMainProvider } from '@providers/registry.main'

// The CLI and both MCP endpoints are real; only Electron's performance recorder
// is unavailable in this Node-run live probe.
vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

// Interactive discovery happens on agy's /mcp screen. The SDK transport test separately
// exercises tool calls without spending model credits or submitting a prompt to an account.
it.skipIf(process.env.ANTIGRAVITY_TERMINAL_LIVE !== '1')('lists only this pane’s tools in native agy, including after resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-live-reporting-'))
  const host = new BuiltInMcpHttpHost()
  const cwd = process.env.ANTIGRAVITY_LIVE_CWD ?? process.cwd()
  host.setDependencies({
    tldrStore: new TldrStore(join(directory, 'tldr.json')),
    goalStore: new TldrStore(join(directory, 'goal.json')),
  })
  await host.start()
  const open = (pane: 'goal' | 'tldr', resumeSessionId?: string) => {
    const builtInMcpServers = host.registerSession({
      sessionId: pane + (resumeSessionId ? '-resumed' : ''), tldrIdentity: pane,
      providerKind: 'antigravity', cwd, domains: [pane],
    })
    const session = getMainProvider('antigravity').createTerminalSession!({
      cwd, binary: process.env.AGY_BINARY ?? 'agy',
      resumeSessionId, cols: 110, rows: 32,
      builtInMcpServers,
    })
    const screen = new Terminal({ cols: 110, rows: 32, allowProposedApi: true })
    session.on('pty-data', data => screen.write(data))
    screen.onData(reply => session.write(reply))
    return {
      session, screen,
      visible: () => Array.from({ length: screen.rows }, (_, i) =>
        screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n'),
    }
  }
  const panes: Array<ReturnType<typeof open>> = []
  async function check(which: 'goal' | 'tldr', resume?: string) {
    const pane = open(which, resume)
    panes.push(pane)
    await pane.session.start()
    await expect.poll(pane.visible, { timeout: 15000 }).toContain('for shortcuts')
    pane.session.write('/mcp')
    await expect.poll(pane.visible).toContain('/mcp')
    pane.session.write('\r')
    await expect.poll(pane.visible, { timeout: 15000 }).toContain(which === 'goal' ? 'goal_set' : 'tldr_update')
    expect(pane.visible()).not.toContain(which === 'goal' ? 'tldr_update' : 'goal_set')
    return pane
  }
  try {
    const [first, second] = await Promise.all([check('goal'), check('tldr')])
    const id = first.session.getProviderSessionId?.()
    expect(id).toBeTruthy()
    expect(second.session.getProviderSessionId?.()).not.toBe(id)
    await first.session.stop()
    const resumed = await check('goal', id!)
    expect(resumed.session.getProviderSessionId?.()).toBe(id)
  } finally {
    await Promise.all(panes.map(p => p.session.stop()))
    for (const pane of panes) pane.screen.dispose()
    await host.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
