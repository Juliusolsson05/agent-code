# Machine- and time-dependent tests (#1296)

## Problem

The C9 hunt listed tests whose outcome depends on the machine they run on, on wall-clock timing, or
that leak developer data. Each item below is taken from the issue, with its current state on
`origin/main` checked in this branch.

## Items and decisions (defaults)

1. **`prerequisites.firstRun.test.ts` compares rows the live probe found machine-wide.**
   - `binaryResolver` scans `/opt/homebrew/bin` and `/usr/local/bin` (the `WELL_KNOWN_BIN_DIRS`) even
     under a temp HOME and a minimal PATH.
   - The test already skips rows the *recording* found at a machine-wide path, but not rows the
     *live* probe finds there. So on a Mac with Homebrew `claude`/`codex`/`opencode` the test fails,
     and it passes only on machines like the recorder's.
   - **Fix, test-side:** a row either side found at a machine-wide absolute path (outside the simulated
     HOME and the staged app root) is a fact about that machine, and is not compared.
   - No production seam is added: an injectable search list would exist only for this test.
2. **`githubCli.system.test.ts` asserts a wall-clock bound** (`elapsed < GH_TOKEN_TIMEOUT_MS + 2 s`)
   around a real `gh` spawn.
   - The production code already enforces `GH_TOKEN_TIMEOUT_MS`. A loaded machine can exceed
     "timeout + 2 s" without anything being wrong, and the vitest timeout (20 s) already fails a real
     hang.
   - **Fix:** drop the elapsed assertion and keep the settle-never-throws and token-shape contract.
   - **Declined: making it opt-in.** It reads the developer's `gh` token into memory only to check its
     shape, never prints or stores it. CI has no `gh`, where it resolves to `null`.
3. **`goalLoopTurnHooks.system.test.ts` settles for 20 ms before `rm`** (ENOTEMPTY under load).
   **Moved to #1341**: persistence outliving `afterEach` is the same root cause. The fix is a drain on
   the service, not a sleep, and that touches `GoalLoopService.test.ts`, which #1337 is changing.
4. **`BrowserPocketHost.renderer.test.tsx` sleeps 400 ms, then asserts a restart.** The first crash
   restarts after `nextCrashDelay` = 250 ms. **Fix:** wait for the observed restart (`vi.waitFor` on
   the src and the unregister) instead of a fixed sleep.
5. **`SubAgentWatcher.test.ts` polls a 1.5 s wall-clock deadline.** `watcher.refresh()` already
   returns the coalesced tick's promise. **Fix:** await it and assert once, with no deadline.
6. **Electron harness budgets** (`electronHarness.ts`, `runtimeHarness.ts`). **Declined, with the
   reason stated:**
   - These are bounded *condition* waits in the Electron journey tier. They fail fast instead of
     hanging a journey, and they are not part of the unit or system suites.
   - Replacing them needs Electron-level events (frame teardown, binding publication) that the
     harness cannot observe today.
   - Widening them is forbidden anyway.
7. **Weak negatives (fixed sleeps followed by "not called").** The `GoalLoopService.test.ts` and
   goal-loop system-test instances **move to #1341** with item 3: the same drain makes "nothing
   happened" provable instead of hoped for.
8. **Harness secrets dir** `os.tmpdir()/agent-code-harness-secrets-<pid>` (plaintext codec) is never
   cleaned. **Fix:** a `mkdtemp` directory per harness run, removed at the harness's end.
9. **`testing/fixtures/agent-activity/runtime-states.json` holds personal data.** Beyond the
   `/Users/juliusolsson` paths and private project names the issue lists, it held **queued prompts,
   drafts, prompt suggestions, sub-agent task descriptions and streaming baselines** (read in full,
   per q36).
   - **Fix:** same-length redaction, owned by `scripts/agent-activity-redaction-policy.ts`, which the
     extractor imports.
     - Text fields, and every `branch`, are filled with `x` at their own length.
     - The home user becomes a same-length placeholder.
     - Each distinct non-Agent-Code project becomes its **own** same-length placeholder (`p0---`,
       `p1-----`, …), including in object keys. The rest of a path under it is x-filled, keeping the
       separators.
   - **Review of #1353 (q70):** the first committed file had been touched up by hand, so it wasn't the
     script's output. The script also mapped same-length names to one placeholder, and it left branch
     names and worktree suffixes in place.
     - The file is now regenerated from the pre-redaction corpus in git history (`15e43abe^`) with the
       policy module, and is byte-identical to that regeneration.
     - `testing/unit/agentActivityRedactionPolicy.test.ts` pins distinct identities, filled paths and
       branches, the refusal of too-short names, and that the committed file is a fixed point of the
       policy.
     - Every surviving string field was audited by key.
   - **Steering q74:**
     - `--redact-from` now **requires** an explicit `--home-user`, checked before anything is read or
       written. Both modes also refuse to write output that still names a home directory other than
       the placeholder.
     - The public-name exemption is the exact `agent-code` segment, not `startsWith`, so sibling
       `agent-code-<task>` checkouts are redacted too.
     - Regenerating after that exposed a data-loss bug: an x-filled tail made same-length paths
       under one project the same object key, and entries merged. Each tail segment now gets its own
       placeholder, and the redactor refuses outright on any key collision.
     - Tests: `testing/unit/agentActivityRedactionPolicy.test.ts`, plus the process-level
       `testing/system/fixtures-privacy/agentActivityRedactFrom.system.test.ts`. Both fail on
       `2f930233`.
   - **Round-3 privacy review and steering q76/q78:**
     - The output guard accepts only the EXACT canonical `/Users/<placeholder>`. Every other home
       spelling refuses the file: lowercase, backslash, JSON-escaped, `%2F`, `~name`, a prefix of the
       placeholder.
     - A new SOURCE check, before redaction, requires every home to be the named recorder, so a
       foreign user spelled like the placeholder is caught.
     - The dash-encoded form (`-Users-<name>-…`) has no delimiter after the name. It is accepted only
       when a standard home folder follows the recorder and the source names that folder
       canonically; anything else refuses as ambiguous.
     - A bare `--redact-from` or an unknown flag exits before any read or write, instead of falling
       through to the live extraction.
     - **Stated limit:** an identifier with no path around it, in a field the policy doesn't treat as
       text, can't be recognised by any pattern. This corpus has none, and a regeneration from a
       different corpus needs its own per-key audit.
   - The fleet fixtures:
     - `startup` in live-fleet and `bringdown` in both are same-length placeholders.
     - Their `provenance` now says so.
     - **Titles are an OWNER CHOICE (steering q73), not redacted here.** Six titles are the owner's
       own prompt fragments: five in owner-fleet, one in live-fleet.
       - A = keep them verbatim, the fixtures' stated decision.
       - B = synthetic stand-ins of the same shape. B is prepared as a separate, unpushed commit.
     - This PR does not claim full personal-text redaction across all three fixtures.
   - The row model reads none of that text: the 32 agent-activity tests pass unchanged.
   - **Owner decision (not done here):** the original content remains in `main`'s git history.
     Removing it means rewriting `main`.

## Tests

Each fixed test is shown to pass on this machine. Item 1 was failing here before the fix: this Mac
has Homebrew CLIs.
