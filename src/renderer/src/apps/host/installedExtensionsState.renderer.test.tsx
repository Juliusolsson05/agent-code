import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { AppsSettingsRow } from '@renderer/apps/ui/AppsSettingsRow'
import { InstalledExtensionsLoader } from './InstalledExtensionsLoader'
import { acceptExtensionPublication, forgetRemovedExtension, refreshInstalledExtensions } from './installedExtensionsState'
import { createFrameHost } from './frameHost'
import { deriveExtensionCommands } from './derive'
import type { AgentCodeApiV1 } from '@renderer/apps/api/types'
import type { ExtensionListEntry, InstalledExtension } from '@shared/types/extensions'

function entry(generation = 'generation-one'): ExtensionListEntry {
  return {
    manifest: { id: 'timer', name: 'Timer', description: 'A timer', apiVersion: 1, version: '1', entry: 'dist/index.js' },
    origin: 'local', repo: '/fixture/timer', ref: 'local', sha256: 'a'.repeat(64), installedAt: 1,
    installation: { id: generation, bundleSha256: 'b'.repeat(64) }, present: true,
  }
}

const originalApi = window.api
beforeEach(() => {
  acceptExtensionPublication([]) // invalidates any prior pending list promise
  useAppStore.setState({ installedExtensionsLoaded: false, installedExtensionsError: null, extensionFailures: [] })
  window.api = {
    ...originalApi,
    extensionsList: vi.fn().mockResolvedValue([]),
    onExtensionsChanged: vi.fn().mockReturnValue(() => {}),
    extensionGrantedCapabilities: vi.fn().mockResolvedValue([]),
    extensionsServiceRequest: vi.fn(),
  }
})
afterEach(() => { window.api = originalApi })

describe('one ordered extension catalog per window', () => {
  it('does not resurrect a removed extension from a slow startup response', async () => {
    let resolve!: (rows: ExtensionListEntry[]) => void
    window.api.extensionsList = vi.fn(() => new Promise<ExtensionListEntry[]>(done => { resolve = done }))
    const pending = refreshInstalledExtensions()
    acceptExtensionPublication([])
    resolve([entry()])
    await pending
    expect(useAppStore.getState().installedExtensions).toEqual([])
  })

  it('subscribes before loading and applies another window’s publication even if refresh fails', async () => {
    let publish!: (rows: InstalledExtension[]) => void
    window.api.onExtensionsChanged = vi.fn(handler => { publish = handler; return () => {} })
    window.api.extensionsList = vi.fn().mockRejectedValue(new Error('list unavailable'))
    render(<InstalledExtensionsLoader><AppsSettingsRow /></InstalledExtensionsLoader>)
    await screen.findByRole('alert')
    act(() => { publish([entry()]) })
    expect(await screen.findByText('Timer')).toBeTruthy()
    act(() => { publish([]) })
    await waitFor(() => { expect(screen.queryByText('Timer')).toBeNull() })
    expect(useAppStore.getState().installedExtensions).toEqual([])
  })

  it('lets the user retry a failed initial load', async () => {
    window.api.extensionsList = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue([entry()])
    render(<AppsSettingsRow />)
    expect(await screen.findByRole('alert')).toHaveTextContent('read failed')
    expect(screen.queryByText('No extensions installed.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading extensions' }))
    expect(await screen.findByText('Timer')).toBeTruthy()
    expect(useAppStore.getState().installedExtensionsError).toBeNull()
  })

  it('retains an installed row when both removal and refresh fail', async () => {
    window.api.extensionsList = vi.fn().mockResolvedValueOnce([entry()]).mockRejectedValue(new Error('list failed'))
    window.api.extensionsRemove = vi.fn().mockRejectedValue(new Error('remove failed'))
    render(<AppsSettingsRow />)
    await screen.findByText('Timer')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => { expect(screen.getByRole('alert')).toHaveTextContent('remove failed') })
    expect(screen.getByText('Timer')).toBeTruthy()
    expect(useAppStore.getState().installedExtensions).toHaveLength(1)
  })

  it('a delayed removal acknowledgement cannot discard a later reinstall', () => {
    acceptExtensionPublication([entry('new-generation')])
    forgetRemovedExtension(entry('old-generation'))
    expect(useAppStore.getState().installedExtensions[0]!.installation!.id).toBe('new-generation')
  })

  it('uses the extension description when a command description is blank', () => {
    const installed = entry()
    installed.manifest.contributes = { commands: [{ id: 'timer.start', title: 'Start timer', description: '   ' }] }
    expect(deriveExtensionCommands([installed], () => {})[0]!.description).toBe('A timer')
  })
})

