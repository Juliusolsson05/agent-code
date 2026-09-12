import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { featureReferences, referenceOwnership } from './featureReference'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'

it('covers every feature owner and links only commands shipped by this build', () => {
  const directories = readdirSync(resolve(import.meta.dirname, '../features'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  expect(Object.keys(referenceOwnership).sort()).toEqual(directories)
  const ids = featureReferences.map(feature => feature.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const [owner, id] of Object.entries(referenceOwnership)) expect(ids, `Undocumented owner: ${owner}`).toContain(id)
  const commands = new Set(builtInCommandCatalog.map(command => command.id))
  for (const feature of featureReferences) {
    for (const id of feature.commandIds) expect(commands.has(id), `${feature.id} references missing command ${id}`).toBe(true)
  }
})
