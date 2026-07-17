import { EventEmitter } from 'events'
import { mkdtemp, mkdir, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { EditorFsRootRegistry } from './editorFsRootRegistry.js'

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('EditorFsRootRegistry', () => {
  it('admits only main-known session roots and binds the grant to one renderer', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-code-editor-roots-'))
    tempRoots.push(base)
    const allowed = join(base, 'allowed')
    const arbitrary = join(base, 'arbitrary')
    await mkdir(allowed)
    await mkdir(arbitrary)
    let live = true
    const manager = {
      list: () => (live ? ['session-1'] : []),
      getSpawnCwd: (id: string) => (id === 'session-1' ? allowed : null),
    }
    const registry = new EditorFsRootRegistry(manager as never)
    const owner = new FakeWebContents(1)
    const otherOwner = new FakeWebContents(2)
    const canonicalAllowed = await realpath(allowed)

    await expect(registry.authorize(owner as never, arbitrary)).rejects.toThrow('not authorized')
    await expect(registry.authorize(owner as never, allowed)).resolves.toBe(canonicalAllowed)

    // A granted editor tab remains usable after its agent exits, but another
    // renderer cannot inherit that authority by guessing the same path.
    live = false
    await expect(registry.authorize(owner as never, allowed)).resolves.toBe(canonicalAllowed)
    await expect(registry.authorize(otherOwner as never, allowed)).rejects.toThrow('not authorized')
  })

  it('clears grants on main-frame navigation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-editor-roots-'))
    tempRoots.push(root)
    let live = true
    const manager = {
      list: () => (live ? ['session-1'] : []),
      getSpawnCwd: () => root,
    }
    const registry = new EditorFsRootRegistry(manager as never)
    const owner = new FakeWebContents(3)
    await registry.authorize(owner as never, root)
    live = false

    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await expect(registry.authorize(owner as never, root)).rejects.toThrow('not authorized')
  })

  it('lets the first renderer claim a main-observed cwd after its session exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-editor-roots-'))
    tempRoots.push(root)
    const manager = Object.assign(new EventEmitter(), {
      list: () => [] as string[],
      getSpawnCwd: (sessionId: string) => (sessionId === 'finished-session' ? root : null),
    })
    const registry = new EditorFsRootRegistry(manager as never)
    manager.emit('started', { sessionId: 'finished-session' })
    const owner = new FakeWebContents(5)
    const otherOwner = new FakeWebContents(6)

    await expect(registry.authorize(owner as never, root)).resolves.toBe(await realpath(root))
    await expect(registry.authorize(otherOwner as never, root)).rejects.toThrow('not authorized')
  })
})