describe('publication revokes a live frame before React removes its DOM', () => {
  it('pins filesystem service identity to the frame owner and denies an ungranted call before main IPC', async () => {
    acceptExtensionPublication([entry()])
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    const service = vi.fn().mockResolvedValue({
      sessionId: 'session-one', path: 'notes.txt', text: 'hello', size: 5, mtimeMs: 1,
    })
    window.api.extensionsServiceRequest = service
    window.api.extensionGrantedCapabilities = vi.fn().mockResolvedValue([
      'fs.read', 'fs.write', 'notifications.show',
    ])
    const host = createFrameHost({ iframe, extensionId: 'timer', bundleRevision: 'generation-one', api: {} as AgentCodeApiV1 })
    const send = (id: string, request: Record<string, unknown> = {
      method: 'fs.readText', sessionId: 'session-one', path: 'notes.txt',
    }) => window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: 'agent-code-ext://timer',
      data: { kind: 'agent-code-ext:request', id, request },
    }))
    try {
      send('allowed')
      await waitFor(() => expect(service).toHaveBeenCalledWith(
        'timer', 'generation-one',
        { method: 'fs.readText', sessionId: 'session-one', path: 'notes.txt' },
      ))
      await waitFor(() => expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'allowed', ok: true }), 'agent-code-ext://timer',
      ))
      send('write-allowed', {
        method: 'fs.writeText', sessionId: 'session-one', path: 'notes.txt',
        text: 'updated', expectedVersion: 'opaque-version',
      })
      await waitFor(() => expect(service).toHaveBeenCalledWith(
        'timer', 'generation-one',
        {
          method: 'fs.writeText', sessionId: 'session-one', path: 'notes.txt',
          text: 'updated', expectedVersion: 'opaque-version',
        },
      ))
      send('notification-allowed', {
        method: 'notifications.show', message: 'Focus session complete',
      })
      await waitFor(() => expect(service).toHaveBeenCalledWith(
        'timer', 'generation-one',
        { method: 'notifications.show', message: 'Focus session complete' },
      ))

      host.dispose()
      service.mockClear()
      window.api.extensionGrantedCapabilities = vi.fn().mockResolvedValue([])
      const deniedHost = createFrameHost({ iframe, extensionId: 'timer', bundleRevision: 'generation-one', api: {} as AgentCodeApiV1 })
      send('denied', {
        method: 'fs.writeText', sessionId: 'session-one', path: 'notes.txt',
        text: 'denied', expectedVersion: 'opaque-version',
      })
      await waitFor(() => expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'denied', ok: false }), 'agent-code-ext://timer',
      ))
      expect(service).not.toHaveBeenCalled()
      send('notification-denied', {
        method: 'notifications.show', message: 'Should not appear',
      })
      await waitFor(() => expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'notification-denied', ok: false }),
        'agent-code-ext://timer',
      ))
      expect(service).not.toHaveBeenCalled()
      deniedHost.dispose()
    } finally { host.dispose(); iframe.remove() }
  })

  it('does not send an old pending reply into a replacement document at the same origin', async () => {
    acceptExtensionPublication([entry()])
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    let finish!: (value: string) => void
    const pending = new Promise<string>(resolve => { finish = resolve })
    const read = vi.fn(() => pending)
    const host = createFrameHost({ iframe, extensionId: 'timer', bundleRevision: 'generation-one', api: { storage: { get: read } } as unknown as AgentCodeApiV1 })
    try {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow, origin: 'agent-code-ext://timer',
        data: { kind: 'agent-code-ext:request', id: 'old-attempt', request: { method: 'storage.get', key: 'saved' } },
      }))
      expect(read).toHaveBeenCalledOnce()
      host.dispose()
      finish('private state')
      // Await the request's settlement and the broker's chained reply callback.
      // The WindowProxy intentionally stays alive: navigation/retry retains it,
      // so removing the iframe would hide the stale-reply regression.
      await pending
      await Promise.resolve()
      await Promise.resolve()
      expect(post).not.toHaveBeenCalled()
    } finally { host.dispose(); iframe.remove() }
  })

  it('refuses requests from a removed installation', async () => {
    acceptExtensionPublication([entry()])
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    const read = vi.fn().mockResolvedValue('saved')
    const host = createFrameHost({ iframe, extensionId: 'timer', bundleRevision: 'generation-one', api: { storage: { get: read } } as unknown as AgentCodeApiV1 })
    const request = (id: string) => window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, origin: 'agent-code-ext://timer',
      data: { kind: 'agent-code-ext:request', id, request: { method: 'storage.get', key: 'saved' } },
    }))
    try {
      request('before')
      await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
      acceptExtensionPublication([])
      request('after')
      await waitFor(() => { expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 'after', ok: false }), 'agent-code-ext://timer') })
      expect(read).toHaveBeenCalledOnce()
    } finally { host.dispose(); iframe.remove() }
  })

  it('rechecks installation identity after a delayed permission lookup', async () => {
    acceptExtensionPublication([entry()])
    let grant!: (capabilities: ['workspace.observe']) => void
    window.api.extensionGrantedCapabilities = vi.fn(() => new Promise<['workspace.observe']>(resolve => { grant = resolve }))
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    const observe = vi.fn()
    const host = createFrameHost({ iframe, extensionId: 'timer', bundleRevision: 'generation-one', api: { workspace: { observe } } as unknown as AgentCodeApiV1 })
    try {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow, origin: 'agent-code-ext://timer',
        data: { kind: 'agent-code-ext:request', id: 'observe', request: { method: 'workspace.observe' } },
      }))
      acceptExtensionPublication([entry('generation-two')])
      grant(['workspace.observe'])
      await waitFor(() => { expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 'observe', ok: false }), 'agent-code-ext://timer') })
      expect(observe).not.toHaveBeenCalled()
    } finally { host.dispose(); iframe.remove() }
  })
})

it('routes a v2 action without opening a view and preserves its failure for the command gateway', async () => {
  const managed = entry()
  managed.manifest.apiVersion = 2
  managed.manifest.contributes = {
    commands: [{ id: 'timer.start', title: 'Start' }],
    views: [{ id: 'timer.main', title: 'Timer', mount: 'panel', entry: 'view.js' }],
  }
  const invoke = vi.fn().mockRejectedValue(new Error('fixture command failed'))
  window.api.extensionsRuntimeCommand = invoke
  const modal = vi.fn(), panel = vi.fn(), closePalette = vi.fn()
  const command = deriveExtensionCommands([managed], modal, panel)[0]!
  await expect(command.run({ ui: { closePalette } } as never)).rejects.toThrow('fixture command failed')
  expect(invoke).toHaveBeenCalledWith('timer', 'generation-one', 'timer.start')
  expect(modal).not.toHaveBeenCalled()
  expect(panel).not.toHaveBeenCalled()
  expect(closePalette).toHaveBeenCalledOnce()
})
