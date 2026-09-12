import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { QueueStrip } from './QueueStrip'

describe('QueueStrip', () => {
  it('keeps many queued prompts inside a bounded scroll lane that can collapse', () => {
    render(
      <QueueStrip
        provider="claude"
        queuedMessages={Array.from({ length: 12 }, (_, index) => ({
          content: `queued prompt ${index + 1}`,
          timestamp: String(index + 1),
        }))}
      />,
    )

    const lane = screen.getByRole('group', { name: 'queued messages' })
    const list = screen.getByRole('list', { name: 'queued prompt list' })
    const disclosure = screen.getByRole('button', { name: '12 queued' })

    // happy-dom has no layout engine, so the responsive contract must be
    // asserted at the CSS seam: the pane-relative outer cap prevents the
    // queue from consuming the composer, while this inner scroller absorbs
    // any number of rows without increasing the lane's footprint.
    expect(lane.className).toContain('[max-height:clamp(32px,30%,160px)]')
    expect(list.className).toContain('overflow-y-auto')
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'queued prompt list' })).toBeNull()
    // Collapsing hides only presentation. The count remains visible so the
    // user cannot mistake pending work for an empty queue.
    expect(screen.getByText('12 queued')).toBeVisible()
  })

  it('renders a bounded two-line summary and opens the exact multiline prompt on demand', () => {
    const prompt = [
      'Please review this implementation.',
      '```ts',
      `const value = '${'x'.repeat(260)}'`,
      '```',
      'Keep this final instruction visible in the full preview.',
    ].join('\n')

    render(
      <QueueStrip
        provider="claude"
        queuedMessages={[{ content: prompt, timestamp: 'prompt-1' }]}
      />,
    )

    const list = screen.getByRole('list', { name: 'queued prompt list' })
    const view = within(list).getByRole('button', { name: /View queued prompt:/ })
    expect(view).toHaveTextContent('Please review this implementation. ```ts')
    expect(view).toHaveTextContent('…')
    const preview = view.querySelector('.font-code')
    expect(preview?.className).toContain('line-clamp-2')
    expect(preview?.className).toContain('[overflow-wrap:anywhere]')
    expect(within(list).queryByText(/Keep this final instruction/)).toBeNull()

    fireEvent.click(view)
    const dialog = screen.getByRole('dialog', { name: 'Queued prompt' })
    expect(within(dialog).getByText('1 of 1 · queued for delivery')).toBeVisible()
    const exactPrompt = dialog.querySelector('pre')
    if (!exactPrompt) throw new Error('queued prompt preview did not render a pre element')
    expect(exactPrompt.textContent).toBe(prompt)
    expect(exactPrompt.className).toContain('[overflow-wrap:anywhere]')
  })

  it('keeps Claude task notifications compact and never exposes their raw payload as a prompt', () => {
    const notification = [
      '<task-notification>',
      '<task-id>worker-1</task-id>',
      '<status>completed</status>',
      '<summary>Agent "worker-1" finished</summary>',
      `<result>${'large report '.repeat(80)}</result>`,
      '</task-notification>',
    ].join('\n')

    render(
      <QueueStrip
        provider="claude"
        queuedMessages={[{ content: notification, timestamp: 'notification-1' }]}
      />,
    )

    expect(screen.getByText(/Agent "worker-1" finished — delivering to agent/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /View queued prompt:/ })).toBeNull()
    expect(screen.queryByText(/<task-notification>/)).toBeNull()
  })

  it('forgets a selected prompt after dequeue so replay cannot reopen stale content', () => {
    const message = { content: 'inspect this queued prompt', timestamp: 'prompt-1' }
    const { rerender } = render(
      <QueueStrip provider="claude" queuedMessages={[message]} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /View queued prompt:/ }))
    expect(screen.getByRole('dialog', { name: 'Queued prompt' })).toBeVisible()

    rerender(<QueueStrip provider="claude" queuedMessages={[]} />)
    expect(screen.queryByRole('dialog', { name: 'Queued prompt' })).toBeNull()

    rerender(<QueueStrip provider="claude" queuedMessages={[message]} />)
    expect(screen.queryByRole('dialog', { name: 'Queued prompt' })).toBeNull()
  })

  it('collapses repeated blank lines in the summary and provider-gates notifications', () => {
    const content = [
      '# Refactor plan',
      '',
      '',
      'Step one: update the parser.',
    ].join('\n')

    const { rerender } = render(
      <QueueStrip
        provider="codex"
        queuedMessages={[{ content, timestamp: 'prompt-1' }]}
      />,
    )

    const view = screen.getByRole('button', { name: /View queued prompt:/ })
    expect(view).toHaveTextContent('# Refactor plan Step one: update the parser.')

    const literalNotification = [
      '<task-notification>',
      '<summary>literal protocol example</summary>',
      '</task-notification>',
    ].join('\n')
    rerender(
      <QueueStrip
        provider="codex"
        queuedMessages={[{ content: literalNotification, timestamp: 'prompt-2' }]}
      />,
    )
    expect(screen.getByRole('button', { name: /View queued prompt:/ })).toBeVisible()
    expect(screen.queryByText(/delivering to agent/)).toBeNull()
  })
})

