import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two failure shapes below are filesystem TIMING, not filesystem state, so
// they cannot be produced by arranging files — only by interrupting the real
// calls. `vi.mock` with a factory is the one way to do that for an ESM module
// (`vi.spyOn` cannot redefine a namespace export), and it delegates to the
// real implementation except on the one call a test arms.
const hooks = vi.hoisted(() => ({
  failStagedWrite: false as boolean,
  beforeLink: null as null | (() => Promise<void>),
  /** Ordered record of what happened to the staged file, so the ORDER of
   *  contents-then-name can be asserted even though durability itself cannot
   *  be tested from userspace. */
  trace: [] as string[],
}))

vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...real,
    async open(...args: Parameters<typeof real.open>) {
      const handle = await real.open(...args)
      if (String(args[0]).includes('.partial')) {
        return new Proxy(handle, {
          get(target, key, receiver) {
            if (key === 'writeFile') {
              if (hooks.failStagedWrite) return async () => { throw new Error('ENOSPC: no space left on device') }
              return async (...write: unknown[]) => {
                hooks.trace.push('write')
                return await (target.writeFile as (...a: unknown[]) => Promise<void>)(...write)
              }
            }
            if (key === 'sync') {
              return async () => { hooks.trace.push('sync'); return await target.sync() }
            }
            const value = Reflect.get(target, key, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      }
      if (!hooks.failStagedWrite || !String(args[0]).includes('.partial')) return handle
      return new Proxy(handle, {
        get(target, key, receiver) {
          // Fail AFTER the file exists and is open — the shape of a crash or a
          // full disk part-way through streaming the bytes.
          if (key === 'writeFile') return async () => { throw new Error('ENOSPC: no space left on device') }
          const value = Reflect.get(target, key, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    async link(...args: Parameters<typeof real.link>) {
      hooks.trace.push('link')
      await hooks.beforeLink?.()
      return await real.link(...args)
    },
  }
})

import { publishNativeTranscript } from './shared.js'

// ---------------------------------------------------------------------------
// #928. Both native target writers called `writeFile` on the FINAL,
// discoverable filename — `~/.claude/projects/<slug>/<uuid>.jsonl` and
// `~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl`. `writeFile`
// truncates and then streams, so a crash, a full disk or a killed process
// mid-write leaves a TRUNCATED transcript under exactly the name the provider
// enumerates and will resume from. Validating the projection in memory first
// cannot help: the projection was fine, the bytes are not.
//
// Real files in a real directory, because every guarantee here is a
// filesystem guarantee — atomic create-exclusive, what a discovery glob can
// see mid-publish, and what survives a failure.
// ---------------------------------------------------------------------------

let directory: string
const TRANSCRIPT = `{"type":"session_meta","id":"ses_1"}\n{"type":"message","role":"user"}\n`

/** Everything a provider's discovery glob would see. */
async function discoverable(): Promise<string[]> {
  return (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort()
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atomic-publish-'))
  hooks.failStagedWrite = false
  hooks.beforeLink = null
  hooks.trace = []
})
afterEach(async () => {
  hooks.failStagedWrite = false
  hooks.beforeLink = null
  await chmod(directory, 0o700).catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
})

describe('publishing a projected transcript (#928)', () => {
  it('creates the final name with the complete contents', async () => {
    const target = join(directory, 'ses_1.jsonl')
    expect(await publishNativeTranscript(target, TRANSCRIPT))
      .toEqual({ path: target, outcome: 'created' })
    expect(await readFile(target, 'utf8')).toBe(TRANSCRIPT)
    expect(await discoverable()).toEqual(['ses_1.jsonl'])
  })

  it('creates the directory when it does not exist yet', async () => {
    const target = join(directory, '2026', '09', '20', 'rollout-x-ses_1.jsonl')
    await publishNativeTranscript(target, TRANSCRIPT)
    expect(await readFile(target, 'utf8')).toBe(TRANSCRIPT)
  })

  it('leaves NOTHING discoverable when the write fails part-way', async () => {
    // The whole point. A truncated file under the final name is a conversation
    // that opens and is silently missing its tail.
    const target = join(directory, 'ses_1.jsonl')
    hooks.failStagedWrite = true
    await expect(publishNativeTranscript(target, TRANSCRIPT)).rejects.toThrow(/ENOSPC/)
    expect(await discoverable()).toEqual([])
    // And no stage is left behind either.
    expect(await readdir(directory)).toEqual([])
  })

  it('gives the file a discoverable name only after its bytes are fsynced', async () => {
    // Durability against power loss cannot be tested from userspace — this
    // pins the ORDER, which is the part that is ours to get right: contents
    // written, contents flushed, and only then a name anything can find.
    // Without it, deleting the fsync ships green.
    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect(hooks.trace).toEqual(['write', 'sync', 'link'])
  })

  it('never leaves a stage where a provider glob would find it', async () => {
    // A `.partial` dotfile matches neither `*.jsonl` nor `rollout-*.jsonl`, so
    // even an abandoned stage is inert rather than resumable.
    const target = join(directory, 'ses_1.jsonl')
    const observed: string[][] = []
    hooks.beforeLink = async () => { observed.push(await discoverable()) }
    await publishNativeTranscript(target, TRANSCRIPT)
    // Mid-publish, with the staged bytes fully written and fsynced: still
    // nothing discoverable.
    expect(observed).toEqual([[]])
  })
})

describe('publication is identity-checked and never clobbers', () => {
  it('treats an identical existing target as already published', async () => {
    // A retry after an interruption between the publish and the caller's own
    // bookkeeping. Succeeding here is what stops a duplicate session being
    // created for work that already landed.
    const target = join(directory, 'ses_1.jsonl')
    await publishNativeTranscript(target, TRANSCRIPT)
    expect(await publishNativeTranscript(target, TRANSCRIPT))
      .toEqual({ path: target, outcome: 'already-published' })
    expect(await readFile(target, 'utf8')).toBe(TRANSCRIPT)
  })

  it('refuses to overwrite a DIFFERENT transcript under the same name', async () => {
    // A target another process adopted. Destroying it would be worse than
    // failing the operation.
    const target = join(directory, 'ses_1.jsonl')
    const theirs = `{"type":"session_meta","id":"ses_1","owner":"someone else"}\n`
    await writeFile(target, theirs, 'utf8')

    await expect(publishNativeTranscript(target, TRANSCRIPT))
      .rejects.toThrow(/Refusing to overwrite/)
    expect(await readFile(target, 'utf8')).toBe(theirs)
  })

  it('does not truncate the incumbent even for a moment', async () => {
    // `rename` would be atomic AND destructive; `writeFile` would truncate
    // first. Neither is acceptable when the name may be adopted.
    const target = join(directory, 'ses_1.jsonl')
    const theirs = 'x'.repeat(4096)
    await writeFile(target, theirs, 'utf8')
    await publishNativeTranscript(target, TRANSCRIPT).catch(() => undefined)
    expect((await readFile(target, 'utf8')).length).toBe(4096)
  })

  it('cleans up its stage when it refuses', async () => {
    const target = join(directory, 'ses_1.jsonl')
    await writeFile(target, 'someone else\n', 'utf8')
    await publishNativeTranscript(target, TRANSCRIPT).catch(() => undefined)
    expect(await readdir(directory)).toEqual(['ses_1.jsonl'])
  })
})

describe('the source is never touched', () => {
  it('publishes without reading or writing anything but the target', async () => {
    // "Preserve original source" — a switch/duplicate/rewind must leave the
    // conversation it was projected FROM exactly as it was.
    const source = join(directory, 'source.jsonl')
    await writeFile(source, 'original\n', 'utf8')
    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect(await readFile(source, 'utf8')).toBe('original\n')
  })
})

describe('an unwritable destination fails loudly', () => {
  it('reports the real errno instead of leaving a half-made artifact', async () => {
    const readOnly = join(directory, 'locked')
    await mkdir(readOnly, { recursive: true })
    await chmod(readOnly, 0o500)
    await expect(publishNativeTranscript(join(readOnly, 'ses_1.jsonl'), TRANSCRIPT))
      .rejects.toThrow(/EACCES|EPERM/)
    await chmod(readOnly, 0o700)
    expect(await readdir(readOnly)).toEqual([])
  })
})
