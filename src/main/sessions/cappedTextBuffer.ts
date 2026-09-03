// Bounded text replay buffer for PTY output (#726).
//
// WHY a chunk list and not a string: SessionManager keeps the last N KiB of
// every session's PTY output so a terminal that attaches later can replay
// the current screen. The previous implementation stored one string per
// session and appended with `prev + data` → `charCodeAt` → `slice`. That is
// three problems in one line once the buffer is full (minutes into any agent
// session, because TUIs repaint the whole screen):
//
//   1. `prev + data` is a ConsString; the `charCodeAt` needed for the
//      surrogate check flattens it into a fresh (cap + chunk) copy. Every
//      chunk from every session therefore copied the whole cap on the main
//      thread — with 20 sessions repainting, on the order of 100 MB/s of
//      short-lived allocation, i.e. the #390 GC-storm shape.
//   2. `slice` returns a V8 SlicedString that keeps that flattened parent
//      alive, so the retained buffer was cap + chunk, not cap.
//   3. A chunk larger than the cap became the parent of the stored slice and
//      was retained in full: the 2026-09-03 heap snapshot holds six identical
//      1.8 MB docker-build repaints and ~10 identical 1 MB Claude screen
//      frames for exactly this reason (#321 is the same lesson elsewhere).
//
// A list of pieces fixes all three: append is amortised O(chunk), dropping
// whole oldest pieces never copies retained bytes and can never split a
// surrogate pair (PTY chunks arrive as already-decoded strings and pieces
// are cut on surrogate-safe boundaries), and the only O(cap) operation —
// the join — runs on attach, which is rare.
//
// WHY large chunks are split into pieces: eviction is whole-piece, so the
// piece size is the granularity of what an overflow discards. Storing a
// near-cap chunk as one piece would make the very next small append throw
// away the whole replay. Pieces are cut as forced flat copies (the utf16le
// Buffer round-trip is this codebase's established idiom, see
// src/main/subagents/shared.ts) so no piece keeps a large parent alive.

const DEFAULT_MIN_PIECE = 4096

export class CappedTextBuffer {
  private pieces: string[] = []
  // Index of the oldest live piece. Dropped pieces are blanked in place and
  // the array is compacted lazily, so a drop is O(1) instead of an O(n)
  // `shift` on every full-buffer append.
  private head = 0
  private live = 0
  readonly pieceSize: number

  constructor(readonly cap: number, pieceSize?: number) {
    if (!(cap > 0)) throw new RangeError(`CappedTextBuffer cap must be positive, got ${cap}`)
    // A sixteenth of the cap bounds overflow loss to ~6% of the replay, with
    // a floor so small caps (tests, tiny terminals) do not shred every chunk.
    this.pieceSize = pieceSize ?? Math.max(DEFAULT_MIN_PIECE, cap >> 4)
    if (!(this.pieceSize > 0)) throw new RangeError(`CappedTextBuffer pieceSize must be positive`)
  }

  /** Total retained code units. Never exceeds `cap`. */
  get length(): number {
    return this.live
  }

  append(chunk: string): void {
    if (chunk.length === 0) return
    if (chunk.length > this.cap) {
      // The new chunk alone overflows the cap: everything older is gone by
      // definition, and the chunk itself must not be retained in full.
      chunk = flatTail(chunk, this.cap)
      this.pieces = []
      this.head = 0
      this.live = 0
    }
    if (chunk.length <= this.pieceSize) {
      this.push(chunk)
    } else {
      for (const piece of cutPieces(chunk, this.pieceSize)) this.push(piece)
    }
    // Compact once the dead prefix dominates so the array stays O(live
    // pieces) rather than O(pieces ever appended). The threshold keeps the
    // compaction amortised: at most one O(n) slice per n/2 drops.
    if (this.head >= 64 && this.head * 2 >= this.pieces.length) {
      this.pieces = this.pieces.slice(this.head)
      this.head = 0
    }
  }

  /** The retained tail as one string, oldest bytes first. */
  read(): string {
    if (this.live === 0) return ''
    const livePieces = this.head === 0 ? this.pieces : this.pieces.slice(this.head)
    return livePieces.length === 1 ? livePieces[0]! : livePieces.join('')
  }

  private push(piece: string): void {
    this.pieces.push(piece)
    this.live += piece.length
    // Every pushed piece is at most `cap` long (oversized chunks were cut to
    // the cap above), so this loop stops before reaching it: the newest
    // piece is never dropped.
    while (this.live > this.cap) {
      const dropped = this.pieces[this.head]!
      this.pieces[this.head] = ''
      this.head += 1
      this.live -= dropped.length
    }
  }
}

// Last `cap` code units of `chunk` as a flat copy, never starting on a low
// surrogate — the old string implementation made the same cut, for the same
// reason: a replay buffer must not introduce a replacement character at its
// oldest edge when dropping one more code unit costs nothing.
function flatTail(chunk: string, cap: number): string {
  return flatCopy(chunk, surrogateSafeStart(chunk, chunk.length - cap), chunk.length)
}

// Cut `chunk` into flat pieces of at most `size` code units on surrogate-safe
// boundaries. Each piece is a real copy so none of them keeps `chunk` alive.
function cutPieces(chunk: string, size: number): string[] {
  const pieces: string[] = []
  let start = 0
  while (start < chunk.length) {
    let end = Math.min(chunk.length, start + size)
    // Never end a piece on a high surrogate: pull the pair into the next
    // piece so no piece boundary splits a code point.
    if (end < chunk.length) {
      const code = chunk.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    if (end <= start) end = Math.min(chunk.length, start + size)
    pieces.push(flatCopy(chunk, start, end))
    start = end
  }
  return pieces
}

function surrogateSafeStart(chunk: string, start: number): number {
  const code = chunk.charCodeAt(start)
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start
}

// WHY the Buffer round-trip: `chunk.slice(a, b)` is a V8 SlicedString that
// keeps the whole source alive (#321). Round-tripping through a utf16le
// Buffer forces a flat copy of just the range, and utf16le preserves every
// code unit — including lone surrogates — unchanged.
function flatCopy(chunk: string, start: number, end: number): string {
  return Buffer.from(chunk.slice(start, end), 'utf16le').toString('utf16le')
}
