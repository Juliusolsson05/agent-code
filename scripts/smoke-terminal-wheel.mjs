#!/usr/bin/env node
// Real-Chromium oracle for the terminal wheel boundary (#791, PR #792).
// Run: node scripts/smoke-terminal-wheel.mjs [--control]
//
// WHY manual and opt-in: the bug is Chromium's native default scrolling
// (scroll chaining to the nearest native ancestor when xterm leaves a wheel
// event unconsumed), and happy-dom has neither layout nor default scrolling,
// so no Vitest file can observe it. This spawns Electron with a hidden,
// sandboxed BrowserWindow on a synthetic terminal and a throwaway userData
// profile; it never loads Agent Code or touches a provider PTY. Because it
// launches Electron it is a USER-run probe: agents never run it, and there is
// deliberately no npm script or CI gate (a headless worker without a display
// or GPU must not silently bless WebGL scrolling).
//
// Modes: the default attaches the production helper
// (src/renderer/src/workspace/terminal/terminalWheelBoundary.ts); --control
// skips it and MUST still reproduce the leak (the parent panel scrolls at the
// boundary). A control that stops leaking means xterm began consuming boundary
// wheels itself, so the helper is redundant: follow its WHEN BUMPING XTERM
// note and delete it instead of stacking a second owner.
//
// What each assertion protects:
// - Parent stays at 0px while plain and Alt wheels move scrollback, and (default
//   mode) at the bottom boundary for plain AND Alt wheels: the #791 leak itself.
//   Alt is covered because it is xterm's fastScrollSensitivity gesture; the
//   helper's first version exempted it and leaked at the boundary.
// - Alt+wheel moves farther than a plain notch: proves the modifier really
//   reached xterm as a fast scroll, so the Alt boundary step is meaningful.
// - Output appended while scrolled keeps the viewed line: the boundary must not
//   disturb xterm's scroll anchoring.
// - No scrollback or boundary wheel produces PTY input: the helper cancels a
//   browser default and never synthesizes terminal input.
// - Alternate screen converts wheel to an arrow key (ESC [ A) and mouse
//   reporting (DECSET 1000 + 1006) sends exactly one SGR wheel report; neither
//   moves the parent. These prove xterm/provider first refusal survives.
//
// Re-run BOTH modes on every @xterm/xterm, @xterm/addon-webgl or Electron bump.
// The helper's correctness is derived from xterm's internal wheel handling and
// Chromium's scroll chaining, and this is the only check that exercises both
// together. History: the recorded pass (default 0px, control 120px) was on
// xterm 6.0.0 / addon-webgl 0.19.0, before #873 moved to the 6.1.0-beta.304 /
// 0.20.0-beta.300 line; the Alt steps were added after that run.
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
      const wheel = async (deltaY, modifiers = []) => {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: 200, y: 100 })
        // Electron does not infer legacy wheel ticks from pixel deltas. xterm's
        // upstream normalizer reads wheelDeltaY first; omitting wheelTicksY
        // creates an impossible zero-tick event and falsely makes scrollback fail.
        // `modifiers` reaches the DOM WheelEvent as altKey etc., which is what
        // xterm's fast-scroll branch and the helper's modifier policy read.
        window.webContents.sendInputEvent({
          type: 'mouseWheel', x: 200, y: 100, deltaY, deltaX: 0,
          wheelTicksY: deltaY / 120, wheelTicksX: 0,
          hasPreciseScrollingDeltas: true, canScroll: true, modifiers,
        })
        await new Promise(resolve => setTimeout(resolve, 100))
        await js('probe.settle()')
        return js('probe.state()')
      }
      report.up = await wheel(120)
      report.outputWhileScrolled = await js('probe.append()')
      report.down = await wheel(-120)
      // Mid-history Alt notch: must be consumed by xterm as a fast scroll.
      report.altUp = await wheel(120, ['alt'])
      await js('probe.bottom()')
      report.boundaryDown = await wheel(-120)
      // Same boundary, Alt held: the case the helper used to exempt.
      report.altBoundaryDown = await wheel(-120, ['alt'])
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
      assert(report.down.top - report.altUp.top > report.down.top - report.up.top, 'Alt+wheel must fast-scroll terminal scrollback')
      for (const state of [report.up, report.outputWhileScrolled, report.down, report.altUp]) {
        assert.equal(state.outer, 0, 'Normal scrollback must not move the parent')
        assert.deepEqual(state.writes, [], 'Normal scrollback must not generate PTY input')
      }
      for (const state of [report.boundaryDown, report.altBoundaryDown]) {
        assert.deepEqual(state.writes, [], 'Boundary input must not generate PTY input')
      }
      if (control) {
        assert(report.boundaryDown.outer > 0, 'Control must expose boundary scroll chaining')
        assert(report.altBoundaryDown.outer > report.boundaryDown.outer, 'Control must expose Alt boundary scroll chaining')
      } else {
        assert.equal(report.boundaryDown.outer, 0, 'Boundary input must stay inside terminal')
        assert.equal(report.altBoundaryDown.outer, 0, 'Alt fast-scroll boundary input must stay inside terminal')
      }
      assert.deepEqual(report.alternateUp.writes, ['\x1b[A'])
      assert.equal(report.mouseUp.writes.length, 1)
      assert.match(report.mouseUp.writes[0], /^\x1b\[<64;\d+;\d+M$/)
      assert.equal(report.alternateUp.outer, report.altBoundaryDown.outer)
      assert.equal(report.mouseUp.outer, report.altBoundaryDown.outer)
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
