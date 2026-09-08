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

describe('malformed and failing references', () => {
  it('aborts on a reference with no separator instead of pasting it verbatim', async () => {
    // The old pattern excluded `/` from both halves, so this matched NOTHING:
    // invisible to collection, invisible to validation, and passed through the
    // final replace untouched. A typo was therefore pasted into the prompt as
    // literal text, which is the exact silent failure the grammar's header
    // says it exists to prevent.
    await expect(resolveKeyReferences('use {{key:Brave}} now', async () => 'secret'))
      .rejects.toThrow('{{key:Brave}}')
  })

  it('aborts on a reference with two separators rather than guessing', async () => {
    // With two separators there is no evidence for which one divides provider
    // from key, and picking one would resolve a reference the author did not
    // write.
    await expect(resolveKeyReferences('{{key:A/B/C}}', async () => 'secret'))
      .rejects.toThrow('{{key:A/B/C}}')
  })

  it('aborts on an empty half', async () => {
    await expect(resolveKeyReferences('{{key:/Key}}', async () => 'secret'))
      .rejects.toThrow('{{key:/Key}}')
    await expect(resolveKeyReferences('{{key:Provider/}}', async () => 'secret'))
      .rejects.toThrow('{{key:Provider/}}')
  })

  it('collects a THROWN resolution failure instead of escaping the loop', async () => {
    // The production adapter is typed Promise<string> and VaultService throws
    // on every failure mode, so the `value === null` branch this module was
    // built around is unreachable. Without the catch the first bad reference
    // escaped and the documented "one message tells you everything" was false.
    const resolve = async (ref: { keyName: string }) => {
      if (ref.keyName === 'bad') throw new Error('No such key')
      return 'secret'
    }
    await expect(resolveKeyReferences('{{key:P/bad}} {{key:P/worse}}', async () => {
      throw new Error('No such key')
    })).rejects.toThrow(/P\/bad.*P\/worse/)
    await expect(resolveKeyReferences('{{key:P/bad}}', resolve)).rejects.toThrow('No such key')
  })

  it('keeps the service message, which distinguishes locked from missing', async () => {
    await expect(resolveKeyReferences('{{key:P/K}}', async () => {
      throw new Error('Vault is locked')
    })).rejects.toThrow('Vault is locked')
  })

  it('does not interpret a substitution pattern inside a secret', async () => {
    // A function replacer, never a string: `$&` in a secret would otherwise be
    // expanded into the matched text.
    await expect(resolveKeyReferences('{{key:P/K}}', async () => 'sk-$&-$1'))
      .resolves.toBe('sk-$&-$1')
  })

  it('leaves an ordinary variable placeholder alone', async () => {
    // The two grammars must not collide: the placeholder pattern is
    // [A-Za-z0-9_]+ and cannot contain a colon.
    await expect(resolveKeyReferences('{{goal}} {{key:P/K}}', async () => 'secret'))
      .resolves.toBe('{{goal}} secret')
  })
})
