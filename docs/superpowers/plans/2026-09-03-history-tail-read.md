# Sessions: read only the transcript tail when loading history

## 2026-09-04 review correction

Cursor selection now uses an explicit one-time latch, not marker inequality.
Duplicate markers can name different byte positions; commit the first renderable
line's marker/offset pair even when the marker string is unchanged. Missing
positions clear the offset instead of carrying an unrelated old position.
Added renderer duplicate-marker/filtered-prefix coverage, invalid remote-offset
schema cases and real WebSocket pagination through duplicate UUIDs. Fifty-seven
focused tests and TypeScript pass; refreshed full CI passed on 621bff75.

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

**Older window — a position cursor.** Every chunk (initial and older)
returns `offsets`, the absolute byte offset of each returned record's line,
parallel to `entries`. The renderer's cursor is the marker of the chunk's
first kept line plus that line's offset, and the older-history request
carries both (`beforeMarker`, `beforeOffset`). With an offset the loader
verifies the line there carries the marker (one record read, plus the byte
before it must be a newline) and walks backward from exactly that byte for
`limit + 1` records: exact, O(page), no marker hunt. Without an offset — the
remote client, or a cursor the live-window trim re-anchored on an entry
whose position was never recorded — or when the check fails (rewritten
file, cursor from another transcript), it uses the ORIGINAL forward scan
anchored on the OLDEST occurrence of the marker, which parses from byte 0
to the anchor as before #747. The missing-marker fallback (page from the
tail) survives on that path.

Why not a backward marker hunt (the first revision of this PR): markers are
not unique. Real Claude transcripts on the reviewing machine held
contiguous blocks of 100–260 uuids repeated 200–530 records later with
different content, and Codex markers (timestamp + payload id, falling back
to `ts:type`) collide on same-millisecond records routinely. A hunt that
anchors on the NEWEST occurrence moves the renderer's cursor FORWARD by the
duplicate gap and, when the gap is at least the page size, cycles forever —
the feed re-requests near the top and `ViewPromptsModal` auto-pages, so
that is an unbounded IPC loop. The oldest-occurrence forward scan provably
terminates (the renderer's next cursor is a line this page returned, which
lies strictly before the anchor, so the anchor position strictly decreases)
but skips every record between two occurrences. The offset cursor is what
makes paging both exact and terminating; the forward scan remains only as
the terminating fallback.

Why per-entry `offsets` rather than one `oldestOffset`: the renderer's
cursor is the first KEPT line, and chunks frequently lead with records the
mapper drops (Codex `turn_context`/`session_meta`, Claude snapshots). An
offset for the first returned line would then fail the marker-at-offset
check on every such page and silently degrade to the slow scan. Numbers
only — ~2 KB per 200-record page.

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
- Bytes read and parsed for the window are proportional to the window's own
  size plus one block. The initial load's I/O is not independent of file
  size — `totalEntries` still costs one no-decode newline count over the
  head (17–32 ms hot on 84 MB; a full-file read cold) — its PARSE cost is.
- Paging with the offset cursor reaches every record exactly once and
  terminates; paging without it terminates.
- A read failure (missing file, file truncated under us) returns the same
  empty chunk the streaming reader returned.
- Interning stays per load, and only the returned entries are interned.

## Review follow-ups (applied)

- The position cursor above replaces the newest-occurrence marker hunt
  (blocker: livelock on duplicated markers).
- Byte offsets ride every chunk (`offsets`), the older request carries
  `beforeOffset` (preload, IPC, remote schema and wire types), and the
  renderer keeps `historyOldestOffset` next to `historyOldestMarker`,
  clearing it whenever the marker comes from a live burst or a trim.
- A record containing a raw U+2028/U+2029 is one line (readline split
  those; the old reader shredded 12 Codex records into 116 junk lines) —
  documented in `parseJsonlLine` and pinned by a test.
- No phantom empty line at EOF, `blockBytes` asserted positive, the newline
  count searches only the bytes a short read filled, only returned entries
  are interned.

## Not in scope

- Caching `totalEntries` or the tail across loads.
- The remote client's store adopting `offsets`/`beforeOffset` (it receives
  them; it still pages on the marker alone, i.e. the forward scan).
- Carrying byte offsets on live jsonl frames so a trim re-anchor keeps the
  exact cursor.
- The renderer's `INITIAL_HISTORY_CONCURRENCY` or its marker policy.
- `streamJsonl` itself; other forward-scanning callers keep using it.

## Verification

- New `historyLoader.test.ts` (unit project) with an oracle that mirrors the
  removed forward implementation (`streamJsonl` ring buffer / marker scan):
  equivalence on a small transcript and on a multi-MB one with records
  larger than a block and a multi-byte character straddling a block
  boundary; the window-larger-than-file case; empty and missing files;
  blank, malformed and unterminated lines; a raw U+2028 record kept whole;
  bytes read for the window proportional to the window; older pages
  anchored at several depths by marker and by offset, the first record, a
  missing marker, an offset that does not carry the marker (falls back), a
  mid-file offset reading only the page; the duplicated-marker livelock
  input paged to the head with the offset cursor (every record once) and
  without it (terminates, lossy as before).
- `npx tsc -b --pretty false`, `npx eslint` on the changed files, the
  sessions unit folder, and the remote-server system test that exercises
  `get-history` end to end.
- A throwaway bench on a generated ~80 MB transcript, old reader vs new.
