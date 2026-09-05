#!/usr/bin/env node
// Real GPU coverage is intentionally opt-in: happy-dom cannot exercise texture
// uploads, and a headless CI worker without a display must not silently bless it.
// Run: node scripts/smoke-terminal-renderer.mjs [--control]
// --control bypasses our wrapper and must expose the pinned addon's corruption.
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)

if (!process.versions.electron) {
  const { build } = await import('vite')
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-terminal-renderer-'))
  // Preserve artifacts for inspection, but never use the developer's app
  // profile. This process loads only synthetic terminals, not Agent Code.
  console.log(`Terminal renderer artifacts: ${dir}`)
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir: dir,
      emptyOutDir: false,
      lib: {
        entry: join(root, 'testing/fixtures/terminal-renderer/smoke.ts'),
        name: 'terminalRendererSmoke',
        formats: ['iife'],
        fileName: () => 'renderer.js',
      },
    },
  })
  await copyFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(dir, 'xterm.css'))
  await writeFile(join(dir, 'index.html'), `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'">
    <link rel="stylesheet" href="xterm.css">
    <style>body{margin:0;background:#17191d;display:flex}.host{width:750px;height:650px;overflow:hidden}</style>
    <div id="a" class="host"></div><div id="b" class="host"></div><script src="renderer.js"></script>`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), dir, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  const stop = signal => child.kill(signal)
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    process.exitCode = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', code => done(code ?? 1))
    })
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
} else {
  const { app, BrowserWindow } = require('electron')
  const dir = process.argv[2]
  app.setPath('userData', join(dir, 'profile'))
  // Electron waits for its ESM entry to finish before readiness. A top-level
  // await here would deadlock startup; register the continuation and return.
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 1500, height: 700, show: false,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    let status = 1
    // Bound hangs in GPU startup/rendering without touching other Electron apps.
    const timeout = setTimeout(() => { window.destroy(); app.exit(1) }, 120_000)
    try {
      await window.loadFile(join(dir, 'index.html'))
      const control = process.argv.includes('--control')
      const report = await window.webContents.executeJavaScript(`terminalRendererSmoke.run(${control})`)
      await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2))
      await writeFile(join(dir, 'terminal.png'), (await window.webContents.capturePage()).toPNG())
      console.log(JSON.stringify(report))
      const corrupt = report.differences.length > 0 || report.referenceDifference > 0
      if (report.removedPages === 0) throw new Error('Workload did not exercise atlas merges')
      if (control ? !corrupt : corrupt) throw new Error(control ? 'Control did not reproduce corruption' : 'Rendered pixels differ from unchanged buffer')
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
