#!/usr/bin/env tsx
/**
 * testbench/replay.ts — load a recorded session and run parsers offline.
 *
 * Usage:
 *   npm run replay -- <recordingDir>           # final-state replay
 *   npm run replay -- <recordingDir> --frames  # also dump every snapshot frame
 *
 * What it does:
 *   1. Reads `raw.events.jsonl` from the recording — the timestamped PTY
 *      byte stream.
 *   2. Feeds the bytes into a fresh `@xterm/headless` Terminal sized to the
 *      recording's metadata.
 *   3. After the full stream has been applied, snapshots the screen and
 *      runs each parser against it. Prints raw vs parsed side-by-side so
 *      we can iterate on the chrome stripper without re-running CC.
 *
 * The parsers tested are imported from src/core/parsers/. Add new ones
 * here as we build them.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'

import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless

import {
  extractAssistantInProgress,
  extractStreamingText,
} from '../src/core/parsers/streamingScreen.js'
import { detectTrustDialog } from '../src/core/parsers/trustDialog.js'

type RawEvent = { ts: number; data: string }
type Meta = { cols?: number; rows?: number; cwd?: string; startedAt?: string }

const SEPARATOR = '─'.repeat(78)

function snapshot(term: InstanceType<typeof Terminal>): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

async function loadRawEvents(dir: string): Promise<RawEvent[]> {
  const text = await readFile(join(dir, 'raw.events.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as RawEvent)
}

async function loadMeta(dir: string): Promise<Meta> {
  try {
    const text = await readFile(join(dir, 'meta.json'), 'utf8')
    return JSON.parse(text) as Meta
  } catch {
    return {}
  }
}

function box(title: string, body: string): string {
  return `${SEPARATOR}\n${title}\n${SEPARATOR}\n${body}\n`
}

async function main(): Promise<void> {
  const recordingDir = process.argv[2]
  if (!recordingDir) {
    console.error('usage: tsx testbench/replay.ts <recordingDir> [--frames]')
    process.exit(1)
  }

  const dumpFrames = process.argv.includes('--frames')

  const meta = await loadMeta(recordingDir)
  const events = await loadRawEvents(recordingDir)

  console.log(box('META', JSON.stringify(meta, null, 2)))
  console.log(`${events.length} raw events in stream`)
  if (events.length === 0) {
    console.error('empty recording')
    process.exit(1)
  }
  const span = (events[events.length - 1].ts - events[0].ts) / 1000
  console.log(`spans ${span.toFixed(2)}s wall clock`)
  console.log()

  const term = new Terminal({
    cols: meta.cols ?? 120,
    rows: meta.rows ?? 40,
    allowProposedApi: true,
    scrollback: 10000,
  })

  if (dumpFrames) {
    // xterm-headless's Terminal#write is asynchronous: the buffer is
    // updated in a deferred pass, so snapshot() called synchronously
    // right after write() returns stale content (usually the previous
    // frame). Use the callback form to await each write. It's slower
    // but correct, and replay doesn't need to be fast.
    const writeAndFlush = (data: string): Promise<void> =>
      new Promise(resolve => term.write(data, () => resolve()))

    let prev = ''
    for (let i = 0; i < events.length; i++) {
      await writeAndFlush(events[i].data)
      const screen = snapshot(term)
      if (screen === prev) continue
      prev = screen
      const stripped = extractStreamingText(screen)
      const assistant = extractAssistantInProgress(screen)
      console.log(
        box(
          `FRAME ${i + 1}/${events.length}  (+${events[i].ts - events[0].ts}ms)`,
          '',
        ),
      )
      console.log('--- raw screen ---')
      console.log(screen)
      console.log()
      console.log('--- extractStreamingText ---')
      console.log(stripped)
      console.log()
      console.log('--- extractAssistantInProgress ---')
      console.log(assistant || '(empty)')
      console.log()
    }
    return
  }

  // Final-state replay: just feed everything in and snapshot once.
  for (const ev of events) term.write(ev.data)

  // Allow xterm-headless to flush its async write callback
  await new Promise<void>(resolve => setTimeout(resolve, 50))

  const screen = snapshot(term)
  console.log(box('FINAL RAW SCREEN', screen))
  console.log(box('extractStreamingText (chrome-strip)', extractStreamingText(screen)))
  console.log(
    box(
      'extractAssistantInProgress (just the assistant block)',
      extractAssistantInProgress(screen) || '(no assistant marker on screen)',
    ),
  )
  console.log(
    box(
      'detectTrustDialog',
      JSON.stringify(detectTrustDialog(screen), null, 2),
    ),
  )
}

main().catch(err => {
  console.error('[replay] fatal:', err)
  process.exit(1)
})
