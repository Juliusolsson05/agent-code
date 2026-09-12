import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { installExtensionFromPath } from '../install.js'
import { removeExtension } from '../ledger.js'
import { registerExtensionScheme } from '../scheme.js'
import { extensionStorageGet } from '../storage.js'
import { ExtensionRuntimeService } from '../runtimeService.js'
import { ExtensionRuntimeViews } from '../runtimeViews.js'
import { ExtensionCapabilityService, MAX_EXTENSION_TEXT_FILE_BYTES } from '../capabilityService.js'
import { extensionRevision } from '@shared/types/extensions.js'
import type { ExtensionJson, RuntimeStatus, RuntimeViewEvent } from '@shared/types/extensionRuntime.js'

const root = process.env.AGENT_CODE_EXTENSION_TEST_ROOT
if (!root) throw new Error('An isolated extension test root is required')
// Electron otherwise opens a native exception dialog, which stalls an invisible
// test process and hides the actual stack until the outer watchdog kills it.
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
app.setPath('userData', join(root, 'electron-data'))
registerExtensionScheme()
// This fixture intentionally has zero application windows between generations.
// Keep its main alive so it can assert update/uninstall/restart behavior itself.
app.on('window-all-closed', () => {})

function object(value: ExtensionJson | undefined): Record<string, ExtensionJson> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`${label} timed out`)
}

