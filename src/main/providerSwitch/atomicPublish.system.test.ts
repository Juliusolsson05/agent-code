import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
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
  /** Make `link` fail with this errno, as a filesystem without hard links
   *  really does — review measured ENOTSUP on a real FAT32 volume. */
  linkFails: null as null | string,
  /** Every `open`, so the staging LOCATION and the file mode are observable. */
  opened: [] as Array<{ path: string; mode: number | undefined }>,
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
      hooks.opened.push({ path: String(args[0]), mode: args[2] as number | undefined })
      const handle = await real.open(...args)
      if (!String(args[0]).includes('.partial')) return handle
      return new Proxy(handle, {
        get(target, key, receiver) {
          if (key === 'writeFile') {
            // Fail AFTER the file exists and is open — the shape of a crash or
            // a full disk part-way through streaming the bytes.
            if (hooks.failStagedWrite) return async () => { throw new Error('ENOSPC: no space left on device') }
            return async (...write: unknown[]) => {
              await (target.writeFile as (...a: unknown[]) => Promise<void>)(...write)
              // Recorded on COMPLETION, not invocation. Recording on
              // invocation made the order assertion meaningless: dropping the
              // `await` from the fsync — which destroys the very
              // contents-before-name guarantee the design rests on — still
              // produced write/sync/link in the trace.
              hooks.trace.push('write')
            }
          }
          if (key === 'sync') {
            // Deferred by a macrotask on purpose. Recording immediately after
            // the real sync was not enough: with `await` dropped from the
            // implementation, the `close()` that follows still yields long
            // enough for a microtask to land, so the trace looked correct
            // while the durability guarantee was gone. A timer outlives
            // close's microtasks, so only an implementation that actually
            // AWAITS the sync can produce sync-before-link.
            return async () => {
              await target.sync()
              await new Promise(resolve => setTimeout(resolve, 5))
              hooks.trace.push('sync')
            }
          }
          const value = Reflect.get(target, key, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    async link(...args: Parameters<typeof real.link>) {
      hooks.trace.push('link')
      await hooks.beforeLink?.()
      if (hooks.linkFails) {
        const error = new Error(`${hooks.linkFails}: hard links are not supported`) as NodeJS.ErrnoException
        error.code = hooks.linkFails
        throw error
      }
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
  hooks.linkFails = null
  hooks.trace = []
  hooks.opened = []
})
afterEach(async () => {
  hooks.failStagedWrite = false
  hooks.beforeLink = null
  hooks.linkFails = null
  await chmod(directory, 0o700).catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
})

describe('publishing a projected transcript (#928)', () => {
  it('creates the final name with the complete contents', async () => {
    const target = join(directory, 'ses_1.jsonl')
    expect(await publishNativeTranscript(target, TRANSCRIPT))
      .toEqual({ path: target, atomic: true })
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
      .toEqual({ path: target, atomic: true })
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

describe('a filesystem without hard links still publishes (#1076 review, 1)', () => {
  // Review created a real FAT32 volume and measured `link` → ENOTSUP there,
  // while `writeFile` worked. Both provider roots are user-settable
  // (CLAUDE_CONFIG_DIR, CODEX_HOME), so an exFAT external drive or a network
  // mount is an ordinary setup — and failing outright would REGRESS a case
  // that worked before this change, with an errno libuv renders as
  // "operation not supported on socket".
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']) {
    it(`falls back when link fails with ${code}`, async () => {
      hooks.linkFails = code
      const target = join(directory, 'ses_1.jsonl')
      // `atomic: false` is the honest receipt: no-clobber survived, the
      // zero-width window did not.
      expect(await publishNativeTranscript(target, TRANSCRIPT))
        .toEqual({ path: target, atomic: false })
      expect(await readFile(target, 'utf8')).toBe(TRANSCRIPT)
    })
  }

  it('still refuses to overwrite a different transcript on that path', async () => {
    // The guarantee that must NOT be traded away: `wx` is still atomic
    // create-exclusive, so an adopted target survives here too.
    hooks.linkFails = 'ENOTSUP'
    const target = join(directory, 'ses_1.jsonl')
    const theirs = 'someone else\n'
    await writeFile(target, theirs, 'utf8')
    await expect(publishNativeTranscript(target, TRANSCRIPT)).rejects.toThrow(/Refusing to overwrite/)
    expect(await readFile(target, 'utf8')).toBe(theirs)
  })

  it('is still idempotent on that path', async () => {
    hooks.linkFails = 'ENOTSUP'
    const target = join(directory, 'ses_1.jsonl')
    await writeFile(target, TRANSCRIPT, 'utf8')
    expect(await publishNativeTranscript(target, TRANSCRIPT)).toEqual({ path: target, atomic: false })
  })

  it('does NOT fall back on an error that means something else', async () => {
    // ENOSPC is a real failure, not a missing capability. Swallowing it would
    // hide a full disk behind a second attempt that fails the same way.
    hooks.linkFails = 'ENOSPC'
    await expect(publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT))
      .rejects.toThrow(/ENOSPC/)
    expect(await discoverable()).toEqual([])
  })
})

describe('the staged file is where and what it claims to be', () => {
  it('stages inside the TARGET directory, not a temp dir', async () => {
    // The staging comment leans on exactly this: `link` cannot cross a
    // filesystem, so a stage in os.tmpdir() is an EXDEV on any target outside
    // the root volume. On this machine both are the same volume, so nothing
    // but the path itself can catch it.
    const target = join(directory, 'nested', 'ses_1.jsonl')
    await publishNativeTranscript(target, TRANSCRIPT)
    const stage = hooks.opened.find(entry => entry.path.includes('.partial'))
    expect(stage?.path.startsWith(join(directory, 'nested'))).toBe(true)
  })

  it('creates both the stage and a fallback target 0600', async () => {
    // `writeFile` produced 0644 under a typical umask. A transcript is
    // conversation content; the tighter mode matches the Grok writer. Pinned
    // because it is a silent change to files a user may already have.
    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect(hooks.opened.find(entry => entry.path.includes('.partial'))?.mode).toBe(0o600)

    hooks.opened = []
    hooks.linkFails = 'ENOTSUP'
    await publishNativeTranscript(join(directory, 'ses_2.jsonl'), TRANSCRIPT)
    expect(hooks.opened.find(entry => entry.path.endsWith('ses_2.jsonl'))?.mode).toBe(0o600)
  })

  it('fsyncs the directory so the NAME survives too', async () => {
    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect(hooks.opened.some(entry => entry.path === directory)).toBe(true)
  })
})

describe('an incumbent that cannot be read is never overwritten', () => {
  it('treats an unreadable target as DIFFERENT, not identical', async () => {
    // The safe direction. Answering "identical" on a failed read would let a
    // publish silently adopt a name whose contents nobody could check — and
    // the old whole-file `readFile` threw `ERR_STRING_TOO_LONG` above 512 MB,
    // which is reachable: the largest real rollout measured 325 MB.
    //
    // The size deliberately MATCHES, so the cheap check passes and the read
    // itself is what fails. A target of a different size never reaches this
    // branch at all.
    const target = join(directory, 'ses_1.jsonl')
    await writeFile(target, TRANSCRIPT, 'utf8')
    await chmod(target, 0o000)
    try {
      await expect(publishNativeTranscript(target, TRANSCRIPT)).rejects.toThrow(/Refusing to overwrite/)
    } finally {
      await chmod(target, 0o600)
    }
  })

  it('treats a target that is not a file at all as DIFFERENT', async () => {
    const target = join(directory, 'ses_1.jsonl')
    await mkdir(target, { recursive: true })
    await expect(publishNativeTranscript(target, TRANSCRIPT)).rejects.toThrow(/Refusing to overwrite/)
  })

  it('compares by size before reading anything', async () => {
    const target = join(directory, 'ses_1.jsonl')
    await writeFile(target, `${TRANSCRIPT}extra`, 'utf8')
    await expect(publishNativeTranscript(target, TRANSCRIPT)).rejects.toThrow(/Refusing to overwrite/)
  })
})

describe('an abandoned stage does not live forever (#1076 review, 4)', () => {
  it('sweeps a stale stage on the next publish', async () => {
    // Nothing else ever would: Claude's retention skips non-.jsonl, Codex
    // parses only rollout-*.jsonl, and debug retention never leaves STATE_DIR.
    // A stage that survived `link` plus a failed `rm` is a SECOND HARD LINK,
    // so the bytes are never reclaimed even after the transcript ages out.
    const abandoned = join(directory, '.agent-code-publish-old.partial')
    await writeFile(abandoned, 'x'.repeat(1024), 'utf8')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(abandoned, old, old)

    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect(await readdir(directory)).toEqual(['ses_1.jsonl'])
  })

  it('leaves a FRESH stage alone, because it may be a live publish', async () => {
    // Age is the only thing distinguishing an abandoned stage from one being
    // written right now, and deleting a live one recreates the corruption this
    // file exists to prevent.
    const live = join(directory, '.agent-code-publish-live.partial')
    await writeFile(live, 'x', 'utf8')
    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect((await readdir(directory)).sort()).toEqual(['.agent-code-publish-live.partial', 'ses_1.jsonl'])
  })

  it('never touches a file that is not one of ours', async () => {
    const other = join(directory, '.DS_Store')
    await writeFile(other, 'x', 'utf8')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(other, old, old)
    await publishNativeTranscript(join(directory, 'ses_1.jsonl'), TRANSCRIPT)
    expect((await readdir(directory)).sort()).toEqual(['.DS_Store', 'ses_1.jsonl'])
  })
})
