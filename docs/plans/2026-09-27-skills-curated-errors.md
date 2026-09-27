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

## Review round 1, b (codex at `c8463b71`, the pre-fix head): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **b1 + b3, major:** skillPathSafety's symlink and not-a-directory errors put the path in the message. A root-level `/tmp` was shown as is; a longer path lost the reason to the generic sentence. | valid | The messages are path-free and specific ("A folder on the skill path is a symbolic link, which Agent Code does not follow." / "A file is in the way where a folder on the skill path should be."). The path rides on `error.path`, which the mapper logs. Real-filesystem symlink test; red at `5d5e8c8d`. |
| **b2, major:** fetch's `TypeError('fetch failed')` was kept raw, with no log | valid (already fixed in `5d5e8c8d`) | Pinned: a Node-shaped fetch rejection gets the fixed sentence and its cause is logged. The raw-message mutant is red. |
| **b4, minor:** errno sentences named "skill" locations for state-file failures | valid | Every sentence is location-neutral (the row says where), and the generic one too. Each code is pinned to its exact words; b's ENOTDIR→ENOENT mutant is red. |
| **b5, minor:** classified git failures dropped the raw error from the log | valid | `classifyGitHubSkillSourceError` logs the raw error once for every branch. Test red at `5d5e8c8d`. |

## Review round 1, c (codex at `356c14b8`): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **c1, major:** a bracketed path (`Provider failed [/Users/…]`) was kept, because `[` was not a listed delimiter | valid | `PATH_LIKE` treats ANY non-word character before the slash as a path start (bracket, brace, angle, comma and semicolon forms pinned). Prose with a letter before the slash (`and/or`, `file/folder`) and relative package paths are pinned as kept. The old-regex mutant is red. |
| **c2, minor:** the logging of some rewrites was unpinned (suppressing it for ENOTDIR, or for TypeError, passed) | valid | Every errno code in the table and the TypeError case assert the raw error is logged, and the ENOTDIR system test asserts its log. Both mutants red. |
| **c3, minor:** the per-code table was only partly pinned (EDQUOT → the network sentence passed) | valid | All 18 codes are pinned to their exact sentences; the mutant is red. |

c also confirmed both #1427 system tests fail on origin/main for the stated reason.

## Review round 2 (the final round), c (codex at `a037caff`): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **c1, major:** a period before an absolute path (`failed./var/…`) was kept, because `.` and `-` counted as word characters | valid | `PATH_LIKE` is blunt: a `/`, `./` or `../` after anything that is not a letter, digit or `_` is a path start, whatever follows (`/]` too). A spaced ` / ` in prose is rewritten, which fails closed; no curated message has one. Red at `a037caff`. |
| **c2, minor:** the 60 s fetch abort logged nothing | valid | The AbortError is logged before the fixed sentence. Fake-timer test, red at `a037caff`. |
| **c3, minor:** the YAML parser branch logged nothing | valid | The parser's first error is logged. Red at `a037caff`. |
| **c4, minor:** the file-in-the-way reason had no test | valid | A real-filesystem test (a file where `.agents` should be); the path-in-message mutant is red. |

## Review round 2, a and b (codex at `a037caff`)

| Finding | Verdict | Change |
|---|---|---|
| a1 / b1 / b2: the YAML parse and fetch-timeout rewrites were not logged; b's "remove the timeout branch" survivor | valid, **already fixed** in `ad031252` (c2, c3) | Both log. The fake-timer test asserts the timeout sentence, so deleting the branch is red. |
| **a2 / b1, minor:** the YAML line number never appeared (`linePos` is unset with prettyErrors off) | valid | The line is computed from the error's offset (the frontmatter starts on file line 2). Tests now REQUIRE `near line 3` for a broken flow sequence and for a duplicate key; the old `linePos` mutant is red. |
| **a3, minor:** a foreign class NAMED GitHubSkillSourceError passed the own-text check | valid | By identity: a plain `Error`, or `instanceof GitHubSkillSourceError`. The mapper can import it now, because githubSkillSource no longer imports the mapper, so there is no cycle. A foreign same-name class gets the generic sentence and is logged. |
| a / b survivor: the FILE_COMPONENT wording | valid, **already fixed** in `ad031252` (c4) | A real-filesystem test pins it. |
