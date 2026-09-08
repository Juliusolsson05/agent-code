import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../../..')
const run = promisify(execFile)

// Review reproduced two failures our fake Terminal could not represent:
// Chromium's xterm viewport rejects reentrant scrolling, and a full buffer
// trims content without changing baseY. Run the production hook with the
// shipped xterm in an isolated Electron window. No app bootstrap, providers,
// user sessions, or credentials are involved.
it('follows and restores real xterm content across trimming and buffer switches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-terminal-follow-'))
  try {
    const renderer = join(directory, 'renderer.ts')
    await writeFile(renderer, `
      import { createElement } from '${resolve(root, 'node_modules/react/index.js')}'
      import { createRoot } from '${resolve(root, 'node_modules/react-dom/client.js')}'
      import { flushSync } from '${resolve(root, 'node_modules/react-dom/index.js')}'
      import { Terminal } from '${resolve(root, 'node_modules/@xterm/xterm/lib/xterm.js')}'
      import '${resolve(root, 'node_modules/@xterm/xterm/css/xterm.css')}'
      import { useAgentTerminalFollow } from '${resolve(root, 'src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts')}'

      window.followTrial = (async () => {
        const term = new Terminal({ cols: 80, rows: 10, scrollback: 2000 })
        term.open(document.getElementById('terminal'))
        const termRef = { current: term }
        // The PTY sink. A provider whose TUI owns its own transcript is jumped
        // by sending it a key, not by moving the xterm viewport, so this trial
        // has to be able to observe that write.
        const sent = []
        window.api = { sendInput: (id, data) => { sent.push({ id, data }) } }
        let follow
        function Harness(props) { follow = useAgentTerminalFollow({ ...props, termRef }); return null }
        const reactRoot = createRoot(document.getElementById('react'))
        let tailActive = false
        let scrollToLatestRequest = 0
        // null = "the xterm viewport is what scrolls", which is Claude and
        // Codex and therefore the default this trial runs under.
        let jumpKey = null
        function render() {
          flushSync(() => reactRoot.render(createElement(Harness, {
            sessionId: 'trial', tailActive, scrollToLatestRequest, jumpKey,
          })))
        }
        const check = (condition, message) => { if (!condition) throw new Error(message) }
        const delay = () => new Promise(done => setTimeout(done, 10))
        const until = async (predicate, message) => {
          const deadline = performance.now() + 5000
          while (!predicate()) {
            if (performance.now() > deadline) throw new Error(message)
            await delay()
          }
        }
        const write = data => new Promise(done => term.write(data, done))
        const textAtTop = () => term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true)
        const bottom = () => term.buffer.active.viewportY === term.buffer.active.baseY
        render()
        const off = follow.attach(term)
        try {
          await write(Array.from({length: 2100}, (_, i) => 'line-' + i + '\\r\\n').join(''))
          term.scrollToLine(1000)
          const before = textAtTop()
          const fullBaseY = term.buffer.active.baseY
          tailActive = true; render()
          await until(bottom, 'Tail did not engage')

          term.scrollLines(-20)
          await until(bottom, 'Tail failed to re-pin after real xterm scroll dispatch')
          await write(Array.from({length: 100}, (_, i) => 'new-' + i + '\\r\\n').join(''))
          check(term.buffer.active.baseY === fullBaseY, 'Trial did not exercise a full, trimming buffer')
          tailActive = false; render()
          check(textAtTop() === before, 'Restore drifted after trimming: expected ' + before + ', got ' + textAtTop())

          scrollToLatestRequest++; render()
          await until(bottom, 'Jump request did not reach real xterm bottom')
          check(sent.length === 0, 'Viewport-scrolling provider must not write to the PTY')

          term.scrollToLine(10)
          tailActive = true; render()
          await write(Array.from({length: 100}, () => 'evict\\r\\n').join(''))
          tailActive = false; render()
          check(term.buffer.active.viewportY === 0, 'Evicted anchor must fall back to oldest retained content')

          term.scrollToLine(50)
          tailActive = true; render()
          await write('\\x1b[?1049h')
          tailActive = false; render()
          check(term.buffer.active.type === 'alternate' && bottom(), 'Alternate buffer was scrolled with a normal-buffer anchor')

          // The case the assertion above CANNOT see, and the reason Jump to
          // Latest silently did nothing on OpenCode Terminal panes: on the
          // alternate screen there is no scrollback at all, so viewportY and
          // baseY are both 0 and the bottom check is trivially 0 === 0. A
          // provider whose TUI owns its transcript must therefore be jumped by
          // sending it the key it binds to "go to last message" instead.
          const evictedBefore = term.buffer.active.viewportY
          jumpKey = '\\u001b\\u0007'
          scrollToLatestRequest++; render()
          await until(() => sent.length === 1, 'Provider-owned jump did not reach the PTY')
          check(sent[0].id === 'trial', 'Provider-owned jump addressed the wrong session: ' + sent[0].id)
          // Compared through char codes so the assertion cannot pass on a
          // differently-escaped string that merely looks the same in source.
          const codes = Array.from(sent[0].data).map(c => c.charCodeAt(0)).join(',')
          check(codes === '27,7', 'Wrong bytes sent for provider-owned jump: ' + codes)
          check(term.buffer.active.viewportY === evictedBefore, 'Provider-owned jump must not also move the viewport')
          jumpKey = null

          await write('\\x1b[?1049l')
          // Marker registration/disposal is public; only this diagnostic
          // enumeration requires proposed APIs. Keep them off for all behavior.
          term.options.allowProposedApi = true
          check(term.markers.length === 0, 'Follow leaked a saved marker after disengage')
          return { repin: true, trim: true, eviction: true, jump: true, alternate: true, providerJump: true }
        } finally {
          off(); reactRoot.unmount(); termRef.current = null; term.dispose()
        }
      })()
    `)
    await build({
      configFile: false, root, logLevel: 'silent',
      // The temporary entry has no ancestor node_modules; keep React and the
      // production hook on the same installed module, rather than two copies.
      resolve: { alias: { react: resolve(root, 'node_modules/react') } },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: directory, emptyOutDir: false, target: 'esnext', minify: false,
        lib: { entry: renderer, name: 'FollowTrial', formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'style' },
      },
    })
    await writeFile(join(directory, 'index.html'), '<html><head><link rel="stylesheet" href="style.css"></head><body><div id="react"></div><div id="terminal" style="width:800px;height:400px"></div><script src="renderer.js"></script></body></html>')
    await writeFile(join(directory, 'main.cjs'), `
      const { app, BrowserWindow } = require('electron')
      app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))})
      app.disableHardwareAcceleration()
      const deadline = setTimeout(() => app.exit(2), 25000)
      app.whenReady().then(async () => {
        app.dock?.hide()
        const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
        try {
          await window.loadFile(${JSON.stringify(join(directory, 'index.html'))})
          const result = await window.webContents.executeJavaScript('window.followTrial')
          if (!result) throw new Error('Renderer trial did not start')
          console.log('FOLLOW_TRIAL=' + JSON.stringify(result))
          window.destroy(); clearTimeout(deadline); app.exit(0)
        } catch (error) { console.error(error); app.exit(1) }
      }).catch(error => { console.error(error); app.exit(1) })
    `)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { stdout } = await run(createRequire(import.meta.url)('electron') as string, [join(directory, 'main.cjs')], {
      env: environment, timeout: 35_000, maxBuffer: 2_000_000,
    })
    const result = stdout.split('\n').find(line => line.startsWith('FOLLOW_TRIAL='))
    expect(result, stdout).toBeDefined()
    expect(JSON.parse(result!.slice('FOLLOW_TRIAL='.length))).toEqual({
      repin: true, trim: true, eviction: true, jump: true, alternate: true, providerJump: true,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
