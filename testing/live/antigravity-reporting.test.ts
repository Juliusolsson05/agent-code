import { Terminal } from '@xterm/headless'
import { expect, it } from 'vitest'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost'
import { getMainProvider } from '@providers/registry.main'

it.skipIf(process.env.ANTIGRAVITY_TERMINAL_LIVE !== '1')('loads pane reporting hooks and its real MCP host in the native CLI', async () => {
  const host = new BuiltInMcpHttpHost()
  await host.start()
  const cwd = process.env.ANTIGRAVITY_LIVE_CWD ?? process.cwd()
  const grants = host.registerSession({ sessionId: 'reporting-probe', providerKind: 'antigravity', cwd, domains: ['goal', 'tldr'] })
  const terminal = getMainProvider('antigravity').createTerminalSession!({
    binary: process.env.AGY_BINARY ?? 'agy', cwd, cols: 110, rows: 35, builtInMcpServers: grants,
  })
  const screen = new Terminal({ cols: 110, rows: 35, allowProposedApi: true })
  const text = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true)).join('\n')
  terminal.on('pty-data', data => screen.write(data))
  screen.onData(data => terminal.write(data))
  try {
    await terminal.start()
    await expect.poll(text, { timeout: 12000 }).toContain('for shortcuts')
    terminal.write('/hooks')
    await expect.poll(text).toContain('/hooks')
    terminal.write('\r')
    // The /hooks landing page groups entries by event. It does not show their names.
    for (const event of ['PostToolUse', 'PreInvocation', 'Stop']) {
      await expect.poll(() => new RegExp(event + '[^\\n]+[1-9][0-9]* hooks?').test(text()), { timeout: 10000 }).toBe(true)
    }
  } finally {
    await terminal.stop()
    await host.stop()
    screen.dispose()
  }
}, 30000)
