import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'
import { registerExtensionScheme, handleExtensionScheme } from '@main/extensions/scheme.js'
import { installExtensionFromPath } from '@main/extensions/install.js'
import { registerExtensionsIpc } from '@main/ipc/extensions.js'
import { extensionBundleDirectory, removeExtension } from '@main/extensions/ledger.js'
import { extensionRevision, type InstalledExtension } from '@shared/types/extensions.js'
import { ExtensionRuntimeService } from '../runtimeService.js'
import { registerExtensionRuntimeIpc } from '../runtimeIpc.js'
import { registerExtensionInputIpc } from '../nativeInput.js'
import { ExtensionCapabilityService } from '../capabilityService.js'

const root = process.env.AGENT_CODE_EXTENSION_TEST_ROOT
if (!root) throw new Error('An isolated extension test root is required')
// Electron otherwise opens a native exception dialog, which stalls an invisible
// test process and hides the actual stack until the outer watchdog kills it.
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
registerExtensionScheme()
app.setPath('userData', join(root, 'electron-data'))
// Keep the fixture alive while the final hidden runtime acknowledges shutdown.
// Otherwise Electron may exit zero between destroy() and our completion record.
app.on('window-all-closed', () => {})

type Snapshot = { text: string; src: string | null; failures: Array<{ error: string }>; messages: Array<{ kind: string; theme?: string; preload?: string; parentAccessible?: boolean; instanceId?: string; count?: number; command?: string; selected?: string; fileText?: string; fileVersion?: string; writtenPath?: string }> }
type ExternalViewCheck = { viewId: string; selector: string }

async function fixture(id: string, activation: string, mount = '', moduleKind: 'named' | 'default' | 'missing' = 'named'): Promise<InstalledExtension> {
  const folder = join(root!, 'sources', id)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'agent-code.extension.json'), JSON.stringify({
    id, name: id, description: 'Electron lifecycle fixture', version: '1', apiVersion: 1,
    entry: 'index.js', contributes: { views: [{ id: `${id}.main`, title: id, mount: 'panel' }] },
  }))
  const exports = moduleKind === 'named' ? 'export { activate };' : moduleKind === 'default' ? 'export default { activate };' : 'export const fixture = true;'
  await writeFile(join(folder, 'index.js'), `async function activate(context) {
    ${activation}
    context.registerView('${id}.main', root => {
      ${mount}
      root.textContent = 'Fixture view';
      let parentAccessible = false;
      try { parentAccessible = !!window.parent.api; } catch {}
      window.parent.postMessage({kind:'fixture:mount', theme:getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas'), preload:typeof window.api, parentAccessible}, '*');
      return () => window.parent.postMessage({kind:'fixture:cleanup'}, '*');
    });
  }\n${exports}`)
  return installExtensionFromPath(folder)
}

