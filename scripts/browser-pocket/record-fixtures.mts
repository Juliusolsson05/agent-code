// Records the real inputs the browser pocket's pure cores are tested against
// (docs/decomposition/lane-browser-pocket.md, Stage 1).
//
// WHY a recorder instead of hand-written fixtures: the parsers and formatters
// in src/main/browserPocket/core reconcile shapes we did not design — ps
// trees, lsof -F output, Chrome's accessibility tree, CDP event streams. Tests
// written against shapes we imagined pass while the real shapes break (the
// staged-decomposition rule). Everything under __fixtures__ is produced here,
// with a provenance header, and never edited by hand.
//
// Usage (from the repo root, Node 24):
//   npx tsx --tsconfig tsconfig.node.json scripts/browser-pocket/record-fixtures.mts [--tag name] [--tmux <binary>] [--check]
//
// --tag      suffix for the process/port fixtures, so the user can record
//            several live situations (claude-dev-server, tmux-terminal, …)
//            without overwriting each other.
// --check    verifies every fixture carries provenance and no private data
//            (home paths, argv) leaked; records nothing.
//
// PRIVACY: process rows keep pid, ppid and the executable BASENAME only.
// argv is never read — it carries prompts, file paths and tokens. Only the
// subtree of the Agent Code main process (or of this recorder, when not run
// under the app) is written.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir, homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FIXTURES = join(process.cwd(), 'src/main/browserPocket/__fixtures__')
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const TAG = flag('--tag') ?? 'recorder'
const TMUX = flag('--tmux') ?? 'tmux'
const CHROME = flag('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function provenance(what: string, extra: Record<string, string> = {}): string {
  return JSON.stringify({
    recordedBy: 'scripts/browser-pocket/record-fixtures.mts',
    what,
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// Process tree + listeners
// ---------------------------------------------------------------------------

type Row = { pid: number; ppid: number; comm: string }

async function processTable(): Promise<Row[]> {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024 })
  return stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), comm: basename(m[3]!.trim()) }] : []
  })
}

/** Walk up from this process to the Electron main that owns the agent we run in. */
function appRoot(rows: Row[]): number {
  const byPid = new Map(rows.map(r => [r.pid, r]))
  let cur = byPid.get(process.pid)
  let last = process.pid
  while (cur && cur.ppid > 1) {
    const parent = byPid.get(cur.ppid)
    if (!parent) break
    if (parent.comm === 'Electron' || parent.comm === 'Agent Code') return parent.pid
    last = parent.pid
    cur = parent
  }
  return last
}

function subtree(rows: Row[], root: number): Row[] {
  const kids = new Map<number, number[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const keep = new Set<number>()
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift()!
    if (keep.has(pid)) continue
    keep.add(pid)
    queue.push(...(kids.get(pid) ?? []))
  }
  return rows.filter(r => keep.has(r.pid))
}

