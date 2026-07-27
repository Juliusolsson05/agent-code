# Image reads must never render as a base64 dump (Claude + Codex)

**Status:** proposed — **revised 2026-07-27 after a captured artifact contradicted the first
draft.** Awaiting approval before any implementation.
**Date:** 2026-07-27 (rev 2)
**Bug statement (user report):** "Do not show base64 dump for image reads, agent code, codex."
Followed by a screenshot of the live feed and the steer: **"codex is the problem."**

---

## Evidence: the captured artifact

The user supplied a screenshot of the defect in the running feed. The exact session was
located in the corpus and its structure read (structure and lengths only, no payload bytes):

**`~/.codex/sessions/2026/07/23/rollout-2026-07-23T19-31-13-019f9008-09b5-7793-8222-307a8700791a.jsonl`**

This artifact **invalidated three claims in rev 1**, which is exactly why the recorder stage
exists. Rev 1 was written from a corpus-wide census and was wrong about the carrier, wrong
about the recognizer's shape, and silent about the property that matters most.

### What the record actually says

```
L50  payload.type=custom_tool_call   name=exec
L51  payload.type=custom_tool_call_output
     [0] input_text   47 chars   "Script completed\nWall time 0.0 seconds\nOutput:\n"
     [1] input_text   49 chars   "/tmp/hamngatan-review.T1XcgE/drawings-contact.jpg"
     [2] input_image  555,027 chars   mime=image/jpeg  detail="high"
     [3] input_text   47 chars   "/tmp/hamngatan-review.T1XcgE/photos-contact.jpg"
     [4] input_image  516,147 chars   mime=image/jpeg  detail="high"

L68  payload.type=custom_tool_call_output   (call=exec, declared L67)
     [0] input_text   47 chars   "Script completed…"
     [1] input_text   99 chars   ".../photos/skandiahuset/Fotou.nr_…"
     [2] input_image  279,883 chars   image/jpeg   detail="high"
     [3] input_text   95 chars   ".../photos/skandiahuset/GhmPK_100…"
     [4] input_image  351,791 chars   image/jpeg   detail="high"
     [5] input_text  111 chars   ".../vision-material/vision-th…"
     [6] input_image  1,777,026 chars  image/png    detail="high"
```

### The three corrections

**C1 — The carrier is `custom_tool_call_output` from the `exec` tool, not `view_image`.**
Rev 1 named `rollout.ts:393` (`function_call_output`) as the primary path and treated
`view_image` as the trigger. Wrong. Every image in this session arrives through
`payload.type === 'custom_tool_call_output'` — **`rollout.ts:400-404`** — produced by Codex's
`exec` shell tool. `view_image` appeared 6 times in one file across the entire 1,581-session
corpus; `exec` is the dominant carrier by a wide margin. A fix aimed at `view_image` would
not have touched the reported bug at all.

**C2 — The output array is heterogeneous and interleaved, and the interleaving is the
meaning.** Look at L68: `text(path), image, text(path), image, text(path), image`. **The
`input_text` items are the filenames labelling each image.** Rev 1's recognizer signature —
`recognizeImageAttachment(node): ImageAttachment | null`, one image per result — cannot
express this. Flattening to one string and then "removing the base64" would destroy the
pairing and leave three orphan paths above three unlabelled images. The correct output is an
**ordered list of parts**, preserving position.

**C3 — Multiple images per single tool result, and the sizes are worse than rev 1 claimed.**
L68 alone carries **2,408,700 characters of base64 in one feed row**, across three images.
Rev 1's "worst recorded case: 5,158,766" was a corpus maximum quoted without noting that a
*single row* routinely carries megabytes across several parts.

**Answered unknown:** `detail` is present on every observed `input_image` and its value is
consistently `"high"`. It is a request-side vision-fidelity hint, not a presentation
directive. The recognizer should carry it through as metadata and no painter should branch
on it.

**Scope narrowed per the user's steer.** Codex is the target. The Claude and `_atp` shapes
stay in this document because they are recorded fact and the recognizer must not be built in
a way that excludes them, but they move behind Codex in the implementation order.

---

**Original bug statement:** When an agent reads an image — Claude's `Read` on a `.png`,
Codex's `exec` emitting images, a shell command that produces one — Agent Code paints the
base64 payload as text instead of showing the image.

This document is the required artifact of the staged-decomposition method. No
implementation code may be written until it is approved. If a later stage proves this
decomposition wrong, this document gets revised — the implementation does not get patched
forward.

---

## Applicability check

The skill applies. Both gates are met:

