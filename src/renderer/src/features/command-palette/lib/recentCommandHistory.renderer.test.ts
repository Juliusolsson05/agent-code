import { afterEach, expect, it } from 'vitest'

import { loadRecentHistory, recordCommandUse } from './recentCommandHistory'

afterEach(() => { window.localStorage.clear() })

// #1180 review: 'context-menu' became a user source in the gateway while this
// cache's source list did not name it, so its provenance was written and then
// discarded on the next read — the entry looked like it predated the field.
// Round-trips through real localStorage, the cache's only edge.
it('keeps a context-menu invocation\'s source across a reload of the cache', () => {
  recordCommandUse('reload-agent', 'context-menu')
  expect(loadRecentHistory().find(entry => entry.id === 'reload-agent')?.lastSource).toBe('context-menu')
})
