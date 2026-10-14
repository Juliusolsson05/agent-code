# Readable Codex `exec` scripts (#1510)

**Size:** standard plan. The design was judged in the browser preview against 62 real scripts, current versus proposed. Owner direction: "continue to iterate over all shapes to make the UI more friendly", and "we are trying to improve the UI not nuke it".

## Outcome
A finished Codex `exec` script that no exact adapter owns renders as one card. Each step it ran (a command, an MCP call, stdin, an image or a web call) gets one line ending in a verdict, with its output underneath. Instead of today's fallback, which shows:
- a RUNNING headline on a finished script;
- "1 structured record · 3 context lines";
- closed "JSON record · 5 keys" boxes;
- the transport boilerplate;
- `exec ▸ 1 param` for MCP-only scripts.

## Evidence (verified, do not re-derive)
**The shapes.** Measured over the owner's last 60 rollouts (1,566 scripts, 2026-10-14):
- the exact adapters admit almost none of today's shapes;
- `text(await tools.exec_command(…))` alone is 22% of all scripts;
- 65% of scripts call more than one tool.

**The result grammar** (counts are in the adapter header):
- a transport header;
- then one part per `text()` call: an ExecCommandResult, an allSettled wrapper, an MCP CallToolResult, text, `{}` or an image;
- or one "Warning: truncated output" part.

**The model:** the draft model, run over all 1,565 results, yields 3,176 results, and no raw JSON is shown open.

**The mapper:** the rollout mapper stores the script as `{raw}` and joins a text-only output array with `\n` (`entries.ts` `codexOutputText`). The adapter therefore reads every body as a line stream.

## Change
- **`adapters/scriptSteps.ts`**, `fromCodexScriptSteps(toolUse, result)`:
  - It declines for: no result, `apply_patch` scripts, results that are not exec envelopes, `running` (partial) results, and oversized input.
  - It returns `{steps, status, wallSeconds, truncatedTokens, results, paired, exactOutput}`.
- **`components/script-steps`**, `CodexScriptStepsRow`. It draws:
  - one line per step;
  - a verdict only when the result carries one;
  - output folded at 4 lines or 480 characters;
  - a closed `data ·` summary for unknown structure;
  - "looked up N tools" for catalogue reads;
  - the script's error kept apart from the steps;
  - "view exact output", which keeps every byte one click away.
- **`rows/dispatch.tsx`**: it is admitted after every exact, git, embedded and wait adapter and before the generic fallback. It absorbs the paired result.

## Tests
The fixture is `testing/fixtures/codex-exec-scripts/samples.json`: 12 recorded scripts, one per script × output shape, read in full before committing. The tests drive them through the real rollout mapper:
- the adapter's per-shape models;
- the property that no result is JSON shown as open text;
- dispatch admits the shape that used to fall back, and keeps exact-adapter shapes;
- the rendered card.

## Verification boundary
- The app was not launched.
- The live, mid-script streaming headline is unchanged: still command.ts's.

## Out of scope
The Claude tool-row cleanup goes in a separate PR (G3b).
