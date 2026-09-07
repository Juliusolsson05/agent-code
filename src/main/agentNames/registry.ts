import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

import { agentNameAt, normalizeAgentName } from '@shared/agentNames/names.js'

// WHY `nextIndex` is persisted rather than derived from the assignment count:
// deriving it would recycle a name the moment an assignment is ever removed,
// and "never recycle a spoken address" is the invariant that makes a delayed
// voice request safe. The counter only ever moves forward.
//
// WHY this schema validates but does NOT supply the assignment map: zod's
// `z.record()` silently drops a "__proto__" key (verified against zod ^4.4.3 —
// JSON.parse keeps it as an own property, zod's output does not). Reading the
// map out of zod's result would therefore forget any assignment stored under
// that identity on the next launch and re-allocate a second name for the same
// agent. Identities come from a workspace file the user can edit, so that is
// reachable, not theoretical. The schema is the SHAPE gate; `load()` takes the
// data from the raw parsed JSON.
//
// The duplicate-name check lives in `load()` for the same reason: run here it
// would inspect the map zod already pruned and miss exactly the entry that
// motivated all of this. So does the per-value check — the `z.string().trim()
// .min(1).max(100)` below is real for every ordinary key and a no-op for
// "__proto__", so `load()` restates it over the raw entries.
const stateSchema = z.object({
  version: z.literal(1),
  nextIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1_000_000),
  assignments: z.record(z.string(), z.string().trim().min(1).max(100)),
}).strict()

type RegistryState = { version: 1; nextIndex: number; assignments: Record<string, string> }