async function waitFor(win: BrowserWindow, predicate: (state: Snapshot) => boolean, label: string): Promise<Snapshot> {
  const deadline = performance.now() + 15_000
  let state: Snapshot | undefined
  while (performance.now() < deadline) {
    state = await win.webContents.executeJavaScript('window.fixtureHarness.snapshot()') as Snapshot
    if (predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`)
}

async function waitForDocumentTeardown(win: BrowserWindow): Promise<void> {
  // Checking the element's src only proves React requested navigation. Ask
  // Chromium which documents still exist so a CSP-blocked about:blank teardown
  // cannot pass while failed extension code continues running underneath.
  const deadline = performance.now() + 2_000
  while (performance.now() < deadline) {
    if (win.webContents.mainFrame.frames.every(frame => !frame.url.startsWith('agent-code-ext:'))) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Failed extension document is still alive: ${win.webContents.mainFrame.frames.map(frame => frame.url).join(', ')}`)
}

async function waitForExtensionElement(win: BrowserWindow, extensionId: string, selector: string): Promise<string> {
  const deadline = performance.now() + 15_000
  let lastUrl = ''
  while (performance.now() < deadline) {
    const frame = win.webContents.mainFrame.frames.find(candidate => candidate.url.startsWith(`agent-code-ext://${extensionId}/`))
    if (frame) {
      lastUrl = frame.url
      const found = await frame.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)
      if (found) return frame.url
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`External extension ${extensionId} did not render ${selector}; last frame was ${lastUrl || 'absent'}`)
}

void (async () => {
  await app.whenReady()
  handleExtensionScheme()
  registerExtensionsIpc()
  const trusted = new Set<number>()
  const runtimeStarts: string[] = []
  const projectRoot = join(root!, 'extension-project')
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'extension-readable.txt'), 'SDK service boundary\n')
  const capabilities = new ExtensionCapabilityService({
    resolveSessionRoot: sessionId => sessionId === 'fixture-session' ? projectRoot : null,
  })
  const service = new ExtensionRuntimeService({ preload: join(root!, 'runtime-preload.cjs'), capabilities, onStatus: status => {
    if (status.state === 'starting') runtimeStarts.push(status.extensionId)
  } })
  const inputBindings = new Map<number, readonly string[]>()
  const nativeInputs: Array<{ owner: number; key: string; prevented: boolean }> = []
  const observedInputOwners = new Set<number>()
  const unregisterInput = registerExtensionInputIpc(contents => trusted.has(contents.id), (owner, bindings) => {
    inputBindings.set(owner, bindings)
    if (!observedInputOwners.has(owner)) {
      observedInputOwners.add(owner)
      // Observe after the production listener to distinguish forwarded chords
      // from native editing which the host must leave in the child document.
      webContents.fromId(owner)!.on('before-input-event', (event, input) => nativeInputs.push({ owner, key: input.key, prevented: event.defaultPrevented }))
    }
  })
  const unregisterRuntime = registerExtensionRuntimeIpc(service, capabilities, contents => trusted.has(contents.id))
  await fixture('fast', '')
  await fixture('slow', 'await new Promise(resolve => setTimeout(resolve, 250));')
  await fixture('default-module', '', '', 'default')
  await fixture('missing-activate', '', '', 'missing')
  await fixture('broken', '', 'throw new Error("fixture mount failed");')
  await fixture('late-broken', 'await new Promise(resolve => setTimeout(resolve, 250));', 'throw new Error("late fixture mount failed");')
  await fixture('activation-error', 'throw new Error("fixture activation failed");')
  await fixture('missing-view', 'return;')
  await fixture('undeclared', 'context.registerView("undeclared.other", () => {});')
  await fixture('syntax-error', 'if (')
  await fixture('denied', 'await context.api.sessions.observe();')
  await fixture('storage', `await context.api.storage.set('value', { nested: [1, true, null] });
    const value = await context.api.storage.get('value');
    if (JSON.stringify(value) !== '{"nested":[1,true,null]}') throw new Error('storage round trip failed');
    if (!(await context.api.storage.keys()).includes('value')) throw new Error('storage key missing');
    await context.api.storage.delete('value');
    if (await context.api.storage.get('value') !== undefined) throw new Error('storage delete failed');`)
  // The bootstrap is synthesized from the ledger; missing bytes fail its real
  // dynamic import. An unknown contributed view below instead gets an error
  // document with no bootstrap at all. Keep both failure paths executable.
  const missing = await fixture('missing-bundle', '')
  await rm(extensionBundleDirectory(missing), { recursive: true })
  await fixture('no-boot', '')
  await fixture('retry', `const attempts = (await context.api.storage.get('attempts') || 0) + 1;
    await context.api.storage.set('attempts', attempts);
    if (attempts === 1) await new Promise(() => {});`)
  const externalSource = process.env.AGENT_CODE_EXTENSION_EXTERNAL_SOURCE
  const externalChecks = JSON.parse(process.env.AGENT_CODE_EXTENSION_EXTERNAL_VIEWS ?? '[]') as ExternalViewCheck[]
  // This path installs an author's actual built directory into the same isolated
  // ledger as the synthetic fixtures. It exists because a browser preview can
  // prove the UI and the host fixture can prove the shell, while neither alone
  // catches a real manifest/entry/scheme mismatch in the author's bundle.
  const external = externalSource ? await installExtensionFromPath(externalSource, async () => true) : null
  if (external) {
    assert.equal(external.manifest.apiVersion, 2, 'external integration checks require an API v2 bundle')
    for (const check of externalChecks) {
      const declaredMount: string | undefined = external.manifest.contributes?.views?.find(
        (view: { id: string; mount: string }) => view.id === check.viewId,
      )?.mount
      assert.equal(declaredMount, 'modal', `${check.viewId} must be a contributed modal view`)
    }
  }
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { preload: join(root!, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  trusted.add(win.webContents.id)
  try {
    await win.loadFile(join(root!, 'host.html'))
    for (const [id, delay] of [['fast', 250], ['slow', 0], ['storage', 0], ['default-module', 0]] as const) {
      await win.webContents.executeJavaScript(`window.fixtureHarness.render(${JSON.stringify(id)}, ${delay})`)
      const state = await waitFor(win, state => state.messages.some(message => message.kind === 'fixture:mount'), `${id} mount`)
      const mounts = state.messages.filter(message => message.kind === 'fixture:mount')
      assert.equal(mounts.length, 1, 'mount must happen once')
      assert.equal(mounts[0]!.theme, 'rgb(1, 2, 3)', `${id}: theme must exist at first mount`)
      assert.equal(mounts[0]!.preload, 'undefined', 'extension must not receive host preload')
      assert.equal(mounts[0]!.parentAccessible, false, 'extension must not reach parent API')
      console.log(`PASS ${id}: one themed mount, sandbox and host preload isolation`)
    }
    for (const [id, error, viewId] of [
      ['broken', 'fixture mount failed'], ['late-broken', 'late fixture mount failed'],
      ['activation-error', 'fixture activation failed'], ['missing-view', 'was not registered'],
      ['missing-activate', 'must export activate(context)'],
      ['undeclared', 'not declared in contributes.views'], ['syntax-error', 'Unexpected'],
      ['denied', 'is not granted'], ['missing-bundle', 'Failed to fetch dynamically imported module'],
      ['no-boot', 'bundle may be missing or blocked', 'no-boot.absent'],
    ]) {
      await win.webContents.executeJavaScript(`window.fixtureHarness.render(${JSON.stringify(id)}, 0, false, ${JSON.stringify(viewId ?? `${id}.main`)})`)
      const state = await waitFor(win, state => state.text.includes(error!) && state.text.includes('Retry'), `${id} actionable failure`)
      assert.equal(state.src, 'about:blank', 'failed document must be torn down')
      await waitForDocumentTeardown(win)
      assert.ok(state.failures.some(failure => failure.error.includes(error!)), 'settings must retain the cause')
      assert.equal(state.messages.filter(message => message.kind === 'fixture:mount').length, 0)
      console.log(`PASS ${id}: actionable failure, Settings cause and document teardown`)
    }
    await win.webContents.executeJavaScript('window.fixtureHarness.render("fast", 0, true)')
    await waitFor(win, state => state.text.includes('fixture theme unavailable') && state.src === 'about:blank', 'theme failure')
    await waitForDocumentTeardown(win)
    console.log('PASS theme failure: surfaced before mount')
    await win.webContents.executeJavaScript('window.fixtureHarness.render("retry", 0)')
    await waitFor(win, state => state.text.includes('failed to start') && state.text.includes('Retry'), 'activation deadline')
    await waitForDocumentTeardown(win)
    await win.webContents.executeJavaScript('window.fixtureHarness.retry()')
    await waitFor(win, state => state.messages.some(message => message.kind === 'fixture:mount'), 'successful retry')
    console.log('PASS activation deadline: fresh retry succeeds with durable storage from first attempt')
    // Built by the SDK's typed author fixture and real multi-entry Vite preset.
    // Handwritten JS here would miss drift in the published helpers and output.
    const managed = await installExtensionFromPath(join(root!, 'author-bundle'), async () => true)
    const revision = extensionRevision(managed)
    await win.webContents.executeJavaScript('window.fixtureHarness.unmount()')
    await win.webContents.executeJavaScript('window.fixtureHarness.showThemes()')
    await waitFor(win, state => state.text.includes('Counter Night'), 'SDK contribution in the actual appearance picker')
    await win.webContents.executeJavaScript('window.fixtureHarness.chooseTheme()')
    assert.deepEqual(await win.webContents.executeJavaScript('window.fixtureHarness.themeSnapshot()'), { mode: 'extension-theme:managed.night', canvas: '#102030', appliedMode: 'custom' })
    assert.ok(!runtimeStarts.includes('managed'), 'selecting a declarative theme must not execute extension code')
    const command = (name: string) => win.webContents.executeJavaScript(`window.api.extensionsRuntimeCommand('managed', ${JSON.stringify(revision)}, ${JSON.stringify(`managed.${name}`)})`)
    await assert.rejects(command('snapshot'), /does not declare activation/)
    assert.equal(await command('increment'), 1)
    assert.deepEqual(await command('snapshot'), { count: 1, activations: 1 })
    const managedRead = await command('read') as Record<string, unknown>
    assert.equal(typeof managedRead.mtimeMs, 'number')
    assert.equal(typeof managedRead.version, 'string')
    const { mtimeMs: _managedMtime, version: _managedVersion, ...stableManagedRead } = managedRead
    assert.deepEqual(stableManagedRead, {
      sessionId: 'fixture-session', path: 'extension-readable.txt', text: 'SDK service boundary\n', size: 21,
    })
    const managedWrite = await command('write') as Record<string, unknown>
    assert.equal(managedWrite.path, 'extension-runtime-written.txt')
    assert.equal(typeof managedWrite.version, 'string')
    assert.equal(await readFile(join(projectRoot, 'extension-runtime-written.txt'), 'utf8'), 'written by SDK runtime\n')
    assert.equal((await win.webContents.executeJavaScript('window.fixtureHarness.snapshot()')).src, null, 'cold commands must not open a view')
    await win.webContents.executeJavaScript('window.fixtureHarness.render("managed", 0, false, "managed.main", false, true)')
    const firstView = await waitFor(win, state => state.messages.some(message => message.kind === 'fixture:mount') && state.messages.some(message => message.kind === 'fixture:file'), 'first managed view and scoped file read')
    const firstFile = firstView.messages.find(message => message.kind === 'fixture:file')!
    assert.equal(firstFile.fileText, 'SDK service boundary\n')
    assert.equal(typeof firstFile.fileVersion, 'string')
    assert.match(String(firstFile.writtenPath), /^extension-view-[0-9a-f-]+\.txt$/)
    assert.equal(await readFile(join(projectRoot, String(firstFile.writtenPath)), 'utf8'), 'written by SDK view\n')
    const other = new BrowserWindow({ show: false, webPreferences: { preload: join(root!, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    trusted.add(other.webContents.id)
    try {
      await other.loadFile(join(root!, 'host.html'))
      await other.webContents.executeJavaScript('window.fixtureHarness.render("managed", 0)')
      const secondView = await waitFor(other, state => state.messages.some(message => message.kind === 'fixture:mount'), 'second managed view')
      const firstMount = firstView.messages.find(message => message.kind === 'fixture:mount')!
      const secondMount = secondView.messages.find(message => message.kind === 'fixture:mount')!
      assert.notEqual(firstMount.instanceId, secondMount.instanceId)
      assert.equal(firstMount.theme?.trim(), '#102030', 'the installed theme must reach the real child before mount')
      assert.equal(secondMount.preload, 'undefined')
      assert.equal(await command('increment'), 2)
      for (const owner of [win, other]) await waitFor(owner, state => state.messages.some(message => message.kind === 'fixture:state' && message.count === 2), 'shared managed state')
      const child = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('agent-code-ext://managed/'))!
      const waitBindings = async (binding: string) => {
        const deadline = performance.now() + 3000
        while (!inputBindings.get(win.webContents.id)?.includes(binding)) {
          if (performance.now() > deadline) throw new Error('Application did not publish native binding ' + binding)
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      await waitBindings('Cmd+Shift+P')
      await child.executeJavaScript('document.body.tabIndex = 0; document.body.focus()')
      await win.webContents.executeJavaScript('window.fixtureHarness.resetInput()')
      // Forged DOM keys/postMessage must never become application authority.
      await child.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', metaKey: true, shiftKey: true, bubbles: true })); parent.postMessage({ kind: 'extensions:native-input', input: { key: 'W', metaKey: true } }, '*')`)
      assert.equal((await win.webContents.executeJavaScript('window.fixtureHarness.snapshot()')).messages.filter((message: { kind: string }) => message.kind === 'fixture:command').length, 0)
      const press = (keyCode: string, modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']>) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      }
      press('P', ['meta', 'shift'])
      await waitFor(win, state => state.messages.some(message => message.command === 'open-command-palette' && message.selected === 'extension'), 'native palette and pane focus')
      await win.webContents.executeJavaScript('window.fixtureHarness.resetInput()')
      press('W', ['meta'])
      await waitFor(win, state => state.messages.some(message => message.command === 'close-pane' && message.selected === 'extension'), 'native close targets its extension pane')
      await win.webContents.executeJavaScript('window.fixtureHarness.resetInput(); window.fixtureHarness.rebindPalette()')
      await waitBindings('Ctrl+Shift+K')
      press('K', ['control', 'shift'])
      const customized = await waitFor(win, state => state.messages.some(message => message.command === 'open-command-palette'), 'customized native palette binding')
      assert.equal(customized.messages.filter(message => message.kind === 'fixture:command').length, 1)
      assert.ok(!inputBindings.get(win.webContents.id)?.includes('Cmd+Shift+P'), 'removed default chord must stop capture')
      console.log('PASS native input: forged child keys denied, real palette/close commands select the right pane, customized bindings route once')
      const oldDocument = child.url
      await win.webContents.executeJavaScript('window.fixtureHarness.render("managed", 0, false, "managed.main", true)')
      await waitFor(win, state => state.messages.some(message => message.kind === 'fixture:mount'), 'managed modal mount')
      const modal = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('agent-code-ext://managed/'))!
      await modal.executeJavaScript('document.body.tabIndex = 0; document.body.focus()')
      await win.webContents.executeJavaScript('window.fixtureHarness.resetInput()')
      win.webContents.send('extensions:native-input', { kind: 'key', url: oldDocument, type: 'keydown', input: { key: 'W', code: 'KeyW', metaKey: true } })
      press('D', ['alt'])
      await new Promise(resolve => setTimeout(resolve, 40))
      const nativeEditing = nativeInputs.filter(input => input.owner === win.webContents.id && input.key.toLowerCase() === 'd')
      assert.ok(nativeEditing.length > 0 && nativeEditing.every(input => !input.prevented), 'a modal must retain native Option editing')
      const untouched = await win.webContents.executeJavaScript('window.fixtureHarness.snapshot()')
      assert.equal(untouched.messages.filter((message: { kind: string }) => ['fixture:command', 'fixture:close'].includes(message.kind)).length, 0, 'stale input and modal editing cannot affect the hidden workspace')
      press('K', ['control', 'shift'])
      await waitFor(win, state => state.messages.some(message => message.command === 'open-command-palette'), 'palette access inside a real modal shell')
      press('W', ['meta'])
      await waitFor(win, state => state.src === null && state.messages.some(message => message.kind === 'fixture:close'), 'native close removes only the modal surface')
      await waitForDocumentTeardown(win)
      console.log('PASS native modal: stale document rejected, native editing preserved, palette accessible and close removes the owned surface')
      const stranger = new BrowserWindow({ show: false, webPreferences: { preload: join(root!, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        await stranger.loadFile(join(root!, 'host.html'))
        await assert.rejects(stranger.webContents.executeJavaScript('window.api.extensionsSetInputBindings({ pane: ["Cmd+W"], modal: [] })'), /application main frame/)
      } finally { stranger.destroy() }

      await win.webContents.executeJavaScript('window.fixtureHarness.unmount()')
      assert.deepEqual(await command('snapshot'), { count: 2, activations: 1 })
      await other.webContents.executeJavaScript('window.fixtureHarness.unmount()')
      await command('arm')
      // Coverage and busy runners can delay a renderer timer beyond 100 ms.
      // Observe bounded progress rather than asserting one scheduler timeslice;
      // only this read is repeated, never the command that starts background work.
      const deadline = performance.now() + 3000
      let snapshot = await command('snapshot')
      while (snapshot.count <= 2 && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        snapshot = await command('snapshot')
      }
      assert.ok(snapshot.count > 2, 'background runtime must progress with every view closed')
      assert.equal(snapshot.activations, 1)
      console.log('PASS public v2: cold commands, independent view modules in two windows, shared state and zero-view background work')

      if (external) {
        let firstDocument = ''
        for (const [index, check] of externalChecks.entries()) {
          await win.webContents.executeJavaScript(`window.fixtureHarness.render(${JSON.stringify(external.manifest.id)}, 0, false, ${JSON.stringify(check.viewId)}, true, true)`)
          const documentUrl = await waitForExtensionElement(win, external.manifest.id, check.selector)
          if (index === 0) firstDocument = documentUrl
          const state = await win.webContents.executeJavaScript('window.fixtureHarness.snapshot()') as Snapshot
          assert.equal(state.failures.some(failure => failure.error.includes(external.manifest.id)), false)
          const frame = win.webContents.mainFrame.frames.find(candidate => candidate.url === documentUrl)!
          await frame.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
          await waitFor(win, snapshot => snapshot.src === null && snapshot.messages.some(message => message.kind === 'fixture:close'), `${check.viewId} modal close`)
          await waitForDocumentTeardown(win)
        }
        if (externalChecks.length > 0) {
          const check = externalChecks[0]!
          await win.webContents.executeJavaScript(`window.fixtureHarness.render(${JSON.stringify(external.manifest.id)}, 0, false, ${JSON.stringify(check.viewId)}, true, true)`)
          const reopened = await waitForExtensionElement(win, external.manifest.id, check.selector)
          assert.notEqual(reopened, firstDocument, 'reopening must create a fresh sandbox document')
          await win.webContents.executeJavaScript('window.fixtureHarness.unmount()')
          await waitForDocumentTeardown(win)
        }
        console.log(`PASS external v2 bundle: installed ${external.manifest.id}; mounted, closed and reopened ${externalChecks.length} modal views`)
      }

      // Theme ownership follows the real installer/catalog, independently of
      // any runtime. A failed update must leave the selected palette intact;
      // uninstall/reinstall must retain the preference without saved-theme copies.
      await win.webContents.executeJavaScript('window.fixtureHarness.showThemes()')
      const sourceManifestPath = join(root!, 'author-bundle', 'agent-code.extension.json')
      const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
      sourceManifest.contributes.themes[0].colors.canvas = '#304050'
      await writeFile(sourceManifestPath, JSON.stringify(sourceManifest))
      await installExtensionFromPath(join(root!, 'author-bundle'), async () => true)
      await win.webContents.executeJavaScript('window.fixtureHarness.refreshThemes()')
      assert.deepEqual(await win.webContents.executeJavaScript('window.fixtureHarness.themeSnapshot()'), { mode: 'extension-theme:managed.night', canvas: '#304050', appliedMode: 'custom' })
      sourceManifest.contributes.themes[0].colors.canvas = 'url(https://example.test/track)'
      await writeFile(sourceManifestPath, JSON.stringify(sourceManifest))
      await assert.rejects(installExtensionFromPath(join(root!, 'author-bundle')), /colors.canvas/)
      await win.webContents.executeJavaScript('window.fixtureHarness.refreshThemes()')
      assert.equal((await win.webContents.executeJavaScript('window.fixtureHarness.themeSnapshot()')).canvas, '#304050')
      await removeExtension('managed')
      await win.webContents.executeJavaScript('window.fixtureHarness.refreshThemes()')
      const absent = await win.webContents.executeJavaScript('window.fixtureHarness.themeSnapshot()')
      assert.equal(absent.mode, 'extension-theme:managed.night')
      assert.equal(absent.appliedMode, 'dark')
      sourceManifest.contributes.themes[0].colors.canvas = '#304050'
      await writeFile(sourceManifestPath, JSON.stringify(sourceManifest))
      const startsBeforeReinstall = runtimeStarts.length
      await installExtensionFromPath(join(root!, 'author-bundle'), async () => true)
      await win.webContents.executeJavaScript('window.fixtureHarness.refreshThemes()')
      assert.equal((await win.webContents.executeJavaScript('window.fixtureHarness.themeSnapshot()')).canvas, '#304050')
      assert.equal(runtimeStarts.length, startsBeforeReinstall)
      await win.webContents.executeJavaScript('window.fixtureHarness.unmount()')
      console.log('PASS contributed themes: SDK install/picker/live view, update, invalid update recovery and uninstall/reinstall without activation')
    } finally { other.destroy() }
    console.log('Extension Electron integration checks passed')
  } finally { win.destroy(); unregisterInput(); unregisterRuntime(); await service.dispose(); capabilities.dispose() }
  await writeFile(join(root!, 'completed'), 'ok')
  app.quit()
})().catch(error => { console.error(error); app.exit(1) })
