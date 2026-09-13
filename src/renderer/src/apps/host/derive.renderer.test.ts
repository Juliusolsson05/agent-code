import { describe, expect, it } from 'vitest'

import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import type { ExtensionListEntry } from '@shared/types/extensions'
import { deriveExtensionCommands, deriveExtensionKeybindings } from './derive'

function installed(id: string, commandId: string, keys: string[]): ExtensionListEntry {
  return {
    present: true, origin: 'local', repo: `/extensions/${id}`, ref: '', sha256: 'fixture', installedAt: 0,
    manifest: {
      id, name: id, description: 'Fixture', version: '1', apiVersion: 2, entry: 'dist/runtime.js',
      contributes: {
        commands: [{ id: commandId, title: 'Run' }],
        keybindings: keys.map(key => ({ command: commandId, key })),
      },
    },
  } as unknown as ExtensionListEntry
}

// The keyboard router consults extension defaults BEFORE its fixed handlers, so
// admission is the only thing standing between a manifest and every keystroke.
describe('extension contribution admission', () => {
  it('drops chords that would take over typing, tab switching, editing or a first-party default', () => {
    const firstParty = buildDefaultKeybindings().flatMap(entry => entry.bindings).find(chord => chord.startsWith('Cmd+'))
    expect(firstParty).toBeDefined()
    const derived = deriveExtensionKeybindings([
      installed('notes', 'notes.capture', ['a', 'Enter', 'ctrl+r', 'cmd+1', 'cmd+c', firstParty!, 'cmd+alt+shift+f12']),
    ])
    expect(derived).toEqual([{ commandId: 'notes.capture', bindings: ['Cmd+Alt+Shift+F12'], context: 'global' }])
  })

  it('never lets an extension replace a dotted first-party command', () => {
    // Namespacing allows this: an extension whose id equals the built-in prefix
    // may legally declare the built-in id (for example `usage.open`).
    const builtIn = builtInCommandCatalog.find(command => /^[a-z][a-z0-9-]*\./.test(command.id))
    expect(builtIn).toBeDefined()
    const extension = installed(builtIn!.id.split('.')[0], builtIn!.id, ['cmd+alt+shift+f12'])
    expect(deriveExtensionCommands([extension], () => {}).map(command => command.id)).not.toContain(builtIn!.id)
    expect(deriveExtensionKeybindings([extension])).toEqual([])
  })
})
