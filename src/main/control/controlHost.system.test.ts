import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const run = promisify(execFile)

// WHY an actual Electron probe: a mocked ipcMain cannot establish that the
// sender-frame check admits a real context-isolated preload or that reload
// retires the old JS world. This starts only two empty test windows with their
// own userData directory. It never runs app bootstrap or launches providers.
it('routes real renderer observations across two windows and survives reload without stale identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-control-'))
  try {
    const alias = {
      '@control-sdk/host': resolve(root, 'src/control-sdk/host.ts'),
      '@control-sdk': resolve(root, 'src/control-sdk/index.ts'),
      '@renderer': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      '@preload': resolve(root, 'src/preload'),
      '@mcp': resolve(root, 'src/mcp'),
      '@providers': resolve(root, 'src/providers'),
    }
    const preload = join(directory, 'preload-source.ts')
    const renderer = join(directory, 'renderer-source.ts')
    const main = join(directory, 'main-source.ts')
    await writeFile(preload, `
      import { contextBridge } from 'electron'
      import { controlApi } from '${resolve(root, 'src/preload/api/control.ts')}'
      contextBridge.exposeInMainWorld('api', controlApi)
    `)
    await writeFile(renderer, `
      import { registerRendererHost } from '${resolve(root, 'src/renderer/src/control/registerRendererHost.ts')}'
      import { workspaceControlCapabilities } from '${resolve(root, 'src/renderer/src/workspace/control.ts')}'
      import { commandControlCapabilities } from '${resolve(root, 'src/renderer/src/features/command-palette/control.ts')}'
      import { keybindingControlCapabilities } from '${resolve(root, 'src/renderer/src/features/command-keybindings/control.ts')}'
      import { documentationCapabilities } from '${resolve(root, 'src/renderer/src/control/documentation.ts')}'
      import { useAppStore } from '${resolve(root, 'src/renderer/src/app-state/store.ts')}'
      const id = location.hash.slice(1)
      useAppStore.setState({ workspaceState: {
        tabs: [{id, title: id, root: {type: 'leaf', sessionId: id + '-agent'}, focusedSessionId: id + '-agent'}],
        activeTabId: id, dispatchMode: null, sessions: { [id + '-agent']: {cwd: '/control-trial/' + id, kind: 'codex'} },
        detachedSessions: {}, buried: [], pinnedSessionIds: []
      }})
      window.changeTrialBinding = () => useAppStore.getState().setSettings({ commandKeybindingOverrides: {'new-tab': ['Cmd+Alt+T']} })
      registerRendererHost([
        ...workspaceControlCapabilities(() => ({restoreStatus: 'fresh'})),
        ...commandControlCapabilities(), ...keybindingControlCapabilities(), ...documentationCapabilities(),
      ])
        .catch(error => { document.body.textContent = String(error); console.error(error) })
    `)
    await writeFile(main, `
      import { app, BrowserWindow } from 'electron'
      import { createControlHost } from '${resolve(root, 'src/main/control/createControlHost.ts')}'
      app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))})
      app.disableHardwareAcceleration()
      app.on('window-all-closed', () => {})
      const windows = new Map()
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
      const deadline = setTimeout(() => { console.error('Control trial deadline'); app.exit(2) }, 25000)
      void app.whenReady().then(async () => {
      app.dock?.hide()
      const host = createControlHost({
        getBrowserWindow: id => windows.get(id) ?? null,
        windowIdFor: sender => [...windows].find(([,window]) => window.webContents === sender)?.[0] ?? null,
        listWindowIds: () => [...windows.keys()],
      }, ${JSON.stringify(join(directory, 'control-history'))})
      const caller = host.forCaller({kind: 'application', id: 'electron-trial'})
      const owner = id => host.catalog().find(row => row.descriptor.id === 'workspace.observe' && row.owner.windowId === id)?.owner
      async function registered(id, previous) {
        for (let attempt=0; attempt<1000; attempt++) {
          const current = owner(id)
          if (current && current.generation !== previous) return current
          await delay(10)
        }
        throw new Error('Renderer did not register: ' + id)
      }
      try {
        for (const id of ['left','right']) {
          const window = new BrowserWindow({show: false, webPreferences: {preload: ${JSON.stringify(join(directory, 'preload.cjs'))}, contextIsolation: true, sandbox: true}})
          window.webContents.on('console-message', event => console.error('renderer ' + id + ': ' + event.message))
          window.webContents.on('preload-error', (_event, _path, error) => console.error('preload: ' + error))
          windows.set(id, window)
          await window.loadFile(${JSON.stringify(join(directory, 'index.html'))}, {hash: id})
        }
        const left = await registered('left')
        const right = await registered('right')
        const observe = target => caller.invoke({capabilityId: 'workspace.observe', input: {}, owner: target})
        const first = await observe(left)
        const second = await observe(right)
        const guide = await caller.invoke({capabilityId: 'app.describe', input: {section: 'ui-map'}, owner: left})
        await windows.get('left').webContents.executeJavaScript('window.changeTrialBinding()')
        const binding = await caller.invoke({capabilityId: 'commands.describe', input: {commandId: 'new-tab'}, owner: left})
        windows.get('left').reload()
        const replacement = await registered('left', left.generation)
        const stale = await observe(left)
        const afterReload = await observe(replacement)
        const surviving = await observe(right)
        console.log('CONTROL_TRIAL=' + JSON.stringify({first,second,guide,binding,stale,afterReload,surviving,changed: left.generation !== replacement.generation}))
        host.dispose()
        for (const window of windows.values()) window.destroy()
        clearTimeout(deadline)
        app.exit(0)
      } catch(error) { console.error(error); app.exit(1) }
      }).catch(error => { console.error(error); app.exit(1) })
    `)
    // Build the actual production registration/preload/host; only composition
    // and initial workspace data are supplied by this isolated trial.
    for (const [entry, name, format, external] of [
      [preload, 'preload.cjs', 'cjs', ['electron']],
      [renderer, 'renderer.js', 'iife', []],
      [main, 'main.mjs', 'es', ['electron', /^node:/]],
    ] as const) {
      await build({
        configFile: false, root, logLevel: 'silent', resolve: { alias },
        // Library mode leaves NODE_ENV to its consumer, whereas the production
        // Electron renderer is an app build. Supply that same browser constant
        // here; exposing a fake Node process would conceal real renderer leaks.
        define: format === 'iife' ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
        build: { target: 'esnext', outDir: directory, emptyOutDir: false, minify: false,
          lib: { entry, name: 'ControlTrial', formats: [format], fileName: () => name },
          rollupOptions: { external: [...external] },
        },
      })
    }
    await writeFile(join(directory, 'index.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"></head><body><script src="renderer.js"></script></body></html>')
    const executable = createRequire(import.meta.url)('electron') as string
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { stdout } = await run(executable, [join(directory, 'main.mjs')], { env: environment, timeout: 35_000, maxBuffer: 2_000_000 })
    const line = stdout.split('\n').find(value => value.startsWith('CONTROL_TRIAL='))
    expect(line, stdout).toBeTruthy()
    const evidence = JSON.parse(line!.slice('CONTROL_TRIAL='.length))
    expect(evidence.first).toMatchObject({ ok: true, value: { activeTabId: 'left' } })
    expect(evidence.second).toMatchObject({ ok: true, value: { activeTabId: 'right' } })
    expect(evidence.stale).toMatchObject({ ok: false, error: { code: 'stale_owner', outcome: 'not_started' } })
    expect(evidence.afterReload).toMatchObject({ ok: true, value: { activeTabId: 'left' } })
    expect(evidence.surviving).toMatchObject({ ok: true, value: { activeTabId: 'right' } })
    expect(evidence.changed).toBe(true)
    expect(evidence.guide).toMatchObject({ ok: true, value: { total: 1, items: [{ id: 'ui-map' }] } })
    expect(evidence.binding).toMatchObject({ ok: true, value: { id: 'new-tab', bindings: ['Cmd+Alt+T'] } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)
