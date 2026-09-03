# Sessions: read only the transcript tail when loading history

Fixes #747. Refs #87, #103, #93.

## Problem

`historyLoader.ts` produces the newest `limit` (120) records of a session's
transcript by streaming the WHOLE file through readline and `JSON.parse`,
keeping a ring buffer of the last `limit` entries and counting every line
for `totalEntries`. Restoring a workspace at boot runs this for every
resumed session: 25 initial loads read 252 MB in 10.7 s of main-thread
time; the worst — an 89.3 MB / 18,366-line rollout — took 4,618 ms to
return 120 entries (332 ms even hot from page cache). All of it lands in
the first 8 s of boot, where main's event-loop p99 hit 577 ms and nine
parallel provider spawns each showed 950–2,130 ms of non-provider time.

The older-history page (`readOlderTranscriptWindow`) has the same shape:
it forward-scans from byte 0 until it meets the renderer's anchor marker,
so the first page after the tail parses the whole file minus the tail, and
every further page parses nearly as much again.

## Design

One shared primitive, `readLinesBackward`, walks a file's lines newest
first: read a 256 KiB block ending at the current position, scan it
backwards for `\n` bytes, hand every complete line to a callback with its
absolute start offset, and carry the unterminated head of the block over
to the next (older) block. The callback returns `true` to stop, which is
what makes the read bounded: the loop never reads a block the consumer
did not need.

- **Line assembly across blocks** keeps the carried chunks in a list and
  concatenates once, when the line's leading newline is found. A single
  multi-MB record (a pasted image) therefore costs one pass over its bytes,
  not a re-concatenation per block.
- **Multi-byte UTF-8 at a block boundary** cannot be split incorrectly:
  `\n` (0x0A) never occurs inside a multi-byte sequence, so splitting on
  newline BYTES is always a character boundary, and a line is decoded only
  once it is complete, so a character straddling two blocks is reassembled
  before it is decoded.
- **Line semantics match the forward reader** (`streamJsonl`): blank lines
  are skipped without counting, an unparseable line counts as a parse error
  and is skipped, a trailing unterminated line is still a line (the provider
  mid-write case), `\r\n` is tolerated because `JSON.parse` accepts trailing
  whitespace. The returned window is therefore identical to the full parse:
  the same records, in file order, interned through the same per-load pool.

**Initial tail.** Parse newest-first until `limit + 1` records are found.
The extra record is not returned; its existence is what `hasMore` means
(at least one more usable record before the window), exactly as the full
parse computed it. `totalEntries` is the records parsed in the tail plus
the newline count of the untouched head `[0, tailStart)`, counted with a raw
byte scan in 1 MiB blocks — no decode, no parse. `tailStart` is the start
of the oldest parsed line, so the head consists of whole lines only.

The head count treats every line as a record, i.e. it does not detect blank
or malformed lines there. Provider-written transcripts only ever have a
partial line at the very END (mid-append), which sits inside the parsed
tail, so the count is exact for the files this loader reads; a hand-edited
file with junk in its head would be over-counted by the junk lines. That is
an accepted, documented deviation: `totalEntries` feeds a scroll-position
denominator and a "nothing on disk yet" check, and a full parse just to
make the denominator exact for corrupt files would be the bug reintroduced.

**Older window.** Walk newest-first hunting for the anchor marker; once it
is found keep collecting `limit + 1` older records and stop. The work is
proportional to the distance from EOF to the anchor — what the renderer
already holds in memory — instead of the distance from the head. While
hunting, the first `limit + 1` records seen (the file tail) are retained so
the historical fallback survives: an anchor that no longer exists in the
durable transcript (live-append race) still pages from the tail, with the
same `hasMore` the forward scan produced.

One deliberate difference: a marker that occurs twice anchors on its NEWEST
occurrence (the forward scan stopped at the oldest). The renderer's window
grows contiguously from the tail, so the newest occurrence is the one at
its edge; anchoring on the oldest could skip every record between the two.

Alternatives rejected:

- A growing single window (256 KiB, ×4) re-read from EOF, as the picker
  does. Simpler, but it re-reads and re-splits the already-seen tail on every
  widening and cannot express "stop after N records" without re-parsing.
  The picker needs a handful of prompts; history needs 121 or 201 exact
  records and an exact anchor search, which the callback shape gives
  directly.
- Estimating `totalEntries` from average bytes per record. Cheaper still,
  but the renderer's contract is "how many records are on disk", never
  decremented, and an estimate that drifts by hundreds would turn the
  scroll indicator into a lie. The raw newline scan is off-main-thread I/O
  plus a memchr-speed loop; it is the same bytes today's code already reads
  and parses.
- A byte-offset cursor in the IPC contract instead of a marker. It would make
  older pages O(page), but it changes the preload/remote wire shape and the
  renderer's marker policy; not needed to fix the boot cost.

Invariants that must hold:

- The returned window equals the full parse's window (same records, same
  order, same `hasMore`) for every file, including ones with blank lines,
  malformed lines, an unterminated last line, and records larger than the
  block size.
- Bytes read and parsed for the window are bounded by the window's own size
  plus one block, independent of file size.
- A read failure (missing file, file truncated under us) returns the same
  empty chunk the streaming reader returned.
- Interning stays per load, and only the returned entries are interned.

## Not in scope

- Caching `totalEntries` or the tail across loads.
- Changing the IPC/remote wire shape (`beforeMarker`, `limit`, `totalEntries`).
- The renderer's `INITIAL_HISTORY_CONCURRENCY` or its marker policy.
- `streamJsonl` itself; other forward-scanning callers keep using it.

## Verification

- New `historyLoader.test.ts` (unit project) with an oracle that mirrors the
  removed forward implementation (`streamJsonl` ring buffer / marker scan):
  equivalence on a small transcript and on a multi-MB one with records
  larger than a block and a multi-byte character straddling a block
  boundary; the window-larger-than-file case; empty and missing files;
  blank, malformed and unterminated lines; bytes read for the window bounded
  independent of file size; older pages anchored at several depths, the
  first record, and a missing marker.
- `npx tsc -b --pretty false`, `npx eslint` on the changed files, the
  sessions unit folder, and the remote-server system test that exercises
  `get-history` end to end.
- A throwaway bench on a generated ~80 MB transcript, old reader vs new.
