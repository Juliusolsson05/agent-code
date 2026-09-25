import { readdir, unlink } from 'fs/promises'
import { basename, dirname, join } from 'node:path'

import { isPidRunning } from '@main/storage/processLock.js'

// Scratch files left behind by a run that died mid-save (#826).
//
// Four writers in this app use the same atomic-save shape — write
// `<file>.<pid>.<ms>.<nonce>.tmp`, then rename it over the destination — and
// every one of them cleans up only in the `catch` of a thrown write or rename
// (AiWorkspaceRegistry has no cleanup at all). A process that DIES between
// creating the temp file and finishing the write leaves a zero-byte file
// nothing ever removes. The ⌘Q `beforeunload` flush, which
// `WorkspaceFileStore.commit`'s own comment calls "the highest-collision
// moment in the app's life", is exactly such a moment; so is a crash, and a
// `kill`. One real profile had 80 of them, 2026-05-14 to 2026-09-04, growing
// by a few a week. No data is lost — the rename never happened — but the inode
// growth is unbounded.
//
// WHY this does not break the rule it exists beside: `commit()` deliberately
// refuses to scan the directory, because ANOTHER ADMITTED SAVE MAY OWN a
// sibling name. This does not infer ownership, it proves the opposite. The
// writer's pid is in the name, and a dead pid cannot own an in-flight save:
// the write and the rename both happen inside one live process (verified —
// they are consecutive awaits in one async closure, and there is exactly one
// rename onto each destination in the repo). A reused pid only DELAYS cleanup,
// which is the harmless direction.

/**
 * The scratch-file suffix every one of those writers produces.
 *
 * Anchored and fully specified on purpose. Matching `<file>.*` would take the
 * one-way pre-upgrade `.bak` with it; matching `*.tmp` would reach files this
 * app never wrote; and slicing by prefix LENGTH without checking the prefix
 * would reach a same-length name belonging to another feature. All three are
 * tests.
 */
const SCRATCH_NAME = /^\.(\d+)\.\d+\.[a-z0-9]+\.tmp$/

/**
 * Is the process that wrote this scratch file still running?
 *
 * WHY not `processLock.isPidRunning`, which is two files away and whose own
 * comment says "one definition keeps the two callers from disagreeing":
 * because the two callers want OPPOSITE defaults, and the reason is the
 * direction each one fails in.
 *
 * The lock treats "cannot ask" as NOT running, so an unanswerable pid never
 * blocks a new instance from starting. Being wrong there means one app refuses
 * to launch. Here, being wrong means DELETING a live writer's scratch file out
 * from under it, so anything we cannot ask about — EPERM from another user,
 * EACCES (which is what libuv reports for an access-denied `OpenProcess` on
 * Windows), or a pid the platform will not even parse — must read as ALIVE.
 * Only `ESRCH`, "no such process", is proof.
 *
 * Merging the two would make one of them wrong in its own worst direction, so
 * they stay apart deliberately rather than by oversight. `processLock` also
 * defeats pid REUSE with `ps -o lstart=`; that is worth an `execFileSync` for
 * a lock and not for every candidate on the startup path, and reuse here only
 * delays a cleanup.
 */
function writerIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Remove abandoned scratch files beside each of `files`.
 *
 * Best-effort throughout: a missing directory, an unreadable one and a failed
 * unlink all return quietly, because the file this would have removed is inert
 * either way and a sweep must never be the reason the app cannot start.
 */
export async function sweepAbandonedScratch(files: readonly string[]): Promise<void> {
  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    const directory = dirname(file)
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), basename(file)])
  }
  for (const [directory, prefixes] of byDirectory) {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      const prefix = prefixes.find(candidate => name.startsWith(candidate))
      if (!prefix) continue
      const match = SCRATCH_NAME.exec(name.slice(prefix.length))
      if (!match) continue
      if (writerIsAlive(Number(match[1]))) continue
      await unlink(join(directory, name)).catch(() => undefined)
    }
  }
}
