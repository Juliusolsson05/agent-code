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
  it('leaves a separator-less occurrence alone, because it is not addressed to the vault', async () => {
    // Reporting `{{key:Brave}}` as a malformed reference required matching
    // ANY `{{key:…}}`, and that over-captured ordinary text: JSX like
    // `<Widget options={{key: value}} />` began aborting insertion outright,
    // with no way to escape it. A separator is what makes an occurrence look
    // deliberately like a vault reference, so it is the boundary. A
    // separator-less typo passes through as it always did.
    await expect(resolveKeyReferences('use {{key:Brave}} now', async () => 'secret'))
      .resolves.toBe('use {{key:Brave}} now')
  })

  it('does not touch ordinary JSX that happens to contain {{key:', async () => {
    const body = '<Widget options={{key: value}} /> and {{key: other}}'
    await expect(resolveKeyReferences(body, async () => 'secret')).resolves.toBe(body)
  })

  it('still resolves a real reference sitting next to such text', async () => {
    await expect(resolveKeyReferences(
      '<Widget options={{key: value}} /> {{key:P/K}}',
      async () => 'secret',
    )).resolves.toBe('<Widget options={{key: value}} /> secret')
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

  it('reports a thrown resolution failure with the service message', async () => {
    // The production adapter is typed Promise<string> and VaultService throws
    // on every failure mode, so the `value === null` branch this module was
    // built around is unreachable. Without a catch the first bad reference
    // escaped and the failure list was never built.
    await expect(resolveKeyReferences('{{key:P/bad}}', async () => {
      throw new Error('No such key')
    })).rejects.toThrow('No such key')
  })

  it('asks the vault ONCE when the first reference fails', async () => {
    // The reason the loop stops rather than continuing: one failure mode is a
    // cancelled unlock, and ensureUnlocked clears its pending promise on
    // cancellation — so carrying on to the next reference opens another OS
    // authentication prompt. Three references would ask three times. A user
    // who just cancelled must not be re-asked.
    const asked: string[] = []
    const resolve = async (ref: { providerName: string; keyName: string }) => {
      asked.push(`${ref.providerName}/${ref.keyName}`)
      throw new Error('Vault unlock was cancelled')
    }

    await expect(resolveKeyReferences('{{key:P/a}} {{key:P/b}} {{key:P/c}}', resolve))
      .rejects.toThrow('Vault unlock was cancelled')
    expect(asked).toEqual(['P/a'])
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