- **Size.** `src/` is ~200k LOC across 1,122 TS/TSX files. Well past the 35k threshold.
- **Not surface-level.** The census below found **eight structurally distinct image-bearing
  shapes** across **three transcript planes**, **two providers**, and a **cross-provider
  carriage layer** (`_atp.source`) that re-introduces Claude's shapes inside Codex rollouts.
  Nobody had enumerated them. The existing flatteners are text-only *by construction* and
  are called from **seven independent consumers** — the exact "distributed decision, patch
  each consumer" shape the method exists to prevent.

---

## A — what exists and is trusted

Everything in this section was verified by direct read of the code and by scanning the real
on-disk corpora (1,912 Claude transcripts under `~/.claude/projects`, 1,581 Codex rollouts
under `~/.codex/sessions`) on 2026-07-27.

### A.1 The media protocol works and is trusted

`src/providers/shared/renderer/protocols/media/base64.ts:41-74` is a small, correct,
well-commented module:

- `parseBase64MediaPreview(kind, mimeType, data)` — MIME allowlist (5 image types, 8 audio),
  8 MiB decoded cap, returns `null` on anything unrecognized.
- `base64MediaDataUrl(model)` — deliberately **separate** from admission, because
  concatenating the data URL copies the whole payload. Called only after a disclosure opens.
- `Base64MediaView` — the disclosure-gated painter.

This is the destination. Nothing about it needs to change.

### A.2 One provider already routes correctly — and proves the pattern

Codex's `image_generation` tool is handled end to end:
`src/providers/codex/renderer/transcript/entries.ts:123-161` maps the wire item into a
**provider-neutral `image` content block** (`{type:'image', source:{type:'base64',
media_type:'image/png', data}}`), and `Block.tsx:208` routes `case 'image'` to
`ImageBlockRow` → `Base64MediaView`. Its own comment states the intent explicitly:

> "It also prevents generic JSON rendering from ever trying to pretty-print megabytes of
> base64."

**That comment describes exactly the bug this document is about, for every path that was
not `image_generation`.** The substrate is right; it is reached by one shape out of eight.

### A.3 The message-content plane is handled

`ImageBlockRow` (`src/renderer/src/features/feed/ui/rows/ImageBlockRow.tsx:17-60`) handles
`image` blocks in message content — pasted user attachments and generated assistant images —
and falls back to a `LazyJsonDisclosure` for unsupported envelopes. Evidence scope agrees:
`observationScope.isNativeImageBlock` (`src/renderer/src/rendering/evidence/observationScope.ts:38-60`)
recognizes both the `media_type` and `mimeType` spellings for this plane.

### A.4 The shape-catalog machinery exists

`src/providers/registry.renderShapes.ts` aggregates per-provider `RenderShapeDefinition`
catalogs, with `shapes.coverage.test.ts` and `npm run rendering-shapes:audit` over them.
Stage C attaches to this, rather than inventing a parallel catalog.

### A.5 Fixture corpora and the redaction gate exist

`testing/fixtures/rendering-bundles/` (48+) and `rendering-recordings/`, extracted by
`scripts/extract-rendering-recordings.mjs` through the canonical redactor
(`src/renderer/src/rendering/replay/redact.ts`). **Important limitation confirmed by read:**
the redactor is **key-based** (`SENSITIVE_KEY`, `rendering/model/sensitiveKey.ts`). It does
not inspect, cap, or scrub base64 payloads. See Open Question 1.

---

## The defect, stated precisely

Not "images render badly." Three distinct failures with different mechanisms:

### D1 — Codex: unbounded base64 stringified into feed text

`src/providers/codex/renderer/transcript/entries.ts:62-74`:

```ts
export function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map(item => {
      if (typeof item === 'string') return item
      const rec = item as Record<string, unknown>
      return typeof rec.text === 'string' ? rec.text : JSON.stringify(item, null, 2)  // ← line 69
    }).join('\n')
  }
  return JSON.stringify(output ?? '', null, 2)
}
```

An `exec` image part is `{type:'input_image', detail:'high', image_url:'data:image/jpeg;base64,…'}`.
It has no `.text`, so **line 69 stringifies the entire data URL with no bound at all**, and
`.join('\n')` splices that multi-megabyte string in between the surrounding text parts.

**The live path for the reported bug is `rollout.ts:400-404` (`custom_tool_call_output`),**
confirmed against the captured session above. `:393` (`function_call_output`) and `:534`
(`tool_search_output`) reach the same flattener and must be fixed with it, but they are not
what fired here.

**Recorded worst case: 2,408,700 characters in a single feed row** (session above, L68,
three images in one result); largest single image 1,777,026 chars. This is not cosmetic — it
is a multi-megabyte string minted per render pass, on a plane the ledger re-derives every
tick.

**And the flattening destroys structure, not just size.** The array is
`text(path), image, text(path), image, text(path), image` — the text parts *label* the
images. Any fix that strips or truncates the base64 while keeping the string flattener
leaves three orphaned file paths and three unlabelled images. Position is meaning here.