void (async () => {
  await app.whenReady()
  const hits: string[] = []
  const server = createServer((request, response) => { hits.push(request.url ?? ''); response.end('unexpected egress') })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/private-state`
  const statuses: RuntimeStatus[] = []
  const lifecycle: string[] = []
  const projectRoot = join(root!, 'project')
  await mkdir(join(projectRoot, 'nested'), { recursive: true })
  await writeFile(join(projectRoot, 'nested', 'note.txt'), 'permissioned project text\n')
  await writeFile(join(projectRoot, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(projectRoot, 'large.txt'), 'x'.repeat(MAX_EXTENSION_TEXT_FILE_BYTES + 1))
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', details => {
      if (details.message.startsWith('LIFECYCLE:')) lifecycle.push(details.message)
    })
  })
  const capabilities = new ExtensionCapabilityService({
    resolveSessionRoot: sessionId => sessionId === 'fixture-session' ? projectRoot : null,
  })
  const service = new ExtensionRuntimeService({ preload: process.env.AGENT_CODE_EXTENSION_RUNTIME_PRELOAD ?? join(root!, 'preload.cjs'), capabilities, startupTimeoutMs: 3000, invocationTimeoutMs: 1500, onStatus: status => statuses.push(status) })

  const viewEvents: Array<{ owner: number; event: RuntimeViewEvent }> = []
  const views = new ExtensionRuntimeViews(service, (owner, event) => viewEvents.push({ owner, event }))

  async function install(generation: number, id = 'engine', activation?: string, shutdown = '', activationMode?: 'startup' | 'lazy', permissions: string[] = []) {
    const source = join(root!, 'runtime-sources', id)
    await mkdir(source, { recursive: true })
    // The private host transport is tested before publishing its v2 SDK adapter.
    // Use the currently accepted manifest and existing command/storage contract;
    // no test pretends legacy registerView closures can cross this boundary.
    await writeFile(join(source, 'agent-code.extension.json'), JSON.stringify({
      id, name: id, description: 'Managed runtime integration fixture', version: String(generation), apiVersion: activationMode ? 2 : 1, entry: 'index.js',
      ...(activationMode ? { activationEvents: activationMode === 'startup' ? ['onStartupFinished'] : [`onCommand:${id}.increment`, `onCommand:${id}.read`, `onView:${id}.main`] } : {}),
      ...(permissions.length ? { permissions } : {}),
      contributes: { commands: ['increment', 'snapshot', 'fail', 'hang', 'arm', 'disarm', 'sandbox', 'navigate', 'read'].map(name => ({ id: `${id}.${name}`, title: name })),
        views: [{ id: `${id}.main`, title: id, mount: 'panel', ...(activationMode ? { entry: 'view.js' } : {}) }] },
    }))
    if (activationMode) await writeFile(join(source, 'view.js'), 'export function mount() {}')
    await writeFile(join(source, 'index.js'), `let context;
    export async function deactivate() {
      console.log('LIFECYCLE:${id}:${generation}:deactivate');
      ${shutdown}
      try { await context.api.storage.set('retired-write', true); }
      catch { console.log('LIFECYCLE:${id}:${generation}:revoked'); }
      await new Promise(resolve => setTimeout(resolve, 30));
      console.log('LIFECYCLE:${id}:${generation}:deactivated');
    }
    export async function activate(ctx) {
      context = ctx;
      ctx.subscriptions.push({ async dispose() {
        await new Promise(resolve => setTimeout(resolve, 30));
        console.log('LIFECYCLE:${id}:${generation}:subscription');
      } });
      ${activation ?? ''}
      const activations = (await ctx.api.storage.get('activations') || 0) + 1;
      await ctx.api.storage.set('activations', activations);
      let count = 0, interval;
      const publish = () => ctx.views.publish('${id}.main', { count });
      await publish();
      ctx.registerCommand('${id}.increment', () => ++count);
      ctx.registerCommand('${id}.snapshot', async () => ({ count, activations, generation: ${generation}, runs: await ctx.api.storage.get('runs') || 0 }));
      ctx.registerCommand('${id}.arm', () => { interval = setInterval(() => count++, 20); });
      ctx.registerCommand('${id}.disarm', () => clearInterval(interval));
      ctx.registerCommand('${id}.fail', () => { throw new Error('fixture command failed'); });
      ctx.registerCommand('${id}.read', () => ctx.api.files.readText({ sessionId: 'fixture-session', path: 'nested/note.txt' }));
      ctx.registerCommand('${id}.hang', async () => {
        await ctx.api.storage.set('runs', (await ctx.api.storage.get('runs') || 0) + 1);
        await ctx.api.storage.set('entered', ${generation});
        await new Promise(() => {});
      });
      ctx.registerRequest('identity', (_input, view) => view);
      ctx.registerRequest('slowIdentity', async (_input, view) => { await ctx.api.storage.set('viewCalls', (await ctx.api.storage.get('viewCalls') || 0) + 1); await new Promise(resolve => setTimeout(resolve, 80)); return view; });
      ctx.registerRequest('increment', async (amount, view) => {
        const next = count += amount;
        await publish();
        return { count: next, viewId: view.id, instanceId: view.instanceId };
      });
      ctx.registerCommand('${id}.sandbox', async () => {
        let spoofDenied = false;
        try { await window.agentCodeRuntimeTransport.request({ method: 'storage.get', key: 'activations', extensionId: 'other' }); }
        catch { spoofDenied = true; }
        const fetched = await fetch(${JSON.stringify(endpoint)}).then(() => true, () => false);
        const popup = window.open(${JSON.stringify(endpoint)});
        return { hostApi: typeof window.api, node: typeof require, process: typeof process, spoofDenied, fetched, popup: popup === null };
      });
      ctx.registerCommand('${id}.navigate', () => { setTimeout(() => { location.href = ${JSON.stringify(endpoint)}; }, 0); });
    }`)
    return installExtensionFromPath(source, async () => true)
  }

  try {
    let installed = await install(1)
    let revision = extensionRevision(installed)
    const command = (name: string) => service.invokeCommand('engine', revision, `engine.${name}`)
    await assert.rejects(service.invokeCommand('engine', revision, 'other.private'), /not declared/)
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'invalid commands must not activate code')
    const cold = await Promise.allSettled(Array.from({ length: 40 }, () => command('snapshot')))
    assert.equal(cold.filter(result => result.status === 'fulfilled').length, 32)
    assert.equal(cold.filter(result => result.status === 'rejected' && /Too many extension calls/.test(String(result.reason))).length, 8)
    for (const result of cold) if (result.status === 'fulfilled') assert.equal(object(result.value).activations, 1)
    assert.deepEqual((await Promise.all([command('increment'), command('increment'), command('increment')])).sort(), [1, 2, 3])
    assert.equal(object(await command('snapshot')).activations, 1)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    console.log('PASS runtime: bounded cold commands share one activation and return individual results')

    const first = await views.attach(11, 'view', 'engine', revision, 'engine.main')
    const second = await views.attach(22, 'view', 'engine', revision, 'engine.main')
    assert.notEqual(first.instanceId, second.instanceId, 'view instance identity is minted by main across owners')
    assert.deepEqual(first.snapshot, { sequence: 1, state: { count: 0 } })
    await assert.rejects(views.request(33, 'view', 'identity', null), /connection is closed/)
    const replies = await Promise.all([
      views.request(11, 'view', 'increment', 2),
      views.request(22, 'view', 'increment', 3),
    ])
    assert.equal(object(replies[0]).count, 5)
    assert.equal(object(replies[0]).instanceId, first.instanceId)
    assert.equal(object(replies[1]).count, 8)
    assert.equal(object(replies[1]).instanceId, second.instanceId)
    assert.equal(object(service.viewState('engine', revision, 'engine.main')).count, 8)
    for (const owner of [11, 22]) {
      assert.deepEqual(viewEvents.filter(message => message.owner === owner).map(message => message.event), [
        { kind: 'state', connectionId: 'view', snapshot: { sequence: 2, state: { count: 5 } } },
        { kind: 'state', connectionId: 'view', snapshot: { sequence: 3, state: { count: 8 } } },
      ])
    }
    views.detachOwner(11)
    await assert.rejects(views.request(11, 'view', 'identity', null), /connection is closed/)
    assert.equal(object(await views.request(22, 'view', 'identity', null)).instanceId, second.instanceId)
    const late = views.request(22, 'view', 'slowIdentity', null)
    views.detachOwner(22)
    await assert.rejects(late, /connection is closed/)
    assert.equal(await extensionStorageGet('engine', 'viewCalls'), undefined, 'a closed request must not dispatch after pending ledger I/O')
    await views.attach(22, 'view', 'engine', revision, 'engine.main')
    const running = views.request(22, 'view', 'slowIdentity', null)
    await until(async () => await extensionStorageGet('engine', 'viewCalls') === 1, 'view request entered')
    views.detachOwner(22)
    await assert.rejects(running, /connection is closed/)
    assert.equal(await extensionStorageGet('engine', 'viewCalls'), 1, 'an already dispatched request is never replayed')
    const abandoned = views.attach(44, 'race', 'engine', revision, 'engine.main')
    views.detach(44, 'race')
    const replacement = views.attach(44, 'race', 'engine', revision, 'engine.main')
    await assert.rejects(abandoned, /connection is closed/)
    const attached = await replacement
    assert.equal(object(await views.request(44, 'race', 'identity', null)).instanceId, attached.instanceId)
    const crowded = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => views.attach(55, `view-${index}`, 'engine', revision, 'engine.main')))
    assert.equal(crowded.filter(result => result.status === 'fulfilled').length, 32)
    assert.equal(crowded.filter(result => result.status === 'rejected' && /Too many extension views/.test(String(result.reason))).length, 8)
    views.detachOwner(44)
    views.detachOwner(55)
    console.log('PASS runtime views: owner binding, sequenced state, close during attach/request and bounded connections')
    await command('arm')
    await until(async () => Number(object(await command('snapshot')).count) > 8, 'background ticking')
    await command('disarm')
    assert.equal(object(await command('snapshot')).activations, 1)
    console.log('PASS runtime: distinct view requests share state; background work continues with no visible views')

    await assert.rejects(command('fail'), /fixture command failed/)
    assert.equal(object(await command('snapshot')).activations, 1, 'a handled command failure must not restart the engine')
    assert.deepEqual(await command('sandbox'), { hostApi: 'undefined', node: 'undefined', process: 'undefined', spoofDenied: true, fetched: false, popup: true })
    await command('navigate')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(object(await command('snapshot')).activations, 1, 'renderer navigation must be refused')
    assert.deepEqual(hits, [])
    console.log('PASS runtime: command errors, host/preload isolation, forged namespaces and direct network/navigation denial')

    await views.attach(66, 'update-view', 'engine', revision, 'engine.main')
    const oldRevision = revision
    const interrupted = command('hang').then(() => 'unexpected success', error => String(error))
    await until(async () => await extensionStorageGet('engine', 'entered') === 1, 'first command entered')
    installed = await install(2)
    revision = extensionRevision(installed)
    assert.match(await interrupted, /updated or removed/)
    await assert.rejects(views.request(66, 'update-view', 'identity', null), /connection is closed/)
    assert.ok(viewEvents.some(message => message.owner === 66 && message.event.kind === 'closed'))
    await assert.rejects(service.start('engine', oldRevision), /no longer active/)
    assert.equal(service.viewState('engine', oldRevision, 'engine.main'), undefined)
    assert.deepEqual(await command('snapshot'), { count: 0, activations: 2, generation: 2, runs: 1 })
    assert.deepEqual(lifecycle.filter(message => message.startsWith('LIFECYCLE:engine:1:')), [
      'LIFECYCLE:engine:1:deactivate', 'LIFECYCLE:engine:1:revoked', 'LIFECYCLE:engine:1:deactivated', 'LIFECYCLE:engine:1:subscription',
    ], 'replacement activation must wait for asynchronous author and subscription cleanup')
    assert.equal(await extensionStorageGet('engine', 'retired-write'), undefined)
    console.log('PASS runtime: update revokes pending work and replaces the engine while preserving storage')

    await assert.rejects(command('hang'), /timed out; its result is unknown/)
    assert.deepEqual(await command('snapshot'), { count: 0, activations: 3, generation: 2, runs: 2 })
    console.log('PASS runtime: invocation deadline destroys the stalled engine and never replays the action')

    const removed = command('hang').then(() => 'unexpected success', error => String(error))
    await until(async () => await extensionStorageGet('engine', 'runs') === 3, 'last command entered')
    await removeExtension('engine')
    assert.match(await removed, /updated or removed/)
    await assert.rejects(service.start('engine', revision), /no longer active/)
    assert.equal(await extensionStorageGet('engine', 'activations'), 3)
    installed = await install(3)
    revision = extensionRevision(installed)
    assert.deepEqual(await command('snapshot'), { count: 0, activations: 4, generation: 3, runs: 3 })
    console.log('PASS runtime: uninstall stops execution; reinstall retains saved extension state')

    const startup = await install(1, 'startup-engine', undefined, '', 'startup')
    const lazy = await install(1, 'lazy-engine', undefined, '', 'lazy')
    await service.activateStartupExtensions()
    assert.equal(await extensionStorageGet('startup-engine', 'activations'), 1)
    assert.equal(await extensionStorageGet('lazy-engine', 'activations'), undefined)
    await assert.rejects(service.invokeCommand('lazy-engine', extensionRevision(lazy), 'lazy-engine.snapshot'), /does not declare activation/)
    assert.equal(await service.invokeCommand('lazy-engine', extensionRevision(lazy), 'lazy-engine.increment'), 1)
    await service.activateStartupExtensions()
    assert.equal(await extensionStorageGet('startup-engine', 'activations'), 1, 'startup reconciliation must not activate a live engine twice')
    await install(2, 'startup-engine', undefined, '', 'startup')
    await until(async () => await extensionStorageGet('startup-engine', 'activations') === 2, 'updated startup runtime')
    await assert.rejects(service.start('startup-engine', extensionRevision(startup)), /no longer active/)
    await removeExtension('startup-engine')
    await removeExtension('lazy-engine')
    await until(async () => BrowserWindow.getAllWindows().length === 1, 'startup fixture teardown')
    console.log('PASS runtime activation: explicit startup/lazy rules, update activation and no duplicate startup')

    const reader = await install(1, 'file-engine', undefined, '', 'lazy', ['fs.read'])
    const readerRevision = extensionRevision(reader)
    const fileRead = object(await service.invokeCommand('file-engine', readerRevision, 'file-engine.read'))
    assert.equal(typeof fileRead.mtimeMs, 'number')
    assert.deepEqual({ ...fileRead, mtimeMs: 0 }, {
      sessionId: 'fixture-session', path: 'nested/note.txt', text: 'permissioned project text\n',
      size: 26, mtimeMs: 0,
    })
    await assert.rejects(
      capabilities.invoke('file-engine', readerRevision, { method: 'fs.readText', sessionId: 'fixture-session', path: '../outside.txt' }),
      /escapes project root/,
    )
    await assert.rejects(
      capabilities.invoke('file-engine', readerRevision, { method: 'fs.readText', sessionId: 'missing-session', path: 'nested/note.txt' }),
      /target session is not active/,
    )
    await assert.rejects(
      capabilities.invoke('file-engine', readerRevision, { method: 'fs.readText', sessionId: 'fixture-session', path: 'binary.dat' }),
      /binary files are not supported/,
    )
    await assert.rejects(
      capabilities.invoke('file-engine', readerRevision, { method: 'fs.readText', sessionId: 'fixture-session', path: 'large.txt' }),
      /limited to 98304 bytes/,
    )
    const denied = await install(1, 'denied-engine', undefined, '', 'lazy')
    await assert.rejects(service.invokeCommand('denied-engine', extensionRevision(denied), 'denied-engine.read'), /capability "fs.read" is not granted/)
    await removeExtension('file-engine')
    await removeExtension('denied-engine')
    console.log('PASS runtime files: real preload call, explicit session scope, consent, traversal, binary and size denial')

    const broken = await install(1, 'broken-engine', 'throw new Error("fixture activation failed");')
    await assert.rejects(service.start('broken-engine', extensionRevision(broken)), /fixture activation failed/)
    const hung = await install(1, 'hung-engine', 'await new Promise(() => {});')
    await assert.rejects(service.start('hung-engine', extensionRevision(hung)), /did not finish starting/)
    assert.ok(statuses.some(status => status.extensionId === 'engine' && status.state === 'failed' && status.error?.includes('result is unknown')))
    console.log('PASS runtime: activation errors and hangs are bounded and attributed')
    const stuck = await install(1, 'stuck-cleanup', undefined, 'await new Promise(() => {});')
    await service.start('stuck-cleanup', extensionRevision(stuck))
    await removeExtension('stuck-cleanup')
    const recovered = await install(2, 'stuck-cleanup')
    await service.start('stuck-cleanup', extensionRevision(recovered))
    assert.ok(lifecycle.includes('LIFECYCLE:stuck-cleanup:1:deactivate'))
    assert.ok(!lifecycle.includes('LIFECYCLE:stuck-cleanup:1:deactivated'))
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'hung cleanup must not leave the old runtime alive')
    await service.pause()
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    await assert.rejects(service.start('engine', revision), /shutting down/)
    await service.resume()
    assert.equal(object(await command('snapshot')).activations, 5)
    await service.start('stuck-cleanup', extensionRevision(recovered))
    console.log('PASS runtime: a cancelled quit can resume the service and restart saved engines')
    const disposal = service.dispose()
    assert.equal(service.dispose(), disposal, 'shutdown is idempotent even while cleanup is pending')
    await disposal
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    assert.ok(lifecycle.includes('LIFECYCLE:engine:3:subscription'))
    assert.ok(lifecycle.includes('LIFECYCLE:stuck-cleanup:2:subscription'))
    await assert.rejects(service.start('engine', revision), /host is stopped/)
    console.log('PASS runtime: graceful cleanup has revoked authority; hung cleanup is bounded; disposal drains every window')
    console.log('Extension managed runtime integration checks passed')
  } finally {
    views.dispose()
    await service.dispose()
    capabilities.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  await writeFile(join(root!, 'completed'), 'ok')
  app.quit()
})().catch(error => { console.error(error); app.exit(1) })
