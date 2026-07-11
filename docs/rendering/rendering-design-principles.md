# Rendering Pipeline — Design Principles

> **Status:** evergreen. This is *how we work on* the rendering pipeline, and *why* we work that way. Read it before you touch a single file under `src/renderer/src/rendering/` or `src/renderer/src/features/feed/`.
>
> **Companion:** [`rendering-system.md`](./rendering-system.md) — what the pipeline *is* (the architecture). This doc is the discipline; that doc is the map.
>
> **The one-line version:** *We work this pipeline test-first, because the bug class here is one that focused patches provably cannot hold — every fix must be a recorded, replayable fixture before it is code.*

---

## 1. Why this discipline exists (read this part, not just the rules)

For most of this app's history the feed was painted by **several subsystems that each believed they owned what is visible**: committed transcript rows, the live semantic turn, semantic history, ghosts, optimistic prompts, the queue, the raw screen, the work spinner. Nobody arbitrated between them. They were rendered as fixed JSX planes in a fixed order.

Every single rendering incident we ever shipped was one of exactly three shapes:

1. **Two owners** claimed the same visible thing → a duplicate (#170, #172, #194).
2. **One owner suppressed another before the replacement was visible** → a vanish (#159, #290, #191).
3. **An artifact was present-but-buried** by accidental plane order → "it never showed" even though it was in the DOM (#239, #344).

And every time, we shipped a **focused patch** for the exact reproduction — and a *neighboring plane regressed*, because the ownership model was still distributed. We would fix "codex live text duplicates the committed row" and break "codex tool output vanishes." We would fix "prompt buried under history" and break "queued prompt sticks after idle." The knowledge dump's blunt conclusion, earned over dozens of these:

> There is **no safe universal transfer rule.** Not "latest wins," not "committed always wins," not any TTL. Every ownership transfer needs *recorded source evidence*, decided in one place.

That is the whole reason the ownership ledger exists (see `rendering-system.md`), and it is the whole reason this doc exists. The ledger makes ownership decidable in one place; **this discipline makes sure a change to that one place can never silently reintroduce one of the three shapes.** The mechanism is test-first development against real recordings, layered so that the *class* of bug — not just the reproduction — is nailed shut.

If you remember one thing: **you cannot fix a rendering bug by reading code and editing it. You reproduce it as a fixture first, or you will regress something you can't see.**

---

## 2. The core principles

### P1 — Reproduce before you fix. The bug *is* a fixture.

A rendering bug report is not a description — it is a **captured artifact**. The app ships the capture gestures for exactly this:

- **"Save debug logs"** captures a *debug bundle*: the full `SessionRuntime` slices at the moment the bug was on screen, plus what the renderer actually painted. These land in `testing/fixtures/rendering-bundles/` (48 and growing) and drive `bundleCorpus.test.ts`.
- **"Attach recording note"** bookmarks a timestamp inside a *session recording* — the raw stream of all nine `SessionFeed` channels — the instant you see the bug. These become `testing/fixtures/rendering-recordings/` fixtures driving `recordingCorpus.test.ts`.

You do not start editing `ownership.ts` from a hunch. You get the capture, extract it into a failing fixture, and *then* you have something a fix can be measured against. This is the `superpowers:systematic-debugging` iron law ("no fixes without root-cause investigation first") applied to a domain where "investigation" means "a replayable recording."

### P2 — Every suppression reason must prove itself with a fixture. Write the fixture first.

`RenderReason` (`model/types.ts`) is a **closed enum**, and its header carries the keystone rule (plan §7 rule 15):

> Every reason here has at least one fixture proving when it fires. **If you need a new reason, write the fixture first.**

This is the single most important habit in the pipeline. A suppression reason is a license to *hide something the user might need to see* — the most dangerous operation in the whole system. It does not get added because it seems right; it gets added because there is a recorded scenario where firing it is provably correct and *not* firing it is provably wrong.

**Be honest about the gate:** it is enforced by **review convention, not a mechanized coverage test** — there is no test that iterates the enum and fails on an uncovered reason. That makes the *discipline* the enforcement. When you review a PR that adds or broadens a `RenderReason`, the question is not "does this look reasonable" — it is **"where is the fixture, and what does it prove?"** No fixture, no merge.

### P3 — Assert order and ownership, not existence.

This is the acceptance bar that #172 was *reopened* to install, after PR #184 closed it with existence-only tests and the buried-prompt bug (#239) reproduced immediately. A test that asserts "the user prompt row exists" passes while the prompt sits invisibly *below* stale history. So:

- Ledger tests assert the **final order** of rows (the D4 chronological merge), not that a row is present.
- Ownership tests assert **who owns each slot and why** (the `OwnershipDecision.reason` + `evidence`), not just that something rendered.
- The present-but-invisible class (#239) is caught by replaying through the **view bridge** and asserting nothing landed in `ledgerToFeedItems.dropped` — because a row can be *selected by the ledger* and still never reach the DOM. Post-#493 the replay harness itself stops at the `RenderLedger` (so `rendering/` never imports the feed layer); the bridge reaches replay through the **required** `ReplayOptions.projectItems` injection — tests pass the real `ledgerToFeedItems` there.

### P4 — The decision record is the debug schema. Never build a second derivation.

The ledger emits an `OwnershipDecision` for **every** candidate, selected or rejected, carrying its `reason` and `evidence[]`. That record is retained on every `RenderLedger` and is what the replay invariants and corpus tooling consume verbatim — there is no separate "decide why this rendered" code path that could disagree with what actually painted (this is what structurally killed #344, "row vanished with no explanation"). Be precise about what the runtime capture surfaces write, though: feed-debug logs the *painter's* rows — `DebugVisibleRow`/`VisibleDecision` (`features/feed/types.ts`), i.e. what `Feed.tsx` actually put on screen — and `saveDebugBundle.ts` writes `render-diagnostics.json` from runtime ownership sets (`buildRenderDiagnostics`), not `OwnershipDecision` records verbatim. Those captures are *recordings of the paint*, derived downstream of the one decision point. The principle is about derivation, not file format: when you add a decision, you are simultaneously adding the diagnosis. **Do not** write a parallel explainer that re-decides visibility; if the debug output and the paint output can diverge, you have reintroduced the bug class.

### P5 — Reference stability is correctness, not performance.

The D11 contract — a pass whose inputs didn't change returns the previous object *by reference* — is tested as a *correctness* property (`expect(second).toBe(first)`), because violating it busted every Feed memo and shipped render-churn defects twice. When you touch a reducer, a collector, or the adapter, there is a "no-op in ⇒ identical reference out" test you must keep green. Cloning-on-no-op is a bug here, not a style nit.

### P6 — Bias toward *surviving* when ownership isn't provable.

When the ledger can't prove who owns a slot, it lets the candidate **survive** rather than suppress it. The reason is asymmetric visibility of failure: a row that survives too long is *on screen and diagnosable*; a row that vanishes early is the *silent* #339 class. Suppressing un-owned history is irreversible data loss (#159/#290 — the committed channel can be permanently dead, and the semantic-history bridge may be a turn's only representation). When in doubt, the pipeline shows and explains, rather than hides.

---

## 3. The three-layer test net

TDD here is not one test file — it is three nets at increasing scope, because the bug class is emergent and multi-tick. A change must survive all three.

### Layer 1 — Unit tests: assert the law

Tests live beside the code they pin, across all three layer directories: `src/renderer/src/rendering/**/*.test.ts`, `src/renderer/src/features/feed/ledger/*.test.ts`, and `src/renderer/src/session-runtime/**/*.test.ts` (the vitest `unit` project includes all of `src/**/*.test.ts`, so a moved test is never silently un-run). Each is **named for the incident it pins** and asserts a specific law:

- `model/ledger.test.ts` — the "load-bearing ten": the ordering law (#239 stale history sorts *before* the newer prompt; null timestamps sort last, never as "now"), committed ownership across the resp_*/rollout id split (#170), the Claude-vs-Codex whole-turn-suppression policy split on identical input (#165/#191), tool-*use* vs tool-*result* ownership (dump invariant 10), and D11 by-reference stability.
- `model/ghostPredicate.test.ts`, `model/unknowns.test.ts`, `observations/committed.test.ts`, `observations/semantic.test.ts`, `features/feed/ledger/ledgerFeedItems.test.ts`. Note there is deliberately **no `model/ownership.test.ts`** — the ownership pass has no dedicated file; its laws are pinned in `model/ledger.test.ts`, the collector tests (`observations/committed.test.ts`), the named end-to-end fixtures below, and the replay invariants. (The old `policy/foldPolicy.test.ts` is gone with its module — per-provider fold policy lives in `src/providers/*/renderer/semanticFoldPolicy.ts` now.)
- `adapter/collectLedgerInput.test.ts` — the **executable D11 spec** (same refs in ⇒ same bundle out; when only `semanticCurrent` advances, the other planes survive by reference).
- Named end-to-end fixtures: `fixtures.buriedPrompt239`, `fixtures.queueHandoff`, `fixtures.deadCommittedChannel159`, `fixtures.opencodeInterleave*`, `fixtures.sidecarTailGhost`, `fixtures.sidechainLeak`.

These run under the **`unit`** vitest project (node-pure — the ledger has no React).

### Layer 2 — The bundle corpus: real bugs, real ground truth

`bundleCorpus.test.ts` replays every captured debug bundle (48 at last count, growing) through the *real* pipeline and diffs the new output against the **legacy renderer's actually-painted rows** stored in each fixture — the external ground truth. Its assertion is subtle and important:

> It asserts that the divergence set **equals the checked-in `triage` exactly** — *stability*, not blanket parity.

Because many divergences from the legacy renderer are *the fix working*. Each divergence carries a triage verdict: `skew-ingestion-lag`, `equivalent-content`, `extraction-gap`, or `legacy-bug` (kept forever — the divergence *is* the improvement). An `untriaged` divergence is debt and fails the intent of the suite. A sanity floor guarantees the pipeline never paints blank when legacy painted anything.

**Bless discipline:** `AGENT_CODE_CORPUS_BLESS=1` rewrites each fixture's triage to the current diff. **Never bless without reading the failures first** — blessing a real regression *records it as expected*. Blessing is for after you've understood every changed row, never a way to make red go green.

### Layer 3 — Recording corpus + per-tick invariant replay: whole-class nets

Two mechanisms, both surviving the cutover (they don't need the deleted legacy renderer):

- **`recordingCorpus.test.ts`** — golden replay of redacted *session recordings* (the nine `SessionFeed` channels) against the pipeline's own last-blessed output. This is the permanent successor to shadow mode, and it catches **multi-tick** bugs that single-tick bundles can't (e.g. the queue-desync class #469 — enqueue, park, dequeue-the-wrong-item across ticks).
- **`replay/invariants.ts`** — `assertInvariants` runs **five whole-class nets at every tick**, needing *no expected output*: (1) dual-render, (2) vanish-without-replacement (with careful block-grain-vs-turn-grain asymmetry so a surviving sibling block doesn't "explain" a lost one), (3) unexplained-shrink, (4) D11 reference-instability, (5) unrenderable-drop (the #239 present-but-invisible class, caught only by running the view bridge over each tick's ledger). These express the three failure shapes from §1 *directly* as machine-checkable properties.

**The injection seam (post-#493):** `replay/recordedSession.ts` itself stops at the `RenderLedger` — it no longer imports the view bridge, because `rendering/` must never depend on `features/feed/`. Instead, `ReplayOptions.projectItems` is a **required** option (an omitted projection would be indistinguishable from "projected to nothing", silently gutting the unrenderable-drop net), and the corpus/invariant tests inject the *real* `ledgerToFeedItems` bridge through it. So the tests still exercise ledger→items end to end; the dependency arrow just points from the test, not from the replay harness.

**Honest gap to know:** the invariant/recording replay is **reducer-faithful, not full-React-fold** — `useIpcSubscriptions` (the fold glue) only runs under the `renderer` vitest project, while replay runs under `unit`. So the fold-glue bug class (e.g. queue reconstruction #469) is currently *recorded but not fully replayed*. Don't assume a green recording corpus exercised the React hook layer.

---

## 4. The workflow for a rendering change

1. **Get the capture.** A bug report without a bundle or recording is a request for a bundle or recording. Reproduce it and save one. (Aside: rule out a *dead tail* first — a stale `lastJsonlEntryAt` + `streamPhase: requesting` fingerprint is the tailer-unwatch bug masquerading as a rendering bug, not something to fix in the ledger.)
2. **Extract the failing fixture.** `scripts/extract-rendering-fixtures.mjs` (bundles) / `scripts/extract-rendering-recordings.mjs` (recordings), using `__note` markers as regions of interest. The redactor is *hard-gated*: it refuses to emit a fixture containing a sensitive value.
3. **Write the assertion that fails.** Order, ownership, and reason — per P3. If you're adding a suppression, the reason's fixture *is* this step (P2).
4. **Make it green without disturbing the corpus.** Run the `unit` project + `bundleCorpus` + `recordingCorpus`. A new corpus divergence must be *triaged with a `why`*, not blessed away.
5. **Keep D11 green.** If you touched a reducer/collector/adapter, the by-reference no-op test is not optional.
6. **Update `rendering-system.md`** in the same PR if you changed the architecture, and delete any stale comment you passed (see §5).

---

## 5. Hard rules & anti-patterns

**Never:**
- ...fix a rendering bug by editing code from a hunch. Fixture first (P1).
- ...add or broaden a `RenderReason` without the fixture that proves it (P2). Suppression is the most dangerous operation in the system.
- ...assert row *existence* as your acceptance bar (P3).
- ...build a second "why did this render" derivation separate from the `OwnershipDecision` record (P4).
- ...clone-on-no-op or mint a new object when inputs didn't change (P5).
- ...suppress semantic history that committed truth doesn't *own* — "hasn't caught up" means **reorder**, never suppress (P6).
- ...**bless a corpus without reading every failure.** Blessing a regression records it as expected.
- ...simplify a scarred rule (the five ghost rules, the `collapsed-running` tail-gate) without reading its extraction report. Each rule is a shipped regression's tombstone; `ghostPredicate.ts`'s header lists four separate "simpler" versions that each reintroduced a different bug.
- ...synthesize or ghost a tool **output** (§7 rule 1) — that fabricates content the model never produced.
- ...let `lastJsonlEntryAt` come from `Date.now()` — it's producer-clock `entry.timestamp`, and `null` (never `0`) is the "never seen" sentinel (§7 rule 2).
- ...use `streamPhase` as a submit-ownership signal — ownership is renderable *content* (§7 rule 10).

**Always:**
- Treat the ledger as the *single* decision point. If you find yourself deciding visibility in a feed component, stop — that decision belongs upstream, and putting it in the painter recreates the distributed-ownership bug class the ledger was built to end. The 2026-07 painter rewrite added an artifact layer (`features/feed/ui/resolve/` + `ui/artifacts/` — see `rendering-system.md` §5 and `docs/superpowers/specs/2026-07-11-feed-render-layer-rewrite-design.md`); that layer is *derivation*, not decision — resolvers must stay pure and total (never hide, never throw), and a card must never branch on `plane`.
- Prefer showing-and-explaining over hiding.
- Fix stale documentation you touch. The pipeline has a history of comments outliving the code they describe (`SemanticStreamingTurn`, `AGENT_CODE_RENDER_SHADOW`, `AGENT_CODE_RENDER_PIPELINE`, `deriveFeedRenderModel` are all **deleted** but still referenced in stray comments). A stale comment about a *rendering* decision is how the next person reintroduces the old model.

---

## 6. The through-line

The rendering pipeline is not hard because rendering is hard. It is hard because it arbitrates **multiple truths about the same conversation** that arrive over different channels, at different times, on different clocks, from different providers — any of which can be late, stalled, forked, or permanently dead. Focused patches don't hold against that, and we have the scar tissue to prove it. So the discipline is not "write tests because tests are good." It is: **make every ownership decision recorded, replayable, and reason-gated, so that the bug class — two owners, suppress-before-replace, present-but-buried — is closed structurally and stays closed.** Test-first is how a distributed-ownership problem stops being an infinite sequence of one-off regressions.
