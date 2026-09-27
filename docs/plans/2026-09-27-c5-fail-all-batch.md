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
