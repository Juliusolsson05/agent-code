#!/usr/bin/env node
// Run: node scripts/smoke-terminal-wheel.mjs [--control]
// Real Chromium default scrolling cannot be simulated by happy-dom dispatch.
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-terminal-wheel-'))
  console.log('Terminal wheel artifacts: ' + dir)
  const { build } = await import('vite')
  await build({
    configFile: false, root, logLevel: 'warn',
    build: { outDir: dir, emptyOutDir: false, lib: {
      entry: join(root, 'testing/fixtures/terminal-wheel/smoke.ts'),
      name: 'probe', formats: ['iife'], fileName: () => 'renderer.js',
    } },
  })
  await copyFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(dir, 'xterm.css'))
  await writeFile(join(dir, 'index.html'), `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'">
    <link rel="stylesheet" href="xterm.css">
    <style>body{margin:0;background:#17191d}#outer{height:420px;overflow:auto}#host{height:350px;width:750px;position:relative;overflow:hidden}#spacer{height:800px}</style>
    <div id="outer"><div id="host"></div><div id="spacer"></div></div><script src="renderer.js"></script>`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), dir, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
} else {
  const { app, BrowserWindow } = require('electron')
  const dir = process.argv[2]
  app.setPath('userData', join(dir, 'profile'))
  // Top-level await app.whenReady would deadlock Electron's ESM entry startup.
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 800, height: 600, show: false,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    const timeout = setTimeout(() => { window.destroy(); app.exit(1) }, 30_000)
    const js = source => window.webContents.executeJavaScript(source)
    let status = 1
    try {
      await window.loadFile(join(dir, 'index.html'))
      const control = process.argv.includes('--control')
      const report = { control, initial: await js(`probe.setup(${control})`) }
      const wheel = async deltaY => {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: 200, y: 100 })
        // Electron does not infer legacy wheel ticks from pixel deltas. xterm's
        // upstream normalizer reads wheelDeltaY first; omitting wheelTicksY
        // creates an impossible zero-tick event and falsely makes scrollback fail.
        window.webContents.sendInputEvent({
          type: 'mouseWheel', x: 200, y: 100, deltaY, deltaX: 0,
          wheelTicksY: deltaY / 120, wheelTicksX: 0,
          hasPreciseScrollingDeltas: true, canScroll: true,
        })
        await new Promise(resolve => setTimeout(resolve, 100))
        await js('probe.settle()')
        return js('probe.state()')
      }
      report.up = await wheel(120)
      report.outputWhileScrolled = await js('probe.append()')
      report.down = await wheel(-120)
      await js('probe.bottom()')
      report.boundaryDown = await wheel(-120)
      await js('probe.alternate()')
      report.alternateUp = await wheel(120)
      await js('probe.alternate(true)')
      report.mouseUp = await wheel(120)
      await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2))
      await writeFile(join(dir, 'terminal.png'), (await window.webContents.capturePage()).toPNG())
      console.log(JSON.stringify(report))
      assert(report.up.top < report.initial.top, 'Wheel must move terminal scrollback')
      assert.equal(report.outputWhileScrolled.top, report.up.top, 'New output must preserve the scrolled position')
      assert.equal(report.outputWhileScrolled.first, report.up.first)
      assert(report.outputWhileScrolled.base > report.initial.base)
      assert(report.down.top > report.up.top)
      for (const state of [report.up, report.outputWhileScrolled, report.down]) {
        assert.equal(state.outer, 0, 'Normal scrollback must not move the parent')
        assert.deepEqual(state.writes, [], 'Normal scrollback must not generate PTY input')
      }
      if (control) assert(report.boundaryDown.outer > 0, 'Control must expose boundary scroll chaining')
      else assert.equal(report.boundaryDown.outer, 0, 'Boundary input must stay inside terminal')
      assert.deepEqual(report.alternateUp.writes, ['\x1b[A'])
      assert.equal(report.mouseUp.writes.length, 1)
      assert.match(report.mouseUp.writes[0], /^\x1b\[<64;\d+;\d+M$/)
      assert.equal(report.alternateUp.outer, report.boundaryDown.outer)
      assert.equal(report.mouseUp.outer, report.boundaryDown.outer)
      status = 0
    } catch (error) {
      console.error(error)
    } finally {
      clearTimeout(timeout)
      window.destroy()
      app.exit(status)
    }
  }).catch(error => { console.error(error); app.exit(1) })
}
