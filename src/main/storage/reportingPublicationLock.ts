/**
 * One process-wide lock shared by the two writers whose interleaving can
 * delete a goal a pane still shows (#1328, steering q56).
 *
 * The TLDR/Goal stores never evict an identity the persisted workspace names.
 * But the workspace file and the stores have separate write queues: a
 * workspace save could publish a parked pane naming identity X while a store
 * was mid-way through a write that deletes X's record (chosen when nothing
 * named it). Holding this lock across the store's whole eviction (read who is
 * named, choose, write, rename) and across the workspace save (write, rename,
 * advance the in-memory document the stores read) makes those two atomic
 * with respect to each other. A save that names X after the eviction chose X
 * waits for that write to land; it never overlaps it.
 *
 * WHY a module and not a method on either store: neither owns the other, and
 * the stores are built before the workspace file opens. Lock order is always
 * "own queue, then this lock", and neither side waits on the other's queue
 * while holding it, so there is no deadlock.
 *
 * Only evicting store writes take it (a new identity at the cap), so ordinary
 * TLDR and Goal updates never wait on a workspace save.
 */
let tail: Promise<unknown> = Promise.resolve()

export function withReportingPublicationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation)
  tail = result.catch(() => undefined)
  return result
}
