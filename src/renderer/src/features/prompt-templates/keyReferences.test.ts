import { describe, expect, it } from 'vitest'

import { collectKeyReferences, resolveKeyReferences, prepareTemplateText } from '@renderer/features/prompt-templates/keyReferences'

describe('collectKeyReferences', () => {
  it('collects and dedupes references', () => {
    const refs = collectKeyReferences(
      'Use {{key:Brave/main}} and again {{ key:Brave/main }}, plus {{key:OpenAI/prod key}}',
    )
    expect(refs).toEqual([
      { providerName: 'Brave', keyName: 'main' },
      { providerName: 'OpenAI', keyName: 'prod key' },
    ])
  })

  it('ignores ordinary template variables', () => {
    expect(collectKeyReferences('{{name}} and {{ date }}')).toEqual([])
  })
})

describe('resolveKeyReferences', () => {
  it('preserves source-code braces in a template without declared variables', async () => {
    const body = 'Example: {{ count }} and {{foo}}. Key: {{key:Brave/main}}'
    expect(await prepareTemplateText({ body, variables: [] }, {}, async () => 'credential'))
      .toBe('Example: {{ count }} and {{foo}}. Key: credential')
  })
  it('fills ordinary variables before resolving vault references without mutating the saved template', async () => {
    const template = {
      body: 'Use {{key:Brave/main}} for {{task}}',
      variables: [{ name: 'task', label: 'Task', description: '', defaultValue: '', required: true }],
    }
    expect(await prepareTemplateText(template, { task: 'search' }, async () => 'credential')).toBe('Use credential for search')
    expect(template.body).toBe('Use {{key:Brave/main}} for {{task}}')
  })
  it('substitutes resolved values', async () => {
    const resolved = await resolveKeyReferences(
      'Brave key: {{key:Brave/main}}',
      async ref => (ref.providerName === 'Brave' ? 'BSA-1' : null),
    )
    expect(resolved).toBe('Brave key: BSA-1')
  })

  it('aborts loudly on an unresolved reference', async () => {
    await expect(
      resolveKeyReferences('{{key:Brave/nope}}', async () => null),
    ).rejects.toThrow(/Unresolved key reference/)
  })

  it('names every failure when multiple refs are broken', async () => {
    await expect(
      resolveKeyReferences('{{key:Brave/a}} {{key:OpenAI/b}}', async () => null),
    ).rejects.toThrow(/Brave\/a.*OpenAI\/b/)
  })
})
