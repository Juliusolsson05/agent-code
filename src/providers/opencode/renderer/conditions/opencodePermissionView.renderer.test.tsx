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
import { opencodePermissionView, opencodeQuestionView } from './views'

type Recorded = { sessionID: string, sse: { event: { type: string, properties?: Record<string, unknown> } }[] }
const recording = (): Recorded => JSON.parse(readFileSync(resolve(__dirname, '../../../../../packages/opencode-headless/testing/fixtures/live-1.18.30/permission-once.json'), 'utf8'))

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

  it('renders a bidi override as a visible escape, so the command cannot lie about itself (#1029)', () => {
    // Trojan Source, CVE-2021-42574: U+202E reorders the glyphs a browser
    // draws without changing the bytes the shell runs, so a prompt-injected
    // model can make a destructive command read as a harmless one. This modal
    // is frequently the only place the command is shown, so what it renders
    // IS the user's evidence. DERIVED from the recording: only the command
    // changes, to the canonical attack shape.
    const rec = recording()
    const spoofed = 'rm -rf ~/work \u202E# this is fine\u202C'
    for (const { event } of rec.sse) {
      if (event.type === 'permission.asked') event.properties = { ...event.properties, metadata: { command: spoofed } }
    }
    mount(permissionStateFrom(rec))
    const rendered = screen.getByText((_, element) => element?.tagName === 'PRE' && (element.textContent ?? '').includes('rm -rf'))
    expect(rendered.textContent).toContain('⟨U+202E RLO⟩')
    expect(rendered.textContent).toContain('⟨U+202C PDF⟩')
    // The override itself must not survive into the DOM, or the browser
    // reorders the line exactly as the attack intends.
    expect(rendered.textContent).not.toContain('\u202E')
  })

  it('escapes the persistent grant\'s scope too, since that is what "Allow always" authorises (#1049 review)', () => {
    // The command is only half of the decision: "Allow always covers <pattern>"
    // describes what the grant will keep allowing, for this agent and its
    // subagents. A reordered pattern misdescribes that scope.
    const rec = recording()
    for (const { event } of rec.sse) {
      if (event.type === 'permission.asked') {
        event.properties = { ...event.properties, metadata: { command: 'ls -1' }, pattern: ['ls \u202E rm -rf *'] }
      }
    }
    mount(permissionStateFrom(rec))
    const always = screen.getByText(/Allow always covers/)
    expect(always.textContent).not.toContain('\u202E')
  })

  it('escapes the WILDCARD grant scope, the broadest one we offer (#1049 re-review)', () => {
    // `always: ['*']` renders a different branch — "every <permission>
    // request" — and that branch was left unescaped while the pattern branch
    // beside it was fixed. It is also the worst one to lose: the wildcard is
    // the broadest grant in the modal, so the permission name is the only
    // thing telling the user what they are signing away.
    const rec = recording()
    for (const { event } of rec.sse) {
      if (event.type === 'permission.asked') {
        // The recorded payload's own field names: `permission` and `always`
        // sit beside `metadata`, and the dispatcher folds the whole payload
        // into the state's metadata. `always: ['*']` is the wildcard shape
        // OpenCode really sends for edit/write/MCP asks.
        event.properties = { ...event.properties, permission: 'bash \u202E harmless', always: ['*'] }
      }
    }
    mount(permissionStateFrom(rec))
    const always = screen.getByText(/Allow always covers/)
    expect(always.textContent).not.toContain('\u202E')
    expect(always.textContent).toContain('U+202E')
  })

  it('shows the command behind a default-permission external_directory ask, not just the directory', () => {
    // #1026 review: OpenCode's DEFAULT rules allow bash and ask only for
    // external_directory, so for most users this is THE shell-command
    // prompt. OpenCode's ShellTool.ask sends it as
    // { permission: 'external_directory', patterns: [dir/*], metadata: { command } }.
    // The subject reads "external_directory: /work/old/*". Without the
    // command, Enter on "Allow once" runs `rm -rf /work/old` unseen.
    // DERIVED from the recording: permission, patterns, metadata and always
    // are reshaped to that ask; the id, session and tool linkage are real.
    const rec = recording()
    for (const { event } of rec.sse) {
      if (event.type === 'permission.asked') {
        event.properties = { ...event.properties, permission: 'external_directory', patterns: ['/work/old/*'], always: ['/work/old/*'], metadata: { command: 'rm -rf /work/old', directories: ['/work/old'] } }
      }
    }
    mount(permissionStateFrom(rec))
    expect(screen.getByText('rm -rf /work/old').tagName).toBe('PRE')
  })

  it('warns plainly when Allow always is a wildcard grant (edit, write, MCP asks send ["*"])', () => {
    const rec = recording()
    // DERIVED: the recorded ask reshaped to an MCP tool ask, which sends always: ['*'].
    for (const { event } of rec.sse) {
      if (event.type === 'permission.asked') event.properties = { ...event.properties, permission: 'github_create_issue', patterns: ['*'], always: ['*'], metadata: {} }
    }
    mount(permissionStateFrom(rec))
    const warning = screen.getByText(/Allow always covers/)
    // The grant covers the whole OpenCode server this agent runs, including
    // its subagents, until it restarts. That is how OpenCode's own TUI words
    // the same confirmation.
    expect(warning.textContent).toMatch(/every github_create_issue request/)
    expect(warning.textContent).toMatch(/until this agent restarts/)
  })
})

describe('opencode question modal on a recorded 1.18.30 ask', () => {
  it('keeps a long question scroll-contained so Reject stays on screen', () => {
    type RecordedQuestion = Recorded
    const rec: RecordedQuestion = JSON.parse(readFileSync(resolve(__dirname, '../../../../../packages/opencode-headless/testing/fixtures/live-1.18.30/question-reject.json'), 'utf8'))
    const screenChannel = new ScreenChannel()
    let latest: { visible: boolean, questionID?: string, text?: string } | null = null
    screenChannel.on('question', (event: { state: { visible: boolean, questionID?: string, text?: string } }) => { if (event.state.visible) latest = event.state })
    const dispatcher = new EventDispatcher({ semantic: new SemanticChannel(), screen: screenChannel, committed: new CommittedChannel(), sessionID: rec.sessionID })
    for (const { event } of rec.sse) dispatcher.dispatch(event)
    const state = latest as unknown as { visible: true, questionID: string, text: string }
    const Component = opencodeQuestionView.Component
    render(<Component state={state} actions={[]} dispatch={async () => {}} interactionActive={false} />)
    const text = screen.getByText('Do you prefer the color red or blue?')
    expect(text.className).toMatch(/max-h-/)
    expect(text.className).toMatch(/overflow-auto/)
  })
})
