// Verify the CodexResponsesAdapter emits SemanticEvent on the
// headless semantic channel when codex streams through our proxy.
//
// Unlike proxy-harness-real.mts (which only checks transport), this
// instantiates a real CodexHeadless-adjacent listener — we attach to
// a fresh CodexResponsesAdapter and watch its emissions directly.
//
// Usage:
//   node --import tsx/esm scripts/proxy-harness-semantic.mts "prompt"

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { ResponsesProxy } from '../src/providers/codex/runtime/responsesProxy.js'
import { CodexResponsesAdapter } from '../src/providers/codex/runtime/codexResponsesAdapter.js'

const prompt = process.argv[2] ?? 'reply with exactly the word PONG'

// Build a tiny CodexHeadless stand-in. The adapter only touches
// `.semantic`, so we only need that surface.
class FakeSemantic extends EventEmitter {
  startTurn(p: unknown): void { this.emit('event', { type: 'turn_started', ...p as object }) }
  applyDelta(p: unknown): void { this.emit('event', { type: 'turn_delta', ...p as object }) }
  finishTurn(p: unknown): void { this.emit('event', { type: 'turn_completed', ...p as object }) }
  usageUpdated(p: unknown): void { this.emit('event', { type: 'usage_updated', ...p as object }) }
}
const fakeHeadless = { semantic: new FakeSemantic() } as never

const proxy = await ResponsesProxy.create()
const adapter = new CodexResponsesAdapter(proxy, fakeHeadless)
adapter.attach()

console.error(`[harness] proxy: ${proxy.info.proxyBaseUrl}  auth: ${proxy.info.authMode}`)

type SemEv = { type: string } & Record<string, unknown>
const semEvents: SemEv[] = []
fakeHeadless.semantic.on('event', (ev: SemEv) => {
  semEvents.push(ev)
  if (ev.type === 'turn_started') console.error(`[sem] turn_started ${String(ev.turnId).slice(0, 18)}…`)
  if (ev.type === 'turn_delta') {
    const delta = String(ev.textDelta ?? '')
    if (delta) console.error(`[sem] delta +${delta.length}B: ${JSON.stringify(delta).slice(0, 80)}`)
  }
  if (ev.type === 'turn_completed') console.error(`[sem] turn_completed fullText=${String(ev.fullText ?? '').length}B`)
  if (ev.type === 'usage_updated') console.error(`[sem] usage: ${JSON.stringify(ev.usage)}`)
  if (ev.type === 'flow_selected') console.error(`[sem] flow_selected ${ev.flowId} — ${ev.reason}`)
  if (ev.type === 'flow_ignored') console.error(`[sem] flow_ignored ${ev.flowId} — ${ev.reason}`)
})

const child = spawn(
  'codex',
  ['exec', '--skip-git-repo-check', '-c', `openai_base_url="${proxy.info.proxyBaseUrl}"`, prompt],
  { stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
)
child.stdout.on('data', d => process.stdout.write(d))

const exitCode: number = await new Promise(resolve => child.on('exit', c => resolve(c ?? -1)))

adapter.detach()
await proxy.stop()

const starts = semEvents.filter(e => e.type === 'turn_started').length
const deltas = semEvents.filter(e => e.type === 'turn_delta').length
const completes = semEvents.filter(e => e.type === 'turn_completed').length
const usages = semEvents.filter(e => e.type === 'usage_updated').length

console.error(`\n[harness] SUMMARY`)
console.error(`  codex exit:     ${exitCode}`)
console.error(`  sem turn_start: ${starts}`)
console.error(`  sem deltas:     ${deltas}`)
console.error(`  sem completes:  ${completes}`)
console.error(`  sem usage:      ${usages}`)

process.exit(starts > 0 && deltas > 0 && completes > 0 ? 0 : 1)
