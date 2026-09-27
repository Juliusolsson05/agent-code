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
