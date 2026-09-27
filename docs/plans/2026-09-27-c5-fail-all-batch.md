# C5 fail-all batch (#1251)

Source: the read-only C5 hunt in `temp/quality-loop/hunt-c5.md`, rows 8–13. Each row was verified on origin/main `5e22c7b0` before any fix. "Fail-first" means the new test was run red against main's implementation first.

## Principle

One bad record must cost only itself. Two constraints shape every fix:

1. **Owner rule: do not delete stuff often (2026-09-27).** A record this build cannot read is carried verbatim whenever the file is rewritten, never dropped.
2. **Ambiguity fails closed (q40).**
   - A skipped approval grants nothing.
   - A skipped ledger row can only fail to protect a bundle it does not name.
   - Destructive transforms keep refusing (row 10).

## Rows

| Row | Verified on main | Decision | Test (fail-first) |
|---|---|---|---|
| 8: Codex rollouts, `conversations/sources/codex.ts` | Yes. `readRolloutHead` streams through readline, which rethrows EACCES/EIO. `fromHead` and both discovery loops await it with no catch, so `discover()` rejected and the Codex column emptied. | Skip the unreadable rollout (it has no cwd to scope it by); cache nothing, so it is retried later. | `codex.system.test.ts`, "skips an unreadable rollout…": red with EACCES. |
| 9: monitor incidents, `performance/MonitorHistoryStore.ts` | Yes, and worse than the hunt said. One unparseable row hid the run's whole incident list. On a helper restart in that run, `persistIncidents` merged from an empty list and rewrote `incidents.json`, erasing the readable evidence AND the unknown row. Realistic: Preview and stable builds share this directory. | Parse per row. Carry unknown rows per run in `foreignIncidents`, and re-append them on every rewrite via `incidentFileBody`. Leave room under `INCIDENT_LIMIT`, keep the run from expiry-by-emptiness, and mark the store degraded. | `MonitorHistoryStore.test.ts`, "keeps readable incidents…": red (`null` for the readable incident). |
| 10: Pi JSONL, `providerSwitch/piTranscript.ts` | Real, but **strict by design**. `loadPiSnapshotAt` feeds destructive transforms (switch, duplicate, rewind). Skipping a malformed middle line would move or rewind a conversation with a silent hole. | No change. The error names the file and line and never reaches a toast raw. | none |
| 11: workflow approvals, `workflows/WorkflowSourceApprovalStore.ts` | Yes. `load()` threw on the first bad entry and never set `loaded`, so every `authorize()` rethrew: all repository workflows were blocked. | Skip the entry (it approves nothing, so its source is prompted again) and carry it verbatim through `persist()`. A wrong file version still throws, because that is not one bad row. | `WorkflowSourceApprovalStore.test.ts`, "honours valid approvals…": red. |
| 12: TLDR batch, `main/tldr/ipc.ts` | Yes. `z.array(z.string().refine(validTldrIdentity))` rejected the whole batch, and Agent Activity reads every TLDR and goal in one batch. | Keep the payload shape strict (a bounded array of bounded strings) and drop invalid identities. This is exact: the store only writes valid identities, so an invalid one has no record. | New `tldr/ipc.test.ts`: red (ZodError). A second test pins that malformed payloads are still refused. |
| 13: legacy bundle ledger, `storage/debugRetention.ts` | Yes. A JSON-valid non-entry line (`null`, or a row with a non-string `bundlePath`) threw TypeError, which rejected `collectArtifacts` and stopped every prune pass. | Extract `parseManualLegacyBundlePaths`, then shape-check each row. A non-string reason counts as manual, so retention keeps the bundle. | `debugRetention.test.ts`, "keeps every readable manual row…": red (`null.event`). |

Rows 14–15 (key vault index, agent-name registry, tmux recovery) are strict by design per the issue and are only recorded there.

## Residuals

- **Row 9:**
  - Carried foreign rows never expire on their own. They leave disk only with their run directory (budget pruning, clear).
  - A run whose incident file holds only foreign rows is kept from expiry-by-emptiness. It is still pruned by the data budget.
