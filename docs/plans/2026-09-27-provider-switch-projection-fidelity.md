# Carry the native projection report through switch, duplicate and rewind (#927)

Short plan: bug with a known root cause. Part of #918's B06; see `docs/superpowers/plans/2026-09-12-session-operation-ownership.md` §6.2.

## Outcome
`switchProvider`, `duplicateSession` and `rewindSession` each call a real native-resume projector. Each writes `projection.values` and throws `projection.report` away, so nobody can see what the projector preserved, dropped, demoted, repaired or synthesized. A switch returns only `shrinkSummary`, which describes context REDUCTION (the fit ladder) and is null whenever nothing had to be shrunk, even when the projection itself lost content.

After this change, all three results carry a bounded, curated `projectionFidelity` summary of the real report, through IPC to the renderer. A switch or duplicate that loses material content says so in its existing pane toast, even when the context reduction reports no shrink.

## Evidence (verified 2026-09-27 against the recorded Stage 0 sequences; do not re-derive)
All 13 `packages/agent-transcript-parser/fixtures/evidence/observed-sequences/*` cases were projected through the REAL projectors (Claude 2.1.0 / Codex 0.157.1 profiles):
- **Every Codex case loses something in both directions,** including Codex → Codex, which is what a duplicate or rewind does.
  - The codes seen: `opaque.dropped` 1–30, and to Claude also `message.developer.dropped`, `reasoning.foreign-dropped` and `tool-call.input-object-repaired`.
- **Claude → Codex:** `reasoning.encrypted-content-demoted` (19–485), `tool-result.error-status-demoted`, `compaction.foreign-summary-demoted` and `content.image.dropped`.
- **Claude → Claude:** mostly lossless; `claude-sequence-oversized-turns` drops 110 opaque records and repairs 4 tool results.
- **Framing** (`session-meta.synthesized`, `turn-framing.synthesized`) appears on every Codex target. It is identity and framing, not user-visible loss.
- `ProjectionChange.message` is projector prose; `code` is a closed vocabulary (`native-resume.<entry>.<outcome>`). `evidence` carries source claims.

## Design (contract)
- **`src/shared/types/projectionFidelity.ts`:**
  - `NativeProjectionFidelity = { profile: 'native-resume', sourceProvider, targetProvider, providerProfileId, providerEvidence: { sourceCommit?, cliVersion?, observedAt? }, counts: Record<kind, number>, codes: Array<{ kind, code, count, sourceLines: number[] }>, sourceLinesOmitted: number }`.
  - One `codes` row per distinct (kind, code). `sourceLines` is capped at 20 per row, and the rest is COUNTED in `sourceLinesOmitted`, never silently dropped.
  - **Excluded on purpose:** `message` and `evidence`. The summary crosses IPC and reaches the UI, where only curated text may appear (q22/q39); the code identifies each change without projector prose or source content.
- **`src/main/providerSwitch/projectionFidelity.ts`:** `summarizeProjectionReport(result: NativeResumeProjectionResult): NativeProjectionFidelity`. It is pure and is called right after each `projectNativeResume`, before `write`, so the summary exists even if publication fails later. (Receipts are B07; nothing here pretends to persist one.)
- **Results:** `SwitchProviderResult` (the `switched` arm), `DuplicateSessionResult` and `RewindSessionResult` gain `projectionFidelity: NativeProjectionFidelity`. The preload types use the shared type.
- **`materialProjectionLoss(f): string | null`**, one line for toasts, or null.
  - **OWNER-APPROVED (B6 proxy, 2026-09-27):** material means `dropped` changes other than `native-resume.opaque.dropped`, plus every `demoted` change.
  - Opaque records, repairs and synthesized framing are not disclosed in the toast; they remain inspectable in the result.
  - **Format, OWNER-APPROVED (B6 proxy, 2026-09-27):** `history: 12 dropped, 19 demoted`. It is wording only, no data change.
- **Renderer:**
  - The switch pane toast (`workspace/hook/actions/provider.ts`) appends the line and uses the longer lossy duration when it is present.
  - The bulk switch summary (`bulkProviderSwitch.ts`) adds it to its notes.
  - The duplicate command's toast (`sessionCommands.ts`) appends it too.
  - Rewind carries the field for inspection. Its own toast lives in `pane.ts`, which open PR #1369 (another worker) edits, so it is not touched here; see Out of scope.

## Tests
- **Real reports, real projectors:** `switchProvider`, `duplicateSession` and `rewindSession` tests use a recorded sequence through the REAL transcript engine projector.
  - Only disk writes and lookups stay mocked, because a projection mock returning only `values` cannot prove this contract (B06 exit gate).
  - Each asserts the result's `projectionFidelity` equals `summarizeProjectionReport` of that real projection, with non-zero loss.
  - The switch case has a null `shrinkSummary`, so loss is visible without context reduction.
  - All red on main: the field is absent.
- **`summarizeProjectionReport` on a real report:** grouping, the 20-line cap with the omitted count, and no `message`/`evidence` fields in the output.
- **`materialProjectionLoss`** on recorded counts: Codex → Claude and Claude → Codex are material; `codex-sequence-compaction` → Codex (opaque only) is null.
- **Renderer:**
  - the switch toast includes the line for a material fidelity result;
  - the bulk notes include it;
  - the duplicate toast includes it.

## Verification boundary
Main-process tests drive the real entry points with real projectors; the app is not launched. The toast wording is OWNER-APPROVED (B6 proxy, 2026-09-27).

## Out of scope
- **B07 receipts / operation records:** no receipt store exists yet. The summary is on the result, which is what the client can inspect today.
- **The rewind toast in `pane.ts`:** open PR #1369 edits that file. The rewind result carries the field for a follow-up.
- **Draft-restoration reports** (#929) and literal-markup provenance (#930).

## Review round 1 (a and c: FIX-BEFORE-MERGE; b: FIX, test gaps) and steering q90
- **a (major): a publication that rejects after the effect loses the summary.** It may have linked the native file.
  - **Ruling:** narrow the claim instead of carrying the summary on the failure. Electron's IPC keeps only an error's message, so a summary on a thrown error never reaches the renderer. A new failure arm on all three results is #918 B07's receipt work.
  - The comments now say the summary is returned only on success.
  - A recorded-sequence test pins it: a write that rejects after receiving the projection rejects the operation with that error and returns no success-shaped result.
- **c (major): the control entry points discarded the summary.**
  - `agents.switchProvider` and `agents.rewind` (through the `result` helper) and `agents.duplicate` now return `projectionFidelity`, and their descriptions name it. Duplicate is no longer called "exact".
  - The rewind action returns it and names material loss in its toast.
  - Correction: the rewind toast lives in `provider.ts`, not in `pane.ts` as this plan first said, so it is in scope.
- **a (major): toast order.** Material loss now comes before the shrink prose, because PaneToast clamps to three lines.
- **Pins, each killing its surviving mutation:**
  - the populated main → renderer relay (`providerSwitchCore`);
  - the forward bulk note;
  - the unplaced (row-menu) duplicate toast;
  - the control relay, through the real rewind action;
  - the rewind toast;
  - exact source lines per code, the profile id, and `counts` copied rather than aliased.
- **b:** the false comment "every recorded sequence loses something" is corrected (two Claude sequences are lossless).
- **Still for the owner:**
  - the material rule (b notes that `reasoning.encrypted-content-demoted` and `tool-result.error-status-demoted` keep their content, so every Claude → Codex switch toasts a demotion line);
  - the wording.
