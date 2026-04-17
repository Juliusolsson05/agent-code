// End-to-end test of the real ResponsesProxy class against a live
// `codex exec` invocation. Replaces the inline toy proxy from
// proxy-harness.mts with the actual production implementation so we
// confirm it works on the wire, not just on paper.
//
// Usage:
//   node --import tsx/esm scripts/proxy-harness-real.mts "your prompt"

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ResponsesProxy } from 'codex-headless'

const prompt = process.argv[2] ?? 'reply with exactly the word PONG'
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const dumpDir = `/tmp/codex-proxy-real-${ts}`
mkdirSync(dumpDir, { recursive: true })

const proxy = await ResponsesProxy.create()
console.error(`[harness] proxy: ${proxy.info.proxyBaseUrl}`)
console.error(`[harness] auth: ${proxy.info.authMode} → ${proxy.info.upstreamBaseUrl}`)

let reqCount = 0
let chunkCount = 0
let totalBytes = 0

proxy.on('event', ev => {
  const kind = ev.kind
  if (kind === 'request') {
    reqCount++
    console.error(`[proxy] ${ev.method} ${ev.path} → ${ev.upstream}`)
  } else if (kind === 'response') {
    console.error(`[proxy] upstream status ${ev.status} for ${ev.path}`)
  } else if (kind === 'response-chunk') {
    chunkCount++
    totalBytes += Number(ev.size ?? 0)
  } else if (kind === 'response-end') {
    console.error(`[proxy] end ${ev.path} total ${ev.bytes}B`)
  } else if (kind === 'upgrade-rejected') {
    console.error(`[proxy] WS upgrade rejected for ${ev.path} (expected)`)
  } else if (kind === 'rejected') {
    console.error(`[proxy] rejected ${ev.method} ${ev.path}`)
  } else if (kind === 'upstream-error' || kind === 'server-error' || kind === 'response-error') {
    console.error(`[proxy] ${kind}: ${ev.message}`)
  } else {
    console.error(`[proxy] ${JSON.stringify(ev)}`)
  }
})

const child = spawn(
  'codex',
  ['exec', '--skip-git-repo-check', '-c', `openai_base_url="${proxy.info.proxyBaseUrl}"`, prompt],
  { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
)

const outSink = createWriteStream(join(dumpDir, 'codex.stdout'))
const errSink = createWriteStream(join(dumpDir, 'codex.stderr'))
child.stdout.pipe(outSink)
child.stderr.pipe(errSink)
child.stdout.on('data', d => process.stdout.write(d))

const exitCode: number = await new Promise(resolve => {
  child.on('exit', code => resolve(code ?? -1))
})

await proxy.stop()

console.error('\n[harness] SUMMARY')
console.error(`  codex exit:        ${exitCode}`)
console.error(`  proxy requests:    ${reqCount}`)
console.error(`  chunks observed:   ${chunkCount}`)
console.error(`  bytes observed:    ${totalBytes}`)
console.error(`  dumps:             ${dumpDir}`)

process.exit(reqCount > 0 && exitCode === 0 ? 0 : 1)