async function lsofListen(pids?: number[]): Promise<string> {
  const argv = ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-F', pids ? 'pcn' : 'pn']
  if (pids) argv.push('-p', pids.join(','))
  try {
    const { stdout } = await run('/usr/sbin/lsof', argv, { maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch (error) {
    // lsof exits 1 when nothing matched; that empty answer is itself a shape.
    return (error as { stdout?: string }).stdout ?? ''
  }
}

async function tmuxPanes(): Promise<string> {
  try {
    const { stdout } = await run(TMUX, ['list-panes', '-a', '-F', '#{session_name} #{pane_pid}'])
    // Session names are `agentcode-<uuid>`; keep them, they carry no user data.
    return stdout
  } catch (error) {
    return `# tmux list-panes failed: ${(error as Error).message.split('\n')[0]}\n`
  }
}

async function probe(port: number): Promise<{ port: number; status: number | null; contentType: string | null; error?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
    await res.body?.cancel()
    return { port, status: res.status, contentType: res.headers.get('content-type') }
  } catch (error) {
    return { port, status: null, contentType: null, error: (error as Error).name }
  }
}

// ---------------------------------------------------------------------------
// Local pages (real HTML, rendered by real Chrome)
// ---------------------------------------------------------------------------

const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Sign in</title><main><h1>Sign in</h1>
<form><label>Email <input type="email" name="email" placeholder="you@example.com"></label>
<label>Password <input type="password" name="password"></label>
<label><input type="checkbox" name="remember"> Remember me</label>
<select name="team"><option>Design</option><option selected>Engineering</option></select>
<textarea name="note">hello</textarea>
<button type="submit" class="primary">Sign in</button><a href="/forgot">Forgot password?</a></form>
<div role="dialog" aria-label="Cookie notice" hidden>We use cookies</div>
<nav aria-label="Footer"><a href="/a">About</a> <a href="/b">Blog</a></nav></main>`,
  '/iframe': `<!doctype html><title>Embed</title><h2>Parent</h2><button>Outer</button>
<iframe src="/form" title="Nested form" width="600" height="400"></iframe>`,
  '/list': `<!doctype html><title>Long list</title><h1>Items</h1><ul>${Array.from({ length: 120 }, (_, i) => `<li><a href="/item/${i}">Item ${i}</a> <button aria-label="Delete item ${i}">×</button></li>`).join('')}</ul>`,
  '/errors': `<!doctype html><title>Errors</title><h1>Broken page</h1>
<img src="/missing.png" alt="missing">
<script>console.log('boot'); console.warn('deprecated thing'); console.error('render failed', {code: 42});
fetch('/api/nope').then(r => r.status); fetch('http://127.0.0.1:9/unreachable').catch(() => {});
setTimeout(() => { throw new Error('uncaught in timeout') }, 50);
Promise.reject(new Error('unhandled rejection'));</script>`,
  '/spa': `<!doctype html><title>SPA</title><div id="root"></div>
<script>const root=document.getElementById('root');let n=0;function render(){root.innerHTML='<header><h1>Counter</h1></header><main><p aria-live="polite">Count: '+n+'</p><button id="inc">Increment</button><button disabled>Disabled</button><div role="tablist"><button role="tab" aria-selected="true">One</button><button role="tab" aria-selected="false">Two</button></div><input role="searchbox" aria-label="Search"></main>';document.getElementById('inc').onclick=()=>{n++;render();history.pushState({},'','/spa?n='+n)}}render();</script>`,
}

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!
      const page = PAGES[path]
      if (page) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return }
      if (path.startsWith('/api/')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

// ---------------------------------------------------------------------------
// Minimal CDP client over Chrome's WebSocket (Node 24 has global WebSocket)
// ---------------------------------------------------------------------------

type Cdp = { send: (method: string, params?: object, sessionId?: string) => Promise<any>; events: Array<{ method: string; params: unknown; sessionId?: string; at: number }>; close: () => void }

async function launchChrome(): Promise<{ proc: ChildProcess; cdp: Cdp; profile: string }> {
  // A scratch --user-data-dir: Chrome 136+ refuses remote debugging on the
  // DEFAULT profile, and we never touch the user's real one anyway.
  const profile = await mkdtemp(join(tmpdir(), 'ac-pocket-rec-'))
  const proc = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' })
  let port = 0
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise(r => setTimeout(r, 100))
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch { /* not yet */ }
  }
  if (!port) throw new Error('Chrome did not expose DevToolsActivePort')
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string }
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const events: Cdp['events'] = []
  ws.onmessage = msg => {
    const data = JSON.parse(String(msg.data))
    if (data.id) {
      const p = pending.get(data.id); pending.delete(data.id)
      if (data.error) p?.reject(new Error(`${data.error.message}`)); else p?.resolve(data.result)
    } else events.push({ method: data.method, params: data.params, sessionId: data.sessionId, at: Date.now() })
  }
  const cdp: Cdp = {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }))
    }),
    events,
    close: () => ws.close(),
  }
  return { proc, cdp, profile }
}

async function recordPage(cdp: Cdp, url: string, name: string, chromeVersion: string): Promise<void> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.enable', 'Accessibility.enable']) await cdp.send(m, {}, sessionId)
  const startIndex = cdp.events.length
  await cdp.send('Page.navigate', { url }, sessionId)
  // Settle: load event plus a margin for timers/rejections on /errors.
  for (let i = 0; i < 50; i++) {
    if (cdp.events.slice(startIndex).some(e => e.sessionId === sessionId && e.method === 'Page.loadEventFired')) break
    await new Promise(r => setTimeout(r, 100))
  }
  await new Promise(r => setTimeout(r, 600))
  const header = provenance(`CDP recording of ${name}`, { chrome: chromeVersion, url: new URL(url).pathname })

  const ax = await cdp.send('Accessibility.getFullAXTree', {}, sessionId)
  await writeFile(join(FIXTURES, `axtree.${name}.json`), JSON.stringify({ provenance: JSON.parse(header), ...ax }))

  const keep = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded', 'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed', 'Network.loadingFinished', 'Page.frameNavigated', 'Page.navigatedWithinDocument'])
  const events = cdp.events.slice(startIndex).filter(e => e.sessionId === sessionId && keep.has(e.method))
  await writeFile(join(FIXTURES, `cdp-events.${name}.jsonl`), [header, ...events.map(e => JSON.stringify({ method: e.method, params: e.params }))].join('\n') + '\n')

  // Geometry and node descriptions for the first few actionable nodes, so
  // click-point and picker code are tested on real quads, not invented ones.
  const interactive = new Set(['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'searchbox'])
  const ids = (ax.nodes as Array<{ role?: { value?: string }; backendDOMNodeId?: number; ignored?: boolean }>)
    .filter(n => !n.ignored && interactive.has(n.role?.value ?? '') && n.backendDOMNodeId)
    .slice(0, 6).map(n => n.backendDOMNodeId!)
  const geometry = []
  for (const backendNodeId of ids) {
    const entry: Record<string, unknown> = { backendNodeId }
    for (const [key, method] of [['quads', 'DOM.getContentQuads'], ['box', 'DOM.getBoxModel'], ['node', 'DOM.describeNode']] as const) {
      try { entry[key] = await cdp.send(method, { backendNodeId, ...(method === 'DOM.describeNode' ? { depth: 0 } : {}) }, sessionId) } catch (e) { entry[key] = { error: (e as Error).message } }
    }
    geometry.push(entry)
  }
  await writeFile(join(FIXTURES, `dom-geometry.${name}.json`), JSON.stringify({ provenance: JSON.parse(header), geometry }, null, 1))
  await cdp.send('Target.closeTarget', { targetId })
}

// ---------------------------------------------------------------------------
// --check: provenance + privacy
// ---------------------------------------------------------------------------

async function check(): Promise<void> {
  const files = await readdir(FIXTURES)
  const home = homedir()
  const problems: string[] = []
  for (const file of files) {
    if (file === 'README.md') continue
    const text = await readFile(join(FIXTURES, file), 'utf8')
    if (!text.includes('record-fixtures.mts')) problems.push(`${file}: no provenance header`)
    if (text.includes(home) || /\/Users\/[^/"\s]+/.test(text)) problems.push(`${file}: contains a home path`)
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  console.log(`ok: ${files.length} fixture files`)
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (args.includes('--check')) return check()
  await mkdir(FIXTURES, { recursive: true })

  // The page server is started FIRST so it appears in the process/port
  // recording as what it really is: a dev server started from inside an
  // agent's own tool call (the U2 shape in the decomposition).
  const { server, port } = await startServer()
  try {
    // A real terminal dev server, shaped exactly like the app's tmux-backed
    // terminals: tmux daemonizes its SERVER (ppid 1), so pane processes do
    // not descend from Electron at all (observed 2026-09-22). The session
    // name is deliberately NOT `agentcode-…` so the app never adopts it, and
    // it is killed in the finally below.
    const tmuxSession = args.includes('--tmux-dev-server') ? `acpocket-rec-${process.pid}` : null
    if (tmuxSession) {
      await run(TMUX, ['new-session', '-d', '-s', tmuxSession, 'python3 -m http.server 0 --bind 127.0.0.1'])
      await new Promise(r => setTimeout(r, 1500))
    }
    try {
    const rows = await processTable()
    const root = appRoot(rows)
    // Pane subtrees are recorded alongside the app subtree for the reason
    // above; without them a terminal's dev server is invisible.
    const panePids = (await tmuxPanes()).split('\n').flatMap(l => { const m = /^(\S+) (\d+)$/.exec(l); return m ? [Number(m[2])] : [] })
    const treePids = new Set<number>()
    const tree = [root, ...panePids].flatMap(r => subtree(rows, r)).filter(r => (treePids.has(r.pid) ? false : (treePids.add(r.pid), true)))
    const head = provenance('pid ppid comm (basename only) for the Agent Code app subtree', { tag: TAG, root: String(root), recorderPid: String(process.pid), pageServerPort: String(port) })
    await writeFile(join(FIXTURES, `ps-topology.${TAG}.txt`), `# ${head}\n${tree.map(r => `${r.pid} ${r.ppid} ${r.comm}`).join('\n')}\n`)
    await writeFile(join(FIXTURES, `lsof-listen.${TAG}.txt`), `# ${provenance('lsof -nP -a -iTCP -sTCP:LISTEN -F pcn -p <app subtree>', { tag: TAG })}\n${await lsofListen(tree.map(r => r.pid))}`)
    await writeFile(join(FIXTURES, `lsof-listen.system.txt`), `# ${provenance('lsof -nP -a -iTCP -sTCP:LISTEN -F pn (system-wide, no command names)')}\n${await lsofListen()}`)
    await writeFile(join(FIXTURES, `tmux-panes.${TAG}.txt`), `# ${provenance("tmux list-panes -a -F '#{session_name} #{pane_pid}'", { tag: TAG })}\n${await tmuxPanes()}`)

    const owned = [...new Set((await lsofListen(tree.map(r => r.pid))).split('\n').filter(l => l.startsWith('n')).map(l => Number(/:(\d+)$/.exec(l)?.[1])).filter(Boolean))]
    const probes = []
    for (const p of owned) probes.push(await probe(p))
    await writeFile(join(FIXTURES, `probe.${TAG}.json`), JSON.stringify({ provenance: JSON.parse(provenance('GET / on listeners owned by the app subtree', { tag: TAG })), probes }, null, 1))

    } finally {
      if (tmuxSession) await run(TMUX, ['kill-session', '-t', tmuxSession]).catch(() => {})
    }

    const { proc, cdp, profile } = await launchChrome()
    try {
      const { product } = await cdp.send('Browser.getVersion')
      for (const name of ['form', 'iframe', 'list', 'errors', 'spa']) {
        await recordPage(cdp, `http://127.0.0.1:${port}/${name}`, name, product)
        console.log(`recorded ${name}`)
      }
    } finally {
      cdp.close()
      proc.kill()
      await rm(profile, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    server.close()
  }
  await check()
}

main().catch(error => { console.error(error); process.exit(1) })
