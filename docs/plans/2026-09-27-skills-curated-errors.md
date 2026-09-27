# Skills surfaces show curated errors, not raw filesystem text (#1427)

**Verified on origin/main `6dd23a49`.** Two real-filesystem tests reproduce the leak:
- **A read-only `.claude` folder:** the target row read `EACCES: permission denied, mkdir '<home>/.claude/skills'`.
- **A state file under a file:** the recovery banner read `…: ENOTDIR: not a directory, lstat '<path>/conventions.json'`.

The cause is `safeErrorMessage`, which returned `error.message` unchanged. Its copies lived in the service, `persistence`, `skillPathSafety` and `githubSkillSource`, and three more sites in `githubSkillSource` / `installedSkillMaterializer` passed `error.message` directly.

## Decision
One mapper, `userFacingError.ts` `userFacingSkillError(error, context)`, replaces all four copies and the three direct sites.

| Input | Shown |
|---|---|
| A Node system error (an errno `code` plus `syscall` or `errno`) | A fixed sentence per code: permissions, read-only, disk full, missing, in the way, busy, out of files, network. Any other code gets the generic sentence. |
| Any other `Error` whose message has no absolute path and is at most 300 characters | The message, **kept**: it is the service's own curated text (validation, product-skill conflicts) that users need. |
| Anything else (a path in the text, too long, not an Error) | The generic sentence. |

The raw error always goes to the main log whenever the text is rewritten (q22).

**Not changed:**
- Fields that carry a path **on purpose**: `recovery.stateFilePath` (the reveal action) and target `displayPath`. Only prose `message` fields are curated.
- #1424's fixed recovery-reset sentence stays as it is.

## Tests
- **System (`AgentCodeConventionsService.system.test.ts`):** the read-only skills folder and a state file whose parent is a file. Both are red on main; the pass-through mutant is red (2 failed).
- **Unit (`userFacingError.test.ts`):**
  - a real `rmdir` ENOENT is mapped and logged;
  - curated text is kept and not logged;
  - path-bearing (POSIX, `/private/var`, Windows) and oversized text is replaced;
  - an unknown errno and a non-Error value get the generic sentence;
  - a network errno.
- Every `agentCodeConventions` suite passes, and `npx tsc -b` prints 0 lines.

## Review round 1 (a, codex at `c8463b71`): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **a1, major:** the four Reveal handlers returned `shell.openPath`'s raw string (`Failed to open /Users/…`) | valid | **Fixed:** `revealFailureMessage` gives a fixed sentence and logs Electron's text. All four handlers are pinned in `recoveryReveal.test.ts`; red against the old handlers. |
| **a2, major:** unclassified git and fetch errors passed through, because the mapper kept ANY short message | valid | **Fixed at the source:** git's fallback, fetch, the YAML parse message (now "near line N") and `toJS` failures each get a fixed sentence with the raw error logged. **Fixed in the mapper:** only text from exactly a plain `Error` or the package's `GitHubSkillSourceError` can be kept. Child-process errors (`cmd` / `stderr`) and library subclasses (`TypeError`, `SyntaxError`, YAML) get the generic sentence, as does any multi-line text. |
| **a3, major:** the path filter missed `/tmp`, `~/`, `../`, quoted `/tmp` and `\\server` | valid | **Fixed:** `PATH_LIKE` catches all five, plus drive letters and `file://`. Every spelling is pinned. |
| **a4, minor:** IPC rejections shown via `cause.message` in the renderer; the YAML parser text | valid | **The YAML half is fixed here. The renderer half is filed as #1459:** it spans about 15 renderer catch sites, a separate surface, filed under the PR freeze. |
| **a survivors:** the git fallback, and logging only system errors | valid | **Pinned:** a real child-process failure drives the fallback, and every generic rewrite asserts its log. Both mutants red, as are "keep any Error" and "no child-process rule". |

**Why not an allowlist class for every throw:** marking all 67 plain `throw new Error` sites is a large diff the freeze rules out. The constructor rule has the same effect for library errors, and those throws are this package's own fixed text.
