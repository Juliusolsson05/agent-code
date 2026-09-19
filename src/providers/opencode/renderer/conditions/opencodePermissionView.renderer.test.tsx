// opencodePermissionView renders what the user is actually approving (#878).
//
// WHY this replays a RECORDING through the real package instead of typing a
// state literal: the bug was a subject that never reached this modal, because
// a hand-imagined payload shape no longer matched the server. The input here
// is the real OpenCode 1.18.30 SSE bus, recorded by opencode-terminal-headless's
// Stage 0 probe (packages/opencode-terminal-headless/testing/fixtures/live).
// It goes through the REAL EventDispatcher from the bumped opencode-headless
// package, and the resulting screen state is what this view renders, exactly
// as opencodeSession.foldPermission passes it.
//
// Two risks become reachable once the subject exists at all
// (opencode-headless#14 review):
//   - a long command, such as a heredoc or a `python3 -c` script, overflowed
//     the fixed modal, pushing the buttons off-screen while the auto-focused
//     "Allow once" answered Enter;
//   - "Allow always" beside `edit: src/a.ts` silently meant EVERY edit
//     (`always: ["*"]`), because the modal never showed the scope.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CommittedChannel, EventDispatcher, ScreenChannel, SemanticChannel } from 'opencode-headless'
import type { ScreenPermissionEvent } from 'opencode-headless'
import { opencodePermissionView } from './views'

type Recorded = { sessionID: string, sse: { event: { type: string, properties?: Record<string, unknown> } }[] }
const recording = (): Recorded => JSON.parse(readFileSync(resolve(__dirname, '../../../../../packages/opencode-terminal-headless/testing/fixtures/live/permission-once.json'), 'utf8'))

/** Replay recorded bus events through the real dispatcher and return the
 * visible permission state the session would fold into the condition. */
function permissionStateFrom(rec: Recorded) {
  const screenChannel = new ScreenChannel()
  let latest: ScreenPermissionEvent['state'] | null = null
  screenChannel.on('permission', (event: ScreenPermissionEvent) => { if (event.state.visible) latest = event.state })
  const dispatcher = new EventDispatcher({ semantic: new SemanticChannel(), screen: screenChannel, committed: new CommittedChannel(), sessionID: rec.sessionID })
  for (const { event } of rec.sse) dispatcher.dispatch(event)
  if (!latest) throw new Error('recording produced no visible permission')
  const state = latest as ScreenPermissionEvent['state']
  // The same mapping opencodeSession.foldPermission applies.
  return { visible: true as const, requestID: state.requestID!, title: state.title, metadata: state.metadata }
}

function mount(state: ReturnType<typeof permissionStateFrom>) {
  const Component = opencodePermissionView.Component
  render(<Component state={state} actions={[]} dispatch={async () => {}} interactionActive={false} />)
}

describe('opencode permission modal on a recorded 1.18.30 ask', () => {
  it('shows the subject in a scroll-contained block, not inline prose', () => {
    mount(permissionStateFrom(recording()))
    const subject = screen.getByText('bash: ls -1')
    // The contract is "the command can never push the buttons off-screen":
    // it sits in a bounded, scrollable, wrapping block. Layout is not
    // computable in happy-dom, so the containment is asserted on the element
    // that owns it.
    expect(subject.tagName).toBe('PRE')
    expect(subject.className).toMatch(/max-h-/)
    expect(subject.className).toMatch(/overflow-auto/)
  })

  it('says what "Allow always" covers, from the recorded always scope', () => {
    mount(permissionStateFrom(recording()))
    // The recorded ask carries `always: ["ls *"]`.
    expect(screen.getByText(/Allow always covers/)).toBeTruthy()
    expect(screen.getByText('ls *')).toBeTruthy()
  })

  it('renders a long command in full, never truncated (the modal is the only place the user sees it)', () => {
    const rec = recording()
    // DERIVED from the recording: only metadata.command changes, to a 60-line
    // heredoc like the ones agents send.
    const heredoc = `python3 - <<'EOF'\n${Array.from({ length: 60 }, (_, i) => `print(${i})`).join('\n')}\nEOF`
    for (const { event } of rec.sse) {
      if (event.type === 'permission.asked') event.properties = { ...event.properties, metadata: { command: heredoc } }
    }
    mount(permissionStateFrom(rec))
    const subject = screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === `bash: ${heredoc}`)
    expect(subject.className).toMatch(/max-h-/)
  })
})
