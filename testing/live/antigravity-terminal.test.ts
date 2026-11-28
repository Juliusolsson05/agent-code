import { Terminal } from '@xterm/headless'
import { expect, it } from 'vitest'
import { getMainProvider } from '@providers/registry.main'

// Each fresh TUI allocates an empty conversation in the signed-in agy account. Keep this
// opt-in and never submit the marker: typing it is enough to prove interactive input.
it.skipIf(process.env.ANTIGRAVITY_TERMINAL_LIVE !== '1')('opens two native agy prompts and resumes the chosen conversation', async () => {
  const provider = getMainProvider('antigravity')
  const create = provider.createTerminalSession!
  const options = { cwd: process.env.ANTIGRAVITY_LIVE_CWD ?? process.cwd(), binary: process.env.AGY_BINARY ?? 'agy', cols: 100, rows: 30 }
  const first = create(options)
  const second = create(options)
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  const visible = () => Array.from({ length: screen.rows }, (_, i) =>
    screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n')
  first.on('pty-data', data => screen.write(data))
  screen.onData(reply => first.write(reply))
  let rendered: ReturnType<typeof create> | undefined
  let resumed: ReturnType<typeof create> | undefined
  try {
    await first.start()
    await second.start()
    const firstId = first.getProviderSessionId?.()
    expect(firstId).toBeTruthy()
    expect(second.getProviderSessionId?.()).toBeTruthy()
    expect(second.getProviderSessionId?.()).not.toBe(firstId)
    await expect.poll(() => visible().includes('for shortcuts'), { timeout: 30000 }).toBe(true)
    screen.resize(90, 25)
    first.resize(90, 25)
    first.write('native-terminal-check')
    await expect.poll(() => visible().includes('native-terminal-check'), { timeout: 5000 }).toBe(true)
    first.write('\x15')
    await expect.poll(() => visible().includes('native-terminal-check')).toBe(false)
    first.write('/new')
    await expect.poll(() => visible().includes('/new')).toBe(true)
    first.write('\r')
    await expect.poll(() => first.getProviderSessionId?.(), { timeout: 15000 }).not.toBe(firstId)
    const newId = first.getProviderSessionId?.()
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(second.getProviderSessionId?.())
    // The view picker starts its successor before it retires the source pane.
    rendered = provider.createSession({ ...options, resumeSessionId: newId! })
    await rendered.start()
    expect(rendered.getProviderSessionId?.()).toBe(newId)
    await first.stop()
    resumed = create({ ...options, resumeSessionId: newId! })
    screen.reset()
    resumed.on('pty-data', data => screen.write(data))
    // The successor pane has no renderer yet during a view switch. Its own resume
    // acknowledgment must arrive without keyboard input or terminal query replies.
    await resumed.start()
    screen.onData(reply => resumed?.write(reply))
    await expect.poll(() => visible().includes('for shortcuts'), { timeout: 15000 }).toBe(true)
    expect(resumed.getProviderSessionId?.()).toBe(newId)
  } finally {
    await Promise.all([first.stop(), second.stop(), resumed?.stop(), rendered?.stop()])
    screen.dispose()
  }
}, 60000)