### D2 — Claude: a 512-character base64 fragment painted as JSON

Claude's image read arrives as a `tool_result` whose content array holds
`{type:'image', source:{type:'base64', media_type:'image/png', data:'…'}}`.
`Block.tsx:258-267` routes `tool_result` → `ToolResultRow` → `toolResultContentText`
(`ToolResultRow.tsx:92`). That flattener
(`src/providers/shared/renderer/rows/toolResultContent.ts:16-21`) has no image case, so it
falls to `boundedJsonPreview`, which clamps strings at 512 chars
(`src/renderer/src/lib/text/boundedJson.ts:5`).

Result: the user sees `{"type":"image","source":{"type":"base64","media_type":"image/png",
"data":"iVBORw0KGgo…512 chars of garbage…"}}`. Bounded, so not a performance incident —
but it is precisely the "base64 dump" in the report, and **no image is ever shown.**

`src/providers/claude/renderer/shapes.ts` contains **zero** image handling (verified by grep).

### D3 — Codex user attachments are silently dropped

`rollout.ts:117-131` maps message content and accepts only `input_text`, `output_text`,
`refusal`. Every other block — including `input_image` — hits `return null` and is filtered
out. A user who attaches an image to a Codex prompt sees nothing at all. This is the
*vanish* failure shape, not the dump shape, and it lives in the same mapper.

### D4 — A second source of truth exists and is entirely unused

Claude writes a structured sidecar alongside the tool result:
`toolUseResult.file = {base64, dimensions, originalSize, type:'image/png'}`. Confirmed in
the corpus (47 occurrences). **`toolUseResult` is referenced nowhere in `src/renderer`,
`src/providers`, or `src/shared`** (verified by grep). So the exact metadata a good image
chip wants — dimensions, original size — is on disk, unread, while the renderer paints the
payload as text.

### Why this is not "add an `if` to each flattener"

`toolResultContentText` has **7 production call sites** (`ToolResultRow.tsx`,
`codex/adapters/embeddedOperation.ts` ×2, `codex/rows/dispatch.tsx`,
`codex/components/tool-result/index.tsx`, `codex/adapters/command.ts` ×2,
`opencode/adapters/git.ts`). `codexOutputText` has 4. Both return `string`. **A `string`
return type cannot express "part of this result is an image."** Every consumer that wants
to show the image must therefore re-parse the original `block.content` itself — which is
seven independent places each deciding what an image is. That is the reconciliation-in-the-
consumers failure the method names directly, and it is how the next three bugs get written.

The fix is to decide **once, before flattening,** at the transcript-mapping boundary.

---

## D — the end state, in observable behaviour

1. No base64 text appears in the feed for an image read, on any plane, for either provider.
   Not truncated base64. Not 512 characters of it.
2. An image read renders as the same bounded, disclosure-gated media chip already used for
   pasted images and `image_generation` — with filename, MIME, and (where the provider
   supplied it) dimensions and original size.
2b. **Interleaving is preserved.** A result of `text, image, text, image` renders as four
   parts in that order, each image still adjacent to the text that labels it. This is a
   first-class acceptance criterion, not a nicety — it is the property a
   strip-the-base64-from-the-string fix would silently destroy (correction C2).
