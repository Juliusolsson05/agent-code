import { describe, expect, it } from 'vitest'

import {
  feedRenderModelFromItems,
  type FeedRenderItem,
} from '@renderer/features/feed/model/renderModel'
import type { Entry } from '@shared/types/transcript'

function entry(uuid: string): Entry {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-07-18T00:00:00Z',
    message: { role: 'user', content: [] },
  } as Entry
}

describe('feedRenderModelFromItems', () => {
  it('keeps absorbed decisions for debug while excluding them from painted rows', () => {
    // WHY both arrays matter: dropping absorbed carriers loses the explanation
    // for hidden transcript data; including them in debugRows falsely reports a
    // DOM row and can mask a blank feed. The bridge's explicit item must feed
    // exactly one side-product, visibleDecisions, and never the painted list.
    const items: FeedRenderItem[] = Array.from({ length: 20 }, (_, index) => {
      const absorbed = entry(`absorbed-${index}`)
      return {
        type: 'absorbed-entry',
        key: `absorbed-entry:${index}`,
        entry: absorbed,
        visibleDecision: {
          key: `absorbed-${index}`,
          entry: absorbed,
          visible: false,
          reason: 'provider_operation_absorbed',
        },
        order: { phase: 'content', timeMs: null, sequence: index, source: 'ledger' },
      }
    })

    const model = feedRenderModelFromItems(items, 'codex')
    expect(model.debugRows).toEqual([])
    expect(model.visibleDecisions).toHaveLength(20)
    expect(model.visibleDecisions.every(decision => !decision.visible)).toBe(true)
  })
})
