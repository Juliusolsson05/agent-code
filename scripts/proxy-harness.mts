// Headless proxy harness — verifies that our CodexResponsesProxy is
// actually reached by `codex exec`, and captures every wire event.
//
// Usage:
//   node --import tsx/esm scripts/proxy-harness.mts "say hi briefly"
//
// Output: dumps every proxy event to stderr in real time, records the
// full SSE response body to /tmp/codex-proxy-harness-<ts>/response.sse,
// and exits with 0 iff at least one request was seen.
//
// WHY a standalone harness and not a unit test:
//   The failure mode is "codex doesn't hit the proxy at all" — unit
//   tests mocking the HTTP server can't reproduce that. We need to
//   actually spawn the real `codex` binary with real CLI flags and
//   watch what it does on the wire.

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const prompt = process.argv[2] ?? 'say hi in three words'

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const dumpDir = `/tmp/codex-proxy-harness-${ts}`
mkdirSync(dumpDir, { recursive: true })
console.error(`[harness] dump dir: ${dumpDir}`)

// ---- Detect auth mode so we know which upstream to forward to ----
let authMode: 'chatgpt' | 'apikey' | 'unknown' = 'unknown'
const authPath = join(homedir(), '.codex', 'auth.json')
if (existsSync(authPath)) {
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8')) as { auth_mode?: string }
    if (parsed.auth_mode === 'chatgpt') authMode = 'chatgpt'
    else if (parsed.auth_mode === 'apikey') authMode = 'apikey'
  } catch { /* ignore */ }
}
if (authMode === 'unknown' && process.env.OPENAI_API_KEY) authMode = 'apikey'

const upstreamBase = authMode === 'chatgpt'
  ? 'https://chatgpt.com/backend-api/codex'
  : 'https://api.openai.com/v1'

console.error(`[harness] auth_mode=${authMode}, upstream=${upstreamBase}`)

// ---- Start proxy ----
let requestCount = 0

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const startedAt = Date.now()
  const reqId = ++requestCount
  console.error(`[proxy#${reqId}] ${req.method} ${req.url}`)
  console.error(`[proxy#${reqId}] headers:`)
  for (const [k, v] of Object.entries(req.headers)) {
    const shown = k.toLowerCase() === 'authorization' ? `<redacted, len=${String(v).length}>` : String(v)
    console.error(`  ${k}: ${shown}`)
  }

  // Only accept POST /responses or POST /v1/responses
  const url = req.url ?? ''
  const isResponsesCall =
    req.method === 'POST' && (url === '/responses' || url === '/v1/responses')

  if (!isResponsesCall) {
    res.statusCode = 404
    res.end(`unsupported: ${req.method} ${url}\n`)
    console.error(`[proxy#${reqId}] rejected`)
    return
  }

  // Buffer body and dump
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const body = Buffer.concat(chunks)
  writeFileSync(join(dumpDir, `${String(reqId).padStart(3, '0')}-request.json`), body)
  console.error(`[proxy#${reqId}] body ${body.length}B → dumped`)

  // Build upstream URL: <upstreamBase>/responses
  const upstreamUrl = `${upstreamBase}/responses`

  // Forward headers, strip hop-by-hop
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    const lower = k.toLowerCase()
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue
    if (Array.isArray(v)) for (const part of v) headers.append(k, part)
    else headers.set(k, v)
  }

  try {
    const upstream = await fetch(upstreamUrl, { method: 'POST', headers, body })
    console.error(`[proxy#${reqId}] upstream ${upstream.status} in ${Date.now() - startedAt}ms`)

    res.statusCode = upstream.status
    upstream.headers.forEach((value, key) => {
      if (['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) return
      res.setHeader(key, value)
    })

    if (!upstream.body) {
      res.end()
      return
    }

    const sseSink = createWriteStream(join(dumpDir, `${String(reqId).padStart(3, '0')}-response.sse`))
    const nodeStream = Readable.fromWeb(upstream.body as never)
    let bytes = 0
    nodeStream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buf.length
      sseSink.write(buf)
    })
    nodeStream.on('end', () => {
      sseSink.end()
      console.error(`[proxy#${reqId}] streamed ${bytes}B SSE over ${Date.now() - startedAt}ms`)
    })
    nodeStream.on('error', err => {
      console.error(`[proxy#${reqId}] stream error:`, err)
      try { res.destroy() } catch { /* already gone */ }
    })
    nodeStream.pipe(res)
  } catch (err) {
    console.error(`[proxy#${reqId}] fetch failed:`, err)
    res.statusCode = 502
    res.setHeader('content-type', 'text/plain')
    res.end(String(err))
  }
})

const port: number = await new Promise<number>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') return reject(new Error('no address'))
    resolve(addr.port)
  })
})

const proxyBase = `http://127.0.0.1:${port}`
console.error(`[harness] proxy listening at ${proxyBase}`)

// ---- Spawn codex ----
// Try THREE override strategies in sequence; print which one triggers
// a request. This is the whole point: we don't know which approach
// actually routes codex through our proxy, so we test them.

async function runCodex(label: string, extraArgs: string[]): Promise<number> {
  requestCount = 0
  console.error(`\n[harness] === ${label} ===`)
  console.error(`[harness] argv: codex exec ${extraArgs.join(' ')} "${prompt}"`)
  const child = spawn('codex', ['exec', ...extraArgs, prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  const stdoutSink = createWriteStream(join(dumpDir, `${label}.stdout.log`))
  const stderrSink = createWriteStream(join(dumpDir, `${label}.stderr.log`))
  child.stdout.pipe(stdoutSink)
  child.stderr.pipe(stderrSink)
  child.stdout.on('data', d => process.stdout.write(`[codex.out] ${d}`))
  child.stderr.on('data', d => process.stderr.write(`[codex.err] ${d}`))

  const exitCode: number = await new Promise(resolve => {
    child.on('exit', code => resolve(code ?? -1))
  })
  console.error(`[harness] codex exit ${exitCode}, proxy saw ${requestCount} request(s)`)
  return requestCount
}

// Strategy A: -c openai_base_url=... (built-in provider override)
const hitsA = await runCodex('A-openai_base_url', [
  '--skip-git-repo-check',
  '-c', `openai_base_url="${proxyBase}/v1"`,
])

// Strategy B: custom model_providers entry + model_provider select
const hitsB = hitsA > 0 ? 0 : await runCodex('B-model_providers', [
  '--skip-git-repo-check',
  '-c', `model_providers.harness={ name = "Harness", base_url = "${proxyBase}/v1", wire_api = "responses", requires_openai_auth = true }`,
  '-c', 'model_provider="harness"',
])

// Strategy C: override chatgpt_base_url too (belt-and-braces for chatgpt auth mode)
const hitsC = (hitsA > 0 || hitsB > 0) ? 0 : await runCodex('C-both-base-urls', [
  '--skip-git-repo-check',
  '-c', `openai_base_url="${proxyBase}/v1"`,
  '-c', `chatgpt_base_url="${proxyBase}"`,
])

server.close()
console.error(`\n[harness] SUMMARY`)
console.error(`  A (-c openai_base_url):     ${hitsA} request(s)`)
console.error(`  B (-c model_providers.*):   ${hitsB} request(s)`)
console.error(`  C (both base urls):         ${hitsC} request(s)`)
console.error(`[harness] dumps in ${dumpDir}`)
process.exit(hitsA + hitsB + hitsC > 0 ? 0 : 1)
