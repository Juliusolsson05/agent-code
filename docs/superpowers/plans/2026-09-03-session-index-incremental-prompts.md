# Sessions: read transcripts incrementally for the picker

Fixes #735. Refs #103, #93, #96.

## Problem

`sessionIndex.ts` extracts a transcript's user prompts by reading the whole
file, splitting it and parsing every line, cached by mtime. The picker lists
the ten most recently modified transcripts — the live sessions, whose mtime
moves every few seconds — so every open re-reads all of them from byte 0
(122 MB today) on the main thread to show four prompts each. Search does the
same for every transcript on disk (2,150 files) per query, and the cache
never evicts.

## Design

Both providers' transcripts are append-only, so a cache entry becomes a
parsed **byte range** `[parsedFrom, parsedTo)` plus the prompts folded from
it, keyed by file, with mtime and size for validation:

- **Growth** (size > parsedTo): read only `[parsedTo, size)`, fold complete
  lines, advance `parsedTo` to the last newline. A partial trailing line is
  left for next time.
- **Listing** (cache miss, needs K prompts): read the tail in a growing
  window (256 KiB, ×4) until K prompts are folded or the head is reached;
  `parsedFrom` records where parsing started. Codex keeps `cwd` in its
  `session_meta` at the head, so a tail read that finds no cwd reads the
  first 64 KiB for it once.
- **Search** (needs every prompt): extend backwards from `parsedFrom` to 0
  once; after that it is a growth read like listing.
- **Rewrite** (size < parsedTo, or mtime moved with size unchanged): full
  re-parse from 0.
- Adjacent-duplicate prompts are still collapsed, including across a chunk
  seam (the older occurrence wins, as before).
- The cache is an LRU of 512 entries.
- Search considers only the 500 most recently modified candidates. It is
  ranked by recency already and returns at most 20; scanning 2,150 files
  per keystroke bought nothing but freezes.

Behaviour that does not change: prompt filtering rules per provider, the
newest-first order and `promptsPerSession` slicing, cwd resolution, the
discovery walks.

## Verification

- New `sessionIndex.prompts.test.ts` against temp JSONL files: tail-first
  listing returns the newest K prompts without parsing from the head;
  growth folds only appended bytes and ignores a partial trailing line;
  search extends to the head once and is then incremental; a duplicate
  across a chunk seam is collapsed; Codex cwd comes from the head when the
  tail lacks it; a rewrite re-parses; the LRU evicts.
- `npx tsc -p tsconfig.node.json --noEmit`.
