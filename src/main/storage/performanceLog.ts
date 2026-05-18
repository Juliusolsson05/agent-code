import { mkdir, open, writeFile } from 'fs/promises'
import { join } from 'path'

import { PERFORMANCE_RUNS_DIR } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'

const TAIL_BYTES = 256 * 1024

export type PerformanceLogFile =
  | 'events'
  | 'spans'
  | 'metrics'
  | 'errors'
  | 'slow'
  | 'pane-process'

const writeQueues = new Map<string, Promise<void>>()

export async function ensurePerformanceRunDir(runFolderName: string): Promise<string> {
  const runDir = join(PERFORMANCE_RUNS_DIR, runFolderName)
  await mkdir(runDir, { recursive: true })
  scheduleDebugStoragePrune('performance-run-start')
  return runDir
}

export function queuePerformanceAppend(
  runDir: string,
  file: PerformanceLogFile,
  lines: string[],
): Promise<void> {
  const key = join(runDir, `${file}.jsonl`)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (lines.length === 0) return
      await mkdir(runDir, { recursive: true })
      await writeFile(key, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'a' })
      scheduleDebugStoragePrune('performance-append')
    })
  writeQueues.set(key, next)
  return next
}

export async function writePerformanceManifest(
  runDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

export async function readPerformanceTail(
  runDir: string,
  file: PerformanceLogFile,
): Promise<string> {
  try {
    const path = join(runDir, `${file}.jsonl`)
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const length = size - start
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      // WHY positioned reads instead of readFile+slice: debug bundles request
      // six perf-log tails at once, and long perf runs can make each JSONL
      // hundreds of MB. The caller only needs a 256 KiB diagnostic tail, so
      // reading from the end keeps snapshot creation from becoming another
      // burst-allocation path during a perf investigation.
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}
