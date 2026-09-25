import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import { carryDurableMeta } from '@renderer/workspace/hook/actions/undoClose'
import { liveWorkspaceFromPersisted, migrateWorkspaceToStage } from '@renderer/workspace/workspaceShape'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import {
  attachPocket,
  detachPocket,
  setPocketColorScheme,
  setPocketSplit,
  setPocketViewport,
  setPocketZoom,
  togglePocket,
} from './actions'

// Decomposition Stage 3: pocket identity on the session, proved on the
// owner's REAL persisted workspace (27 sessions: agents of several providers
// and a tmux terminal), not on an invented two-row literal.
const root = resolve(__dirname, '../../../../..')
const persisted = (): PersistedWorkspace =>
  (JSON.parse(readFileSync(resolve(root, 'testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: PersistedWorkspace }[] }).windows[0]!.workspace

const live = (): WorkspaceState => liveWorkspaceFromPersisted(migrateWorkspaceToStage(persisted()) as unknown as PersistedWorkspace)
const firstOfKind = (state: WorkspaceState, test: (kind: string) => boolean) =>
  Object.entries(state.sessions).find(([, m]) => test(m.kind ?? 'claude'))![0] as SessionId
const mint = () => 'pocket-fixed'

describe('pocket on the recorded workspace', () => {
  it('attaches to an agent, never to the recorded terminal', () => {
    const state = live()
    const agent = firstOfKind(state, k => k !== 'terminal' && k !== 'extension-view')
    const terminal = firstOfKind(state, k => k === 'terminal')
    expect(attachPocket(state, agent, undefined, mint).sessions[agent]!.browserPocket).toEqual({ pocketId: 'pocket-fixed', view: 'open', profile: 'lane' })
    expect(attachPocket(state, terminal, undefined, mint)).toBe(state)
  })

  it('survives a full save → migrate → load round trip with every field intact', () => {
    const state = live()
    const agent = firstOfKind(state, k => k !== 'terminal' && k !== 'extension-view')
    let withPocket = attachPocket(state, agent, { url: 'http://localhost:5173/' }, mint)
    withPocket = setPocketSplit(withPocket, agent, 0.37)
    withPocket = setPocketViewport(withPocket, agent, { mode: 'preset', preset: 'iphone-15' })
    withPocket = setPocketColorScheme(withPocket, agent, 'dark')
    const pocket = withPocket.sessions[agent]!.browserPocket

    // Round-trip through the same persisted shape autosave writes: the doc's
    // sessions map carries SessionMeta verbatim (useAutoSave), and migration
    // copies unknown SessionMeta fields ({...meta}, workspaceShape).
    const doc = persisted()
    ;(doc.sessions as Record<string, SessionMeta>)[agent] = { ...(doc.sessions as Record<string, SessionMeta>)[agent]!, browserPocket: pocket }
    const reloaded = liveWorkspaceFromPersisted(migrateWorkspaceToStage(doc) as unknown as PersistedWorkspace)
    expect(reloaded.sessions[agent]!.browserPocket).toEqual(pocket)
  })

  it('undo-close restores the same pocketId (same cookie jar) onto the respawned session', () => {
    const state = live()
    const agent = firstOfKind(state, k => k !== 'terminal' && k !== 'extension-view')
    const closed = attachPocket(state, agent, { url: 'http://localhost:3000/' }, mint).sessions[agent]!
    const respawned = { cwd: closed.cwd, kind: closed.kind } as SessionMeta
    expect(carryDurableMeta(respawned, closed).browserPocket).toEqual(closed.browserPocket)
    expect(carryDurableMeta(respawned, state.sessions[agent]!)).not.toHaveProperty('browserPocket')
  })
})

describe('pocket transforms', () => {
  const base = () => {
    const state = live()
    const agent = firstOfKind(state, k => k !== 'terminal' && k !== 'extension-view')
    return { state: attachPocket(state, agent, undefined, mint), agent }
  }

  it('re-attach never re-mints the pocketId', () => {
    const { state, agent } = base()
    expect(attachPocket(state, agent, { url: 'http://x.localhost/' }, () => 'other').sessions[agent]!.browserPocket!.pocketId).toBe('pocket-fixed')
  })

  it('toggle cycles open → collapsed → open and a no-op returns the same object', () => {
    const { state, agent } = base()
    const collapsed = togglePocket(state, agent)
    expect(collapsed.sessions[agent]!.browserPocket!.view).toBe('collapsed')
    expect(togglePocket(collapsed, agent).sessions[agent]!.browserPocket!.view).toBe('open')
    const once = setPocketSplit(state, agent, 0.5)
    expect(setPocketSplit(once, agent, 0.5)).toBe(once)
  })

  it('split is clamped and rounded (a drag must not write a new float per pixel)', () => {
    const { state, agent } = base()
    expect(setPocketSplit(state, agent, 0.01).sessions[agent]!.browserPocket!.split).toBe(0.2)
    expect(setPocketSplit(state, agent, 0.99).sessions[agent]!.browserPocket!.split).toBe(0.8)
    expect(setPocketSplit(state, agent, 0.4567).sessions[agent]!.browserPocket!.split).toBe(0.46)
    expect(setPocketSplit(state, agent, Number.NaN).sessions[agent]!.browserPocket!.split).toBe(0.5)
  })

  it('refuses unknown device presets and absurd sizes; fill / system / 100% remove the override', () => {
    const { state, agent } = base()
    expect(setPocketViewport(state, agent, { mode: 'preset', preset: 'nokia-3310' })).toBe(state)
    expect(setPocketViewport(state, agent, { mode: 'free', width: 10, height: 10 })).toBe(state)
    const phone = setPocketViewport(state, agent, { mode: 'preset', preset: 'pixel-8' })
    expect(setPocketViewport(phone, agent, { mode: 'fill' }).sessions[agent]!.browserPocket).not.toHaveProperty('viewport')
    const dark = setPocketColorScheme(state, agent, 'dark')
    expect(setPocketColorScheme(dark, agent, 'system').sessions[agent]!.browserPocket).not.toHaveProperty('colorScheme')
    expect(setPocketZoom(setPocketZoom(state, agent, 1.5), agent, 1).sessions[agent]!.browserPocket).not.toHaveProperty('zoom')
  })

  it('detach removes the key entirely', () => {
    const { state, agent } = base()
    expect(detachPocket(state, agent).sessions[agent]).not.toHaveProperty('browserPocket')
  })
})
