import { describe, expect, it } from 'vitest'

import { inboundFrames, recordingFor } from 'hermes-headless/testing/corpus'
import type { CommandsCatalogResult } from 'hermes-headless'

import { composerCommandsFromCatalog, findComposerCommand } from './composerCommands'

// Fixture: the REAL `commands.catalog` answer recorded from Hermes v0.22.0
// (hermes-headless research/corpus S17): 156 commands incl. 58 skills and
// two user quick commands.
function recordedCatalog(): CommandsCatalogResult {
  return inboundFrames(recordingFor('S17', 'v0.22.0'))
    .map((frame) => frame.result as CommandsCatalogResult | undefined)
    .find((result) => result && Array.isArray(result.pairs))!
}

describe('Hermes slash commands for the composer (#1497)', () => {
  const commands = composerCommandsFromCatalog(recordedCatalog())
  const get = (name: string) => findComposerCommand(commands, name)

  it('offers built-ins, skills and the user\'s quick commands', () => {
    expect(get('compress')?.availability.kind).toBe('offered')
    expect(get('airtable')).toMatchObject({ category: 'Skills', availability: { kind: 'offered' } })
    expect(get('hhq')).toMatchObject({ category: 'User commands', availability: { kind: 'offered' } })
    expect(get('skills')?.subcommands).toContain('pending')
  })

  it('refuses what Hermes marks terminal-only, and Agent Code\'s own refusals, with a sentence', () => {
    expect(get('redraw')?.availability).toMatchObject({ kind: 'unavailable' })
    expect(get('mouse')?.availability).toMatchObject({ kind: 'unavailable' })
    expect(get('model')?.availability).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('/model') })
  })

  it('adds /restart, which Hermes leaves out of the catalog (gateway_only)', () => {
    expect(recordedCatalog().pairs?.some((pair) => pair[0] === '/restart')).toBe(false)
    expect(get('restart')).toMatchObject({ source: 'app', availability: { kind: 'offered' } })
  })

  it('still refuses before the catalog arrives', () => {
    expect(findComposerCommand(composerCommandsFromCatalog({}), 'model')?.availability.kind).toBe('unavailable')
  })
})
