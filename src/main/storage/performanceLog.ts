import { mkdir, readFile, writeFile } from 'fs/promises'
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
    const content = await readFile(path, 'utf8')
    if (content.length <= TAIL_BYTES) return content
    return content.slice(content.length - TAIL_BYTES)
  } catch {
    return ''
  }
}