3. An image envelope we do **not** recognize renders as a labelled, inspectable placeholder
   behind `LazyJsonDisclosure` — never raw payload, never silently dropped (D3's failure
   mode must not be the fix for D1's).
4. Codex `input_image` attachments in user messages render as images.
5. Cross-provider: a session switched Claude→Codex or back keeps rendering its images,
   because the `_atp.source`-carried shapes are in the catalog.
6. A regression test makes it *impossible* for a new base64-bearing shape to reach feed text
   without failing CI.

---

## Stages

### Stage B — Census recorder *(produces nothing visible; do not skip)*

| Field | |
|---|---|
| **Produces** | `scripts/extract-image-shapes.mts` + `docs/decomposition/evidence/image-reads/shape-census.md` — every distinct image-bearing node shape found in the real corpora, with occurrence counts, file counts, max payload size, provider, plane, and JSON path. |
| **Verified by** | Re-running the script on the same corpora reproduces the same census. Each catalogued shape cites at least one real source file and line. Verification needs no renderer code and no later stage. |
| **Why separate** | If the recognizer is written first, it will recognize the shapes that were in context — the `input_image` and `tool_result/image` ones — and silently omit the six others. That omission is invisible: unrecognized shapes fall through to today's dump, which looks like "not fixed yet" rather than "we never looked." The census is the only artifact that makes the omission *countable*. |
| **Reality check** | 1,912 Claude transcripts + 1,581 Codex rollouts already on disk. A read-only prototype of this scan has already been run (see below) and found shapes I would not have guessed. |

**Prototype census already run** (read-only, scratchpad, structure-only output — no payload
bytes printed). This is the evidence this whole document rests on, and it is why Stage B is
first:

| Provider | Plane | Shape | Occurrences | Files | Max payload |
|---|---|---|---|---|---|
| Codex | `response_item.payload.output[]` | `{type:'input_image', detail, image_url:'data:image/jpeg;…'}` | 52 | 3 | 807,303 |
| Codex | `response_item.payload.output[]` | `{type:'input_image', detail, image_url:'data:image/png;…'}` | 25 | 6 | **5,158,766** |
| Codex | `response_item.payload.content[]` | `{type:'input_image', image_url}` (user attachment) | 4 | 2 | 278,226 |
| Codex | `payload{type:'function_call'}` | `name='view_image'` | 6 | 1 | — |
| Claude | `tool_result.content[]` | `{type:'image', source:{type:'base64', media_type:'image/png'}}` | 49 | 5 | 296,628 |
| Claude | `tool_result.content[]` | `…media_type:'image/jpeg'` | 32 | 5 | 682,568 |
| Claude | `toolUseResult.file` | `{base64, dimensions, originalSize, type:'image/png'\|'image/jpeg'}` | 47 | 4 | 557,800 |
| Claude | `message.content[]` | `{type:'image', source:{type:'base64'}}` (already handled) | 20 | 16 | 429,892 |
| **Cross** | `_atp.source.message.content[]` | Claude `image` block inside a **Codex** rollout | 23 | 14 | 562,784 |
| **Cross** | `_atp.source.message.content[].content[]` | Claude image nested in tool_result, in a Codex rollout | 16 | 6 | 656,668 |
| **Cross** | `_atp.source.toolUseResult.file` | Claude sidecar carried into a Codex rollout | 14 | 4 | 656,668 |
| **Cross** | `_atp.source.toolUseResult[]` | array-form variant | 2 | 2 | 86,772 |
| **Cross** | `atp_passthrough._atp.source.attachment.prompt[]` | attachment carriage | 1 | 1 | 627,680 |

The five `_atp.source` rows are the ones I would have missed. Provider switching — Agent
Code's headline feature — **multiplies the shape count**, because a Claude image read that
survives a switch to Codex is still Claude-shaped inside a Codex rollout. Any fix scoped to
"Codex shapes in Codex files" is wrong on 56 recorded occurrences across 27 files.

Stage B must also settle the **frequency question the prototype leaves open**: image reads
are concentrated (5 Claude files, 9 Codex files). Stage B records whether that is because
images are rare, or because the sessions that use them use them heavily — it changes nothing
about correctness but it determines whether this is a papercut or a load-bearing path.

### Stage C — Fixture extraction

| Field | |
|---|---|
| **Produces** | `testing/fixtures/image-reads/` — one checked-in fixture per census shape, extracted verbatim from a real transcript through the canonical redactor, plus a `MANIFEST.md` mapping fixture → census row → source session. |
| **Verified by** | Every census row has a fixture or an explicit written reason it has none. `npm run test:contract` and the sensitive-value audit pass over the new directory. The fixtures parse as the same shape the census recorded. |
| **Why separate** | Extraction is where the payload-handling policy (Open Question 1) gets decided and applied uniformly. Merged into implementation, that policy gets decided per-fixture by whoever is writing the test at the time, and the corpus becomes inconsistent — some fixtures carrying real 5 MB screenshots into git, others not. |
| **Reality check** | Extracted from the exact sessions the census names. No hand-written literals. |

### Stage D — The failing tests

| Field | |
|---|---|
| **Produces** | `imageAttachment.test.ts` — one assertion per Stage C fixture, written **against the fixtures, before any recognizer exists.** Plus the negative property: *no output of the flattening path contains a run of ≥200 base64 characters.* |
| **Verified by** | **Every test fails, and fails for the stated reason.** A test that passes before the recognizer exists is testing nothing and must be rewritten. |
| **Why separate** | This is the step that makes the difference between real TDD and tests that bless the implementation. Written after the recognizer, they would assert whatever the recognizer happens to do. Written now, they assert what the *fixtures* say reality is. |
| **Reality check** | Fixtures from Stage C only. |

**Human judgement required before this stage — see Open Questions 2 and 3.** I will not
invent the semantics for "which source wins" or "what an unrecognized envelope should look
like," because inventing them means writing tests that bless the invention.

### Stage E — The recognizer *(the isolated hard part)*

| Field | |
|---|---|
| **Produces** | `src/providers/shared/renderer/protocols/media/imageAttachment.ts` — a pure function `recognizeResultParts(content: unknown): ResultPart[]`, where `ResultPart = {kind:'text', text} \| {kind:'image', mimeType, data, detail?, dimensions?, originalSize?, filePath?, origin}`. **An ordered list, not a single object** — see correction C2. Order is preserved verbatim from the wire; the recognizer never reorders, merges, or drops a part. No React, no provider imports, no DOM. |
| **Verified by** | Stage D's suite goes green **without any test being weakened, skipped, or deleted.** The module is verifiable with no renderer, no feed, and no provider mounted. |
| **Why separate** | This is the reconciliation layer. Claude gives the same image twice (tool_result block *and* `toolUseResult.file` sidecar, D4); Codex gives it as a data URL; `_atp` carriage gives Claude's shape in Codex's file. If each consumer reconciles for itself, they disagree — and the resulting duplicate/vanish/reorder bugs will look like rendering bugs while being ownership bugs. One module decides; everyone else consumes the decision. |
| **Reality check** | Every branch traces to a census row. **A branch with no census row does not get written** — that is the rule that keeps this from growing imagined cases. |

**Isolation contract:**
- Lives in `protocols/media/`, beside the `base64.ts` it feeds.
- **Single consumer:** the transcript-mapping boundary (`codex/renderer/transcript/entries.ts`,
  and the Claude equivalent). Nothing else calls it.
- **Forbidden from importing it:** every one of the 7 `toolResultContentText` call sites,
  every feed component, `Block.tsx`, `ToolResultRow.tsx`, `JsonToolRow.tsx`. If a painter
  needs to know something is an image, it learns that from the already-mapped neutral
  `image` block — not by re-recognizing. This is the rule that prevents regrowing the
  distributed-ownership shape.
- **Forbidden to import:** React, any `@providers/<name>/` module, anything under
  `features/`.

### Stage F — Mapping and painting

| Field | |
|---|---|
| **Produces** | Wire changes at the mapping boundary only: Codex `input_image` (both `payload.output[]` and `payload.content[]`) → neutral `image` block; Claude `tool_result` image parts → neutral `image` block enriched from the `toolUseResult` sidecar; `_atp.source` carriage handled by the same recognizer. Painting reuses `ImageBlockRow`/`Base64MediaView` unchanged. |
| **Verified by** | Stage D green. `bundleCorpus` and `recordingCorpus` show **no untriaged divergence**; any divergence is triaged with a written `why` (per `docs/rendering/rendering-design-principles.md` §4.4). D11 by-reference no-op tests stay green. |
| **Why separate** | Isolating recognition from mapping means a wrong recognizer is a one-file fix, not a seven-consumer archaeology exercise. |
| **Reality check** | Corpus replay against real recordings, not synthetic ticks. |

### Stage G — The structural guard

| Field | |
|---|---|
| **Produces** | A test asserting the invariant directly: **for every fixture in `testing/fixtures/image-reads/`, the string reaching the feed contains no base64 run ≥200 chars.** Plus a narrowing of `codexOutputText`'s fallback so an unrecognized non-text output item can no longer be `JSON.stringify`'d without bound (entries.ts:69). |
| **Verified by** | Deliberately regress the recognizer (drop one shape) and confirm the guard goes red. If it does not, the guard is decorative. |
| **Why separate** | Stages E/F fix the eight *known* shapes. This is the only artifact that constrains the **ninth** — the shape a provider ships next month. Without it, we are back to enumerate-and-patch, and the census expires the day it is written. |
| **Reality check** | Runs over Stage C's real fixtures. |

---

## What is being isolated

**The hard part is deciding whether an arbitrary provider node is an image, and which of
several overlapping records for that image wins.**

- **Where it lives:** `src/providers/shared/renderer/protocols/media/imageAttachment.ts`
- **Single consumer:** the transcript-mapping boundary, nothing else
- **Forbidden importers:** all 7 `toolResultContentText` call sites, all feed components,
  `Block.tsx`, `ToolResultRow.tsx`, `JsonToolRow.tsx`
- **Forbidden imports:** React, `@providers/<name>/*`, `features/*`

Also worth stating plainly, because it is a structural claim and not a taste claim:
`codexOutputText` and `toolResultContentText` return `string`. **That return type is the
substrate defect.** They are asked to flatten a heterogeneous content array into text, and
they are called before anything has decided what the non-text parts *are*. The stages above
do not delete them — they make sure nothing image-shaped is still present by the time they
run.

---

## Unknowns

Not blank, and I do not believe it could be after one pass:

1. **The live/semantic plane is unverified.** The census covered committed JSONL only.
   Claude's proxy semantic stream and Codex's live channel carry tool results too, and the
   ghost system may mint a provisional record for an image read before the committed entry
   lands. **I do not know what an image read looks like mid-stream, or whether the ghost
   predicate currently admits one.** Stage B must extend the census to `feed-debug` and
   `session-recordings` under `~/.config/agent-code/`, not just the provider transcripts.
2. **OpenCode is entirely unexamined.** `opencode-headless` is a registered provider with its
   own shapes catalog. Zero census data. It may have no image path at all, or a ninth shape.
3. ~~**`detail` is uninterpreted.**~~ **Answered by the captured session.** Every observed
   `input_image` carries `detail: "high"`. It is a request-side vision-fidelity hint, not a
   presentation directive. Carry it through as metadata; no painter branches on it. Whether
   any other value ever occurs is still unknown — the recognizer must not assume `'high'`.
4. **`thinking.signature` is an adjacent, unrelated base64 dump risk.** The census
   incidentally found raw base64 signature strings up to 36,352 chars, 540 occurrences
   across 14 files, on `_atp.source.message.content[]`. **Out of scope for this document**
   — but it is the same failure mode and someone should open an issue.
5. **Frequency is not yet established** (see Stage B).
6. **Audio is in the allowlist but absent from the census.** `parseBase64MediaPreview`
   supports 8 audio MIME types. No audio shape was observed. Unknown whether any provider
   emits one, or whether that branch is speculative.
7. **Whether `view_image` on a *missing* file produces a distinct error shape** — no failure
   case appeared in the corpus, which likely means "not captured," not "does not exist."

---

## Fixture plan

- **Source:** `~/.claude/projects/**/*.jsonl` (1,912) and `~/.codex/sessions/**/*.jsonl`
  (1,581), already on disk. Extended in Stage B to `~/.config/agent-code/feed-debug` and
  `session-recordings` for the live plane.
- **Produced by:** Stage B (census) → Stage C (extraction).
- **Consumed by:** Stage D's tests, written before Stage E exists.
- **Landing:** `testing/fixtures/image-reads/`, routed through the canonical redactor per
  `docs/rendering/rendering-design-principles.md` §4.2.
- **Not permitted:** hand-written base64 literals; a "plausible-looking" `input_image`;
  any fixture whose provenance is not a named real session.

---

## Open questions — I need your call before Stage C/D

These are semantics questions. If I infer them I will write tests that bless my inference,
which is the failure the method is built to prevent.

**1. What happens to the image bytes in checked-in fixtures?**
The redactor is key-based and does not touch base64. Real fixtures would commit real image
bytes — plausibly screenshots of your screen — into a public repo, at up to 5 MB each.
Options: (a) keep bytes verbatim for the smallest fixture per shape and substitute a 1×1 PNG
elsewhere, preserving the recorded *length* as metadata; (b) substitute everywhere, keeping
real structure + real lengths but synthetic payload; (c) keep everything verbatim.
**My recommendation: (b).** The renderer never interprets the pixels — only MIME, length,
and envelope shape — so the payload is the one part of these recordings with no information
value and all of the risk. But this is your repo and your call, and it is the one place I
would be knowingly departing from "do not clean up the recordings."

**2. Claude gives the same image twice. Which source of truth wins?**
The `tool_result` content block has the payload; the `toolUseResult.file` sidecar has the
payload *plus* `dimensions` and `originalSize`. Should the recognizer (a) prefer the sidecar
and treat the block as a fallback, (b) take the payload from the block and enrich metadata
from the sidecar, or (c) something else? This decides what happens when they disagree —
which they will, after a rewind or a provider switch.

**3. What should an unrecognized image envelope render as?**
Today: base64 text (Claude) or a 5 MB dump (Codex) or nothing (Codex attachments). Should an
envelope that fails the MIME allowlist or exceeds 8 MiB render as (a) a labelled placeholder
with the filename and a "not previewable" note, (b) today's `LazyJsonDisclosure` fallback,
(c) a placeholder that offers to open the file on disk? This matters more than the happy
path — it is what a *future* provider shape will hit.

**4. Scope of this work: is D3 (Codex attachments vanish) in or out?**
It is the same mapper and the same census, and fixing D1 without it means image reads render
while user attachments still silently disappear. I have assumed **in**. Say so if you want
it split.

**5. This plan conflicts with the standing "no new test files in feature/fix PRs" rule.**
Stages D and G are both new test files (`imageAttachment.test.ts` and the base64-escape
guard), and Stage C adds a new fixture directory. The whole method rests on those tests
existing *before* the implementation, so I cannot honour both constraints. Options: (a) make
this PR the exception and land the tests with the fix; (b) land fixtures + tests as a
separate preceding PR; (c) use temporary fixtures and land no permanent test file, accepting
that Stage G's guard — the only thing constraining the *ninth* shape — does not ship.
**My recommendation: (a).** Stage G is the part of this work with the longest useful life,
and a rendering fix with no corpus guard is exactly the shape
`docs/rendering/rendering-design-principles.md` §5 forbids.

---

## Outcome (rev 3, implemented 2026-07-27)

All seven stages shipped. `npm run typecheck` clean on both projects;
**1,668 tests / 248 files green**, including the bundle and recording corpora with no
untriaged divergence.

| Stage | Artifact | Status |
|---|---|---|
| B | `scripts/extract-image-shapes.mts` → `evidence/image-reads/shape-census.md` | 27 shapes from 1,915 Claude + 1,581 Codex files |
| C | `scripts/extract-image-fixtures.mts` → `testing/fixtures/image-reads/` | 7 fixtures, 32 KB (from 80.86 MB of observed payload) |
| D | `protocols/media/imageAttachment.test.ts` | 17 tests, red before E existed |
| E | `protocols/media/imageAttachment.ts` | `recognizeResultParts` / `recognizeImageNode` / `sidecarImageMetadata` |
| F | `codex/renderer/transcript/{entries,rollout}.ts`, `ToolResultRow.tsx`, `toolResultContent.ts` | mapping + ordered painting |
| G | `codex/renderer/transcript/imageResults.test.ts` | 11 tests incl. the escape guard |

### What the census changed about the plan

The 27 placements collapse to **four distinct node shapes**, which is why the recognizer is
placement-agnostic rather than plane-keyed: `claude-native`, `codex-data-url`,
`claude-sidecar`, and the sidecar's `{type:'image', file:{…}}` wrapper. Row 12 of the census
is a **false positive kept deliberately** — Codex's `exec` tool JSON-Schema declares its
output item type as `{image_url, name, path, text, type}`. It describes an image; it is not
one. The recognizer's `base64`-payload guard rejects it, and there is a test pinning that.

### Three things the process caught that a direct fix would not have

1. **`tsc` caught a vanish bug I introduced.** Adding image blocks to Codex message content
   made the synthetic-user filter (`rollout.ts:176`) call `isCodexSyntheticUserBlockText`
   with `undefined` for an image-only message — which would have dropped it. Fixing the
   dump bug by creating a vanish bug for users who attach one image and no text is precisely
   the whack-a-mole the decomposition exists to prevent.
2. **A pre-existing test caught an incomplete label.** `toolResultContent.test.ts` asserts
   the text projection still names the MIME. My first label only read the nested
   `source.media_type` spelling and returned `[image]` for the flat
   `{type, mimeType, data}` envelope. The test was right and the code was wrong; the fix
   was to accept both spellings, and to let a payload-free image envelope fall through to
   the bounded projector so an unknown future schema stays inspectable.
3. **The escape guard was decorative when first written, and is not now.** Deliberately
   disabling the recognizer's `codex-data-url` branch turned the structural tests red while
   the base64-escape assertion stayed green — because the committed fixtures carry a ~100
   character 1×1 PNG, below the guard's 200-character threshold. The guard now re-inflates
   each payload to its recorded original length in memory before projecting. Re-verified:
   regressing the recognizer produces 6 failures naming `279883-char base64 run reached
   feed text from …rollout-2026-07-23…:68`. **A guard that cannot fail is worse than no
   guard, because it reads as coverage.**

## Review round (rev 4, 2026-07-27)

Two orchestrated reviewers — one on correctness/blast-radius (Claude), one adversarial
(Codex) — audited the branch independently. **They found the same blocking defect, and it
invalidated this document's central claim.**

### The half-fix, and why the suite could not see it

Rev 3 asserted "Codex image results render as images." **False.** The new painter lived in
the generic `ToolResultRow`, but `renderCodexToolResult` (`codex/renderer/rows/dispatch.tsx:459-474`)
claims every result whose correlated call is named `exec` and whose envelope is
`custom_tool_call_output` — which is precisely how Codex returns an image-bearing shell
result. Those went to `CodexToolResultRow`, which flattened them straight back to
`[image/jpeg]` labels via `toolResultContentText`.

So the megabyte dump was genuinely gone, and **no image ever appeared** — on the exact path
that produced the screenshot in the bug report. The fix landed on `view_image` (6
occurrences in one file corpus-wide) and on Claude `Read`, and missed the carrier the census
identified as dominant.

The suite stayed green because `imageResults.test.ts` was named "the reported bug end to
end" while asserting only that the *mapped block* carried image parts. **It stopped one
layer above routing.** An assertion about an intermediate representation is not an assertion
about what the user sees — and naming it "end to end" is how that gap stayed invisible.

Fixed by extracting `ResultParts` (`providers/shared/renderer/rows/ResultParts.tsx`), used
by both painters, plus `imagePainting.renderer.test.tsx` which renders the real component
and looks for media. Verified to fail on the half-fix (2 of 3 tests red) before passing.

### Other findings, all fixed

| Finding | Fix |
|---|---|
| `hasMediaParts` matched bare `type === 'image'`, stealing flat MCP `ImageContent` from `McpContentView` and dropping its `isError`/`structuredContent`/`_meta` siblings | `hasRenderableMedia` now requires a base64 `source` envelope |
| Unrecognized envelopes still dumped unbounded base64 — `{type:'future_image', image_url:'data:…'}` reproduced the original defect at 1,000,069 chars | `codexOutputText` fallbacks route through `boundedJsonPreview`; **long encoded runs are now elided in the projector itself**, which covers every caller instead of one |
| `toolResultContentText`'s label was defeatable three ways (unnormalized `input_image`, `{type:'future_media', data}`, payload nested at `source.payload.data`) — 490–512 char runs | Same projector-level elision. Guarding shapes one at a time was the enumerate-and-patch loop this document exists to end |
| `inflate()` matched substitutions positionally with a `>32` threshold vs the extractor's `>256`, so an unrelated short `data` field could consume the recorded size and disarm the guard | Keyed by recorded path, with a hard failure if any path does not resolve |
| Three fixtures produced **zero** projections — their guard tests asserted nothing and passed vacuously | `textProjections` now walks `_atp.source` and the Claude sidecar; an explicit assertion fails a fixture that yields no projections |
| Header claimed "every input here is loaded from disk" while the negative tests use literals | Comment corrected to state why negative cases are necessarily handwritten |
| "traceable to a real session" only regex-matched the citation string | Now opens the cited file |
| `ImageBlockRow` stamped the assistant marker `⏺`, reading as `⎿ path / ⏺ image` | `ResultParts` uses `Base64MediaView` directly, no marker |

**Also caught during the fix, by tsc:** the first version of the `CodexToolResultRow` branch
early-returned *before* that component's `useMemo`, which would have changed the hook count
between renders and crashed React's dispatcher.

### What the reviewers confirmed

- `isError: false` in the structured branch is **not** a regression — independently verified
  against all 43 image-bearing `custom_tool_call_output` records: every one has array output,
  none carries a parseable JSON envelope, so the old code computed `exitCode = 0` identically.
- The isolation contract holds: only the two Codex transcript-mapping files import the
  recognizer.
- `tool_search_output` still flattens, but no bytes escape and the census records no image
  on that payload type.

### A fix that was worse than the flaw (rev 5)

Review objected that "traceable to a real session" only regex-matched the citation string.
Correct. The repair — `existsSync` on the cited path — was **wrong**, and CI caught it: the
source corpora are the developer's own `~/.claude/projects` and `~/.codex/sessions`, which
are machine-local by nature and cannot exist on a runner. A portable test became one that
passed on exactly one laptop, and the local suite could not see it because the files were
right there.

The resolution is to be honest about where provenance is actually enforced: **at generation,
not at assertion.** A fixture cannot exist unless `extract-image-fixtures.mts` opened that
exact file at that exact line and read a parseable record. The test now asserts
well-formedness always, and existence only when a corpus root is present — a second opinion
where the evidence is reachable, and silence where it is not.

Verified by re-running the whole suite under a `HOME` with no corpora, which is the
condition CI runs in. That check is now the standard before pushing anything that touches
these fixtures.

### Standing caveat

The one claim still unverified by any test: **that this looks right in a running app.**
Everything above is corpus replay and component rendering under happy-dom.

### Known gap, recorded and not fixed

**Images lost across a provider switch are still lost.** Fixture
`atp-codex-image-inside-claude-transcript.json` is the proof: the Claude-side
`message.content` for that entry is a single text block reading *"Script completed / Wall
time 0.0 seconds / Output:"* — the image survives **only** under `_atp.source`. The reverse
direction (`atp-claude-image-inside-codex-rollout.json`) shows the Codex-side content
reduced to `"[Image #4] [Image #5] [Image #6]"`.

The recognizer already handles both — there are passing tests proving it recognizes those
nodes — but nothing in the renderer currently *reads* `_atp.source`, and adding that is a
new data path rather than a fix to this one. It belongs in `agent-transcript-parser`'s
translation, not in the renderer. Fixtures and tests are in place for whoever takes it.

Also unshipped: `sidecarImageMetadata` is implemented and tested but not yet wired to the
painter, because `ToolResultRow` receives a block and not its entry, so `toolUseResult`
would need plumbing through the ledger. The payload path does not depend on it — it only
costs the dimensions/original-size caption on Claude image reads.

---

## What I have deliberately not done

No implementation code. No modification to `entries.ts:69`, which is a one-line change I
could make right now and which would visibly "fix" the reported symptom for the two Codex
shapes that were in front of me — leaving six shapes, three planes, and the cross-provider
carriage still broken, and leaving no artifact that would ever tell us so.
