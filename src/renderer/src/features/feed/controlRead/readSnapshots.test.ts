import { expect, it } from 'vitest'
import { agentReadInput } from '@control-sdk'
import { changedMessages, createReadSnapshots, type ReadMetadata } from './readSnapshots'

it('keeps a surrogate pair intact across character-budget pages and reports changed attachments', () => {
  // Deliberate codec probe, not fabricated provider behavior. Its oracle is
  // exact UTF-16 reconstruction and no isolated surrogate on either page.
  const snapshots = createReadSnapshots()
  try {
    const text = 'a'.repeat(255) + '😀' + 'b'.repeat(300)
    const row = { id: 'unicode', text, role: 'assistant' as const, kind: 'message', source: 'committed', partial: false }
    const snapshot = snapshots.create({ identity: 'one', metadata: {} as ReadMetadata, rows: [row], basis: [row], deleted: [], older: null })
    let page = snapshots.page(snapshot, agentReadInput.parse({ sessionId: 'agent', maxChars: 256 }))
    expect(page.messages[0].text).toHaveLength(255)
    let joined = page.messages[0].text
    while (page.nextCursor) {
      page = snapshots.page(snapshot, agentReadInput.parse({ sessionId: 'agent', maxChars: 256, cursor: page.nextCursor }))
      joined += page.messages[0].text
    }
    expect(joined).toBe(text)
    expect(changedMessages([row], [{ ...row, attachments: [{ id: 'img', kind: 'image' }] }]).rows).toHaveLength(1)
    expect(() => snapshots.get(snapshot.id, 'replacement', 'conversation')).toThrow('expired or the agent')
  } finally { snapshots.dispose() }
})