// WHY a null-prototype map instead of a plain object: identities are opaque
// strings that originate in a workspace file the user can edit. Writing
// `assignments['__proto__'] = name` on a normal object invokes the prototype
// SETTER — the assignment silently vanishes and the next call allocates a
// second name for the same identity, forever. A null-prototype map makes every
// key an ordinary data property, and also makes `assignments[identity]` safe to
// read without an Object.hasOwn dance.
function emptyAssignments(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function adoptAssignments(source: Record<string, string>): Record<string, string> {
  return Object.assign(emptyAssignments(), source)
}

/**
 * The single process-wide allocator of spoken agent names.
 *
 * WHY this lives in main and not in the renderer: a renderer-local counter
 * gives two windows the same "Apollo", and a name derived at render time
 * changes when an agent is closed or the list is re-sorted. There is exactly
 * one of these per application process, constructed by the IPC adapter, and
 * nothing else may import it — the decomposition keeps MCP and feature code
 * away from application identity on purpose.
 *
 * WHY the renderer, not this class, decides which agent keeps an identity
 * across a provider switch: only the renderer knows that a new local session ID
 * is the same logical pane. This module owns exactly one relation, identity to
 * name, and has no opinion about sessions, windows, panes or the setting.
 */
export class AgentNameRegistry {
  private state: RegistryState | undefined

  // WHY one promise tail rather than a mutex or a per-identity lock: every
  // allocation reads the whole counter and writes the whole file, so the
  // critical section is the entire operation. Two windows starting agents in
  // the same frame is the ordinary case, not the edge case, and interleaving
  // them is how both get told "Apollo".
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  resolve(identities: readonly string[]): Promise<Record<string, string>> {
    const next = this.tail.then(() => this.allocate(identities))
    // Swallow on the TAIL only. The caller still sees the rejection through
    // `next`; the tail must stay resolvable or one disk failure would wedge
    // every later request behind a permanently rejected promise.
    this.tail = next.catch(() => {})
    return next
  }

  private async load(): Promise<RegistryState> {
    if (this.state) return this.state

    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A permission or I/O error is NOT an empty registry. Starting fresh
        // here would hand out names that a readable file already owns.
        throw new Error('Agent name registry is unreadable; refusing to overwrite it', { cause: error })
      }
      this.state = { version: 1, nextIndex: 0, assignments: emptyAssignments() }
      return this.state
    }

    let assignments: Record<string, string>
    let nextIndex: number
    try {
      const json: unknown = JSON.parse(raw)
      // Validate through zod, then deliberately IGNORE its copy of the map and
      // read the raw object instead — see the schema comment for why.
      nextIndex = stateSchema.parse(json).nextIndex
      assignments = adoptAssignments((json as { assignments: Record<string, string> }).assignments)
      // Re-check every VALUE here, because the schema above could not see them
      // all. zod skips a "__proto__" key entirely, so the value check it
      // declares never runs for exactly the key we went to the raw JSON to
      // recover. Measured against the pinned zod (4.4.3), all three of these
      // parse clean:
      //
      //   {"assignments":{"__proto__":123}}                 -> number
      //   {"assignments":{"__proto__":""}}                  -> empty string
      //   {"assignments":{"__proto__":"<140 chars>"}}       -> over-length
      //
      // Left unchecked, each fails differently and none of them fail well: a
      // number would blow up later inside normalizeAgentName as an incidental
      // TypeError rather than a decision; an empty string would be adopted,
      // satisfy `!== undefined` in allocate(), and make that identity
      // permanently unnameable — recorded as assigned while rendering nothing;
      // an over-length string would reach the badge. All three are corruption,
      // and this module answers corruption exactly one way.
      for (const [identity, name] of Object.entries(assignments)) {
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
          throw new Error(`Assignment for ${identity} is not a usable name`)
        }
      }
      // The duplicate check the schema cannot do either, over every key
      // including the ones zod pruned. A file mapping two identities to one
      // name makes every later lookup ambiguous with no evidence for choosing
      // between them.
      const spoken = Object.values(assignments).map(normalizeAgentName)
      if (new Set(spoken).size !== spoken.length) throw new Error('Two identities share one spoken name')
    } catch (error) {
      // WHY this is not cached and not repaired: leaving `this.state` unset
      // means every later call re-reads and re-fails, so the user gets a
      // consistent refusal instead of a registry that silently forgot every
      // assignment. Repairing would mean choosing which of two colliding
      // identities keeps the name, and there is no evidence with which to
      // choose. The fix belongs to the user's file, not to this process.
      throw new Error('Agent name registry is unreadable; refusing to overwrite it', { cause: error })
    }

    this.state = { version: 1, nextIndex, assignments }
    return this.state
  }

  private async allocate(identities: readonly string[]): Promise<Record<string, string>> {
    const loaded = await this.load()
    // Work on a copy so a failed commit leaves the cached state untouched. If
    // we mutated in place, a write error would leave this process believing it
    // had published names that are not on disk.
    const draft: RegistryState = { ...loaded, assignments: adoptAssignments(loaded.assignments) }
    const used = new Set(Object.values(draft.assignments).map(normalizeAgentName))
    let changed = false

    for (const identity of identities) {
      if (draft.assignments[identity] !== undefined) continue
      let name = agentNameAt(draft.nextIndex++)
      // The counter alone cannot guarantee freshness: a user could have
      // hand-written "Apollo" into the file at a lower index. Skipping forward
      // is cheap and keeps the never-duplicate invariant local to this loop.
      while (used.has(normalizeAgentName(name))) name = agentNameAt(draft.nextIndex++)
      draft.assignments[identity] = name
      used.add(normalizeAgentName(name))
      changed = true
    }

    if (changed) await this.commit(draft)
    return Object.fromEntries(identities.map(identity => [identity, draft.assignments[identity]]))
  }

  private async commit(draft: RegistryState): Promise<void> {
    // 0o700/0o600: the file records which agents exist and what they are
    // called. It is not a secret, but it is this user's workspace shape and has
    // no reason to be world-readable.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    // WHY a UUID temp name rather than a fixed `.tmp` sibling: two commits can
    // overlap across an unclean shutdown, and a shared scratch path turns that
    // into an ENOENT race on rename. The unique name also means cleanup never
    // has to scan for siblings.
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({
        version: draft.version,
        nextIndex: draft.nextIndex,
        assignments: { ...draft.assignments },
      }), { mode: 0o600 })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    // Only after a successful rename. A failed persistence must not poison the
    // cache with names that were never reserved.
    this.state = draft
  }
}