- **Row 12:** a renderer that sends an invalid identity gets no record and no error for it. That is the same answer as "no TLDR yet".

## Review round 1 (a, b, c codex at `129f8c5a`): all FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **a1 / b1 / c1, major:** a WHOLLY refused incident file (a newer-format object, over the row limit, oversized, malformed JSON, unreadable) kept no marker. The current run's next incident replaced it with only the new row, and maintenance expired a prior run holding one as empty. | valid | The run is marked refused. The current run moves the refused file aside to `incidents.refused-<ms>.json` (same run dir, counted in the byte budget) before its first write, and writes nothing if the move fails. Maintenance keeps refused runs. Three fail-first cases (object, 51 rows, malformed JSON). |
| **a and c survivor:** the foreign-only prior-run expiry guard was unpinned. | valid | The prior-run test covers a foreign-only run and a refused run; removing either guard goes red. |
| **b2, major:** one indexed row with a wrong-typed value (a BLOB title) made `.trim()` throw and rejected the whole index. | valid | `normalizeIndexRow` types each field by value. A wrong type becomes the empty value, so the title falls back; only a row with no string id is dropped (and counted). Fail-first with a BLOB title on the recorded corpus: the row still lists under its fallback label. |
| **c2, minor:** a skipped rollout left discovery looking complete. | valid | Skips are counted into the discovery span, `lastDowngradeReason` and one console warning (counts only). **Residual:** the picker has no degraded indicator for any source yet, including the existing no-index downgrade. |
| **b3, minor:** `tldr:history` and `goal:history` threw for an invalid identity that the batch reads skip. | valid | Empty history for an invalid identity; a non-string payload is still refused. Mutant red. |
| **a3, minor:** with the file full of carried rows, a new incident was silently not kept. | valid | Carried rows still win (owner rule), but `shortened` is set. Fail-first. |
| **a survivor:** dropping the `approvedAt` check passed. | valid | An entry missing `approvedAt` prompts. Mutant red. |
| **b survivor:** the row 13 loader returning an empty set passed. | valid | Row 13 moved to #1417 (manager q109: the same loader as steering q109), with a test through the real loader there. This PR no longer touches `debugRetention`. |
| **a2, minor:** carried rows change position on rewrite. | declined | Values are all kept. Neither reader gives order any authority: incidents are sorted by `at`, and approvals are keyed by identity plus hash. Preserving the original interleaving would need positional bookkeeping for no reader. |

## Review round 2 (a, b, c codex at `7204503c`): all FIX-BEFORE-MERGE (final round)

| Finding | Verdict | Change |
|---|---|---|
| **a / b / c, major:** a set-aside refused file was deleted by a later run's retention. Setting it aside cleared the refusal marker, so once the run's readable incidents expired it looked empty. | valid | `refusedAsideRuns`: every run holding an `incidents.refused-*` file (listed at startup, added on set-aside) is never expired; only budget pruning and `clear()` remove it. Fail-first with a day-8 later run. |
| **a / b / c, major:** the aside name was only `Date.now()`, and `rename` replaces, so a same-millisecond second refusal overwrote the first | valid | The name adds a UUID. Fail-first with a fixed clock and two refusals: both bodies are kept. |
| **c survivor:** removing `refusedIncidentRuns.delete` after a set-aside (a stale marker) | valid | The collision test records again after a set-aside: one aside file, and the canonical file holds both incidents. Mutant red. |
| **b survivor:** the rename-failure guard | valid | A read-only run dir makes the set-aside fail; the refused file stays byte-for-byte and `shortened` is set. Mutant red. |
| **a / c survivors:** the `source`, `first_user_message`, `cwd` and `git_branch` type guards | valid | The wrong-type test now BLOBs every projected string column, plus a second row whose empty title falls to a BLOB first message; all four mutants red. |
| **c3, minor:** the picker still shows a partial Codex list as complete | residual, **filed as #1433** | Needs a per-source degraded status through `Discovery` and a curated picker line (q39); out of scope for a fail-all fix. |
