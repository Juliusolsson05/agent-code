import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SessionFeedProvider, useSessionFeed } from './SessionFeedContext'
import { createFakeSessionFeed } from './FakeSessionFeed'

function Probe(): React.JSX.Element {
  const feed = useSessionFeed()
  return <div>{typeof feed.sendInput === 'function' ? 'has-feed' : 'no-feed'}</div>
}

describe('SessionFeedContext', () => {
  it('provides the injected feed to consumers', () => {
    const fake = createFakeSessionFeed()
    render(
      <SessionFeedProvider value={fake}>
        <Probe />
      </SessionFeedProvider>,
    )
    expect(screen.getByText('has-feed')).toBeTruthy()
  })

  it('useSessionFeed throws a descriptive error outside a provider', () => {
    // React logs the error boundary noise to console.error during the throw;
    // the assertion is on the thrown message, which is the API we guarantee.
    expect(() => render(<Probe />)).toThrowError(/SessionFeedProvider/)
  })
})

describe('FakeSessionFeed', () => {
  it('fans emitted events to subscribed listeners and honors unsubscribe', () => {
    const fake = createFakeSessionFeed()
    const seen: string[] = []
    const unsub = fake.onSessionScreen(e => seen.push(e.sessionId))
    fake.emitScreen({
      sessionId: 's1',
      plain: 'hello',
      markdown: '',
      recent: 'hello',
      recentMarkdown: '',
      picker: { visible: false, items: [] },
    })
    unsub()
    fake.emitScreen({
      sessionId: 's2',
      plain: 'bye',
      markdown: '',
      recent: 'bye',
      recentMarkdown: '',
      picker: { visible: false, items: [] },
    })
    expect(seen).toEqual(['s1'])
  })

  it('records command calls for assertions', async () => {
    const fake = createFakeSessionFeed()
    await fake.sendInput('s1', 'hi')
    await fake.deliverPrompt('s1', 'prompt')
    expect(fake.calls).toEqual([
      { method: 'sendInput', sessionId: 's1', data: 'hi', pasteId: undefined },
      { method: 'deliverPrompt', sessionId: 's1', prompt: 'prompt' },
    ])
  })
})