describe('QueueStrip collapse is a per-episode gesture (#890)', () => {
  it('starts every queue episode expanded, even after the user collapsed an earlier one', () => {
    const view = render(
      <QueueStrip
        provider="claude"
        queuedMessages={[{ content: 'first episode prompt', timestamp: '1' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '1 queued' }))
    expect(screen.getByRole('button', { name: '1 queued' })).toHaveAttribute('aria-expanded', 'false')

    // The queue drains. TileLeaf keeps the strip mounted (it renders null), so
    // component state survives into the next episode — which is exactly how
    // the 2026-09-11 screenshot ended up with a collapsed strip over a prompt
    // the user had never seen queued.
    view.rerender(<QueueStrip provider="claude" queuedMessages={[]} />)
    expect(screen.queryByRole('group', { name: 'queued messages' })).toBeNull()

    view.rerender(
      <QueueStrip
        provider="claude"
        queuedMessages={[{ content: 'second episode prompt', timestamp: '2' }]}
      />,
    )
    expect(screen.getByRole('button', { name: '1 queued' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: 'queued prompt list' })).toHaveTextContent('second episode prompt')
  })

  it('treats a drain and a new enqueue folded into one burst as a new episode', () => {
    // #893 review (Codex minor / Claude F8). One JSONL tail read carries
    // `remove(A)` then `enqueue(B)`, and the Claude branch folds the whole burst
    // in one runtime update. The reducer passes through [], but the component
    // only ever receives [A] → [B]: there is deliberately NO empty render here.
    const view = render(
      <QueueStrip
        provider="claude"
        queuedMessages={[{ content: 'prompt A drained mid-turn', timestamp: '2026-09-11T10:06:09.724Z' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '1 queued' }))
    expect(screen.getByRole('button', { name: '1 queued' })).toHaveAttribute('aria-expanded', 'false')

    view.rerender(
      <QueueStrip
        provider="claude"
        queuedMessages={[{ content: 'prompt B queued in the same burst', timestamp: '2026-09-11T10:06:09.801Z' }]}
      />,
    )

    expect(screen.getByRole('button', { name: '1 queued' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: 'queued prompt list' })).toHaveTextContent('prompt B queued in the same burst')
  })

  it('keeps the collapse while the same episode grows or partly drains', () => {
    // The other side of the boundary: collapsing is a choice about THIS
    // episode, so it must survive items joining or leaving while any hidden
    // item remains. Fresh object copies stand in for the reducer rebuilding the
    // array on every fold; identity is (timestamp, content), never the object.
    const a = { content: 'prompt A', timestamp: '2026-09-11T10:02:39.115Z' }
    const b = { content: 'prompt B', timestamp: '2026-09-11T10:02:41.020Z' }
    const view = render(<QueueStrip provider="claude" queuedMessages={[a]} />)
    fireEvent.click(screen.getByRole('button', { name: '1 queued' }))

    view.rerender(<QueueStrip provider="claude" queuedMessages={[{ ...a }, b]} />)
    expect(screen.getByRole('button', { name: '2 queued' })).toHaveAttribute('aria-expanded', 'false')

    view.rerender(<QueueStrip provider="claude" queuedMessages={[{ ...b }]} />)
    expect(screen.getByRole('button', { name: '1 queued' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'queued prompt list' })).toBeNull()
  })
})
