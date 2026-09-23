import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  attributePorts,
  classifyProbe,
  collectTree,
  parseLsofListen,
  parsePsTable,
  parseTmuxPanes,
} from './lanePorts'

// Every input below is a Stage-1 recording (see __fixtures__/README.md). The
// session → root mapping is the one real fact the recorder cannot know, so each
// test names the recorded root PIDs it uses and why.
const FIX = join(__dirname, '..', '__fixtures__')
const read = (name: string) => readFileSync(join(FIX, name), 'utf8')
const TAG = 'agents-and-tmux-terminal'
const ps = parsePsTable(read(`ps-topology.${TAG}.txt`))
const listeners = parseLsofListen(read(`lsof-listen.${TAG}.txt`))
const panes = parseTmuxPanes(read(`tmux-panes.${TAG}.txt`))
const probes = JSON.parse(read(`probe.${TAG}.json`)).probes as Array<{ port: number; status: number | null; contentType: string | null }>
const parentOf = new Map(ps.map(r => [r.pid, r.ppid]))
const agent = (pid: number) => ({ pid, countsOwnListeners: false })
const pane_ = (pid: number) => ({ pid, countsOwnListeners: true })
const pidOf = (comm: string) => ps.filter(r => r.comm === comm).map(r => r.pid)

describe('parsers on recorded output', () => {
  it('reads every row of the recorded ps table and skips the provenance header', () => {
    expect(ps.length).toBe(read(`ps-topology.${TAG}.txt`).split('\n').filter(l => /^\d/.test(l)).length)
    expect(ps.every(r => r.pid > 0 && r.ppid >= 0)).toBe(true)
  })

  it('reads lsof -F pcn pairs, one per listening fd, including multi-fd processes', () => {
    // Electron main holds several listeners in the recording.
    expect(listeners.filter(l => l.command === 'Electron').length).toBeGreaterThan(1)
    expect(listeners.every(l => l.port > 0 && l.pid > 0)).toBe(true)
  })

  it('reads the system-wide -F pn sample, which has no command lines', () => {
    const system = parseLsofListen(read('lsof-listen.system.txt'))
    expect(system.length).toBeGreaterThan(0)
    expect(system.every(l => l.command === undefined)).toBe(true)
  })

  it('reads tmux panes as session name → pane pid', () => {
    const rec = [...panes.entries()].find(([name]) => name.startsWith('acpocket-rec-'))
    expect(rec?.[1]).toBe(ps.find(r => r.comm === 'Python')!.pid)
    expect([...panes.keys()].filter(name => name.startsWith('agentcode-')).length).toBeGreaterThan(0)
  })
})

describe('attribution on recorded trees', () => {
  it('an agent-started dev server belongs to that agent (claude → zsh → npm exec → node)', () => {
    // Recorded: a vite preview on 4173 under one claude; a vite dev on 5292
    // under another. Each claude is its own session root.
    const viteNode = listeners.find(l => l.port === 4173)!.pid
    let owner = viteNode
    while (parentOf.has(owner) && ps.find(r => r.pid === owner)?.comm !== 'claude') owner = parentOf.get(owner)!
    const other = listeners.find(l => l.port === 5292)!.pid
    let otherOwner = other
    while (parentOf.has(otherOwner) && ps.find(r => r.pid === otherOwner)?.comm !== 'claude') otherOwner = parentOf.get(otherOwner)!
    expect(owner).not.toBe(otherOwner)

    const out = attributePorts({ listeners, parentOf, roots: { a: [agent(owner)], b: [agent(otherOwner)] } })
    expect(out.a?.map(p => p.port)).toContain(4173)
    expect(out.a?.map(p => p.port)).not.toContain(5292)
    expect(out.b?.map(p => p.port)).toContain(5292)
  })

  it('a tmux terminal dev server is found through its pane pid, even when the pane process IS the server', () => {
    // The pane's parent is the daemonized tmux SERVER, which is not under
    // Electron (recorded). Walking from the session's own PTY would miss it.
    const pane = [...panes.entries()].find(([name]) => name.startsWith('acpocket-rec-'))![1]
    const python = listeners.find(l => l.pid === pane)!
    const out = attributePorts({ listeners, parentOf, roots: { term: [pane_(pane)] } })
    expect(out.term?.map(p => p.port)).toEqual([python.port])
  })

  it('never counts a listener held by the session root itself (OpenCode serves its own UI)', () => {
    const opencode = pidOf('opencode').find(pid => listeners.some(l => l.pid === pid))!
    const out = attributePorts({ listeners, parentOf, roots: { oc: [agent(opencode)] } })
    expect(out.oc ?? []).toEqual([])
  })

  it('never walks up to ancestors: Electron main and its per-session mitmdump proxies are not any agent\'s', () => {
    const claudes = pidOf('claude')
    const out = attributePorts({ listeners, parentOf, roots: Object.fromEntries(claudes.map(pid => [String(pid), [agent(pid)]])) })
    const all = Object.values(out).flat()
    const electronPorts = listeners.filter(l => l.command === 'Electron' || l.command === 'mitmdump').map(l => l.port)
    expect(all.some(p => electronPorts.includes(p.port))).toBe(false)
  })

  it('dedupes a process that binds the same port on several fds', () => {
    const doubled = [...listeners, ...listeners]
    const pane = [...panes.entries()].find(([name]) => name.startsWith('acpocket-rec-'))![1]
    expect(attributePorts({ listeners: doubled, parentOf, roots: { t: [pane_(pane)] } }).t).toHaveLength(1)
  })

  it('collectTree survives a pid cycle', () => {
    expect([...collectTree([2], new Map([[2, 1], [3, 2], [1, 3]]))].sort()).toEqual([1, 2, 3])
  })
})

describe('classifyProbe on recorded responses', () => {
  const byPort = new Map(probes.map(p => [p.port, p]))

  it('a Vite server answering 200 text/html is a page', () => {
    expect(classifyProbe(byPort.get(4173)!)).toBe('html')
  })

  it('mitmdump proxies answer 502 text/html and are never pages', () => {
    const mitm = listeners.filter(l => l.command === 'mitmdump').map(l => byPort.get(l.port)!)
    expect(mitm.length).toBeGreaterThan(0)
    for (const p of mitm) expect(classifyProbe(p)).toBe('ignore')
  })

  it('a real vite dev server that 404s at / is still listed, as other', () => {
    expect(byPort.get(5292)!.status).toBe(404)
    expect(classifyProbe(byPort.get(5292)!)).toBe('other')
  })

  it('an unreachable probe is other, not a page and not ignored', () => {
    expect(classifyProbe({ status: null, contentType: null })).toBe('other')
  })
})

it('every recorded fixture file is consumed by some test in this directory', () => {
  // Guards against a recording that silently stops being exercised.
  const used = readdirSync(FIX).filter(f => /^(ps-topology|lsof-listen|tmux-panes|probe)\./.test(f))
  expect(used.sort()).toEqual([`lsof-listen.${TAG}.txt`, 'lsof-listen.system.txt', `probe.${TAG}.json`, `ps-topology.${TAG}.txt`, `tmux-panes.${TAG}.txt`].sort())
})
