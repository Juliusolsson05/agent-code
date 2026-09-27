# View Prompts says an unreadable conversation, not "no prompts" (#1306)

Short plan: a bug with a known root cause (#1306, class C3, P3). Fixes #1306.

## Outcome
View Prompts on a conversation whose transcript or store is there but unreadable (damaged, or permission-broken) says "Couldn't read this conversation's prompts." instead of "no prompts". The issue asked to check every source: all five had the pattern.

## Root cause (verified in source, origin/main)
- **Pi** (`pi.ts`): `catch { return [] }` around resolution and branch reading. The package's resolution also skips a file whose header it cannot read, so an unreadable session reads as "no such session".
- **Grok** (`grok.ts`): `catch { return [] }` around the snapshot load.
- **Claude and Codex** read through `extractPromptsFromFile` (`promptFolder.ts`), which turned every stat and read failure into an empty answer.
- **OpenCode** (`opencode.ts`): a store that could not be opened answered `[]`.
- `ViewPromptsModal` showed the raw IPC message for a rejection (q22).

## Design (contract)
- **`ConversationPromptsUnreadable`** (`sources/types.ts`): a typed error with a fixed message and the cause.
- **The rule for every source:** no file (yet) answers `[]`, because a fresh session has no transcript and View Prompts then shows the live feed. A file or store that is there but unreadable throws.
  - `promptFolder` returns empty only for ENOENT/ENOTDIR, and rethrows anything else.
  - Pi checks whether a file named for the session exists but cannot be opened.
  - OpenCode throws only when `opencode.db` exists.
- **The service's `prompts`** logs the cause in main and rethrows. Search already catches per conversation, so an unreadable one degrades to label-only.
- **`ViewPromptsModal`** shows the fixed sentence.

## Tests (real files: the recorded conversation corpus, made unreadable with chmod)
- **`promptsUnreadable.system.test.ts`:** Claude, Codex, OpenCode (a non-database store) and Grok each throw the typed error, and a missing file is still `[]`.
- **`pi.system.test.ts`:** the same for Pi.
- **`service.system.test.ts`:** View Prompts rejects, and search still finds another conversation.
- **`ViewPromptsModal.renderer.test.tsx`:** fixed words, no IPC text.
- All red on main.

## Out of scope
- Discovery's own handling of unreadable files (it already counts them as `unreadable`).

## Steering q116: finding the file is part of the rule
- **The discovery step still mapped every failure to "not here".** That covered Claude's direct `stat` and the projects walk, Codex's rollout walk, and Pi's session listing, and it ran before the typed read handling, so a transient EACCES/EIO on a known conversation still read as "no prompts". Each now treats only ENOENT/ENOTDIR as absence and raises `ConversationPromptsUnreadable` for anything else.
- **The Codex and Pi packages swallow their own `readdir` errors.** They answer "none", so each source probes its root directories first: Codex's `sessions`, and Pi's sessions root and per-cwd directory. The packages are unchanged.
- **Tests (fail then recover, through `prompts()`):** an unlistable Claude project directory, then a successful read; an unlistable Codex sessions tree, then "no such thread" (a missing tree stays `[]`); an unlistable Pi session directory, then `[]`. All three are red on the previous head.
- **History:** the branch is rebuilt so its first commit holds only this plan (worker-common line 33).

## Review round 1 (a, b, c: FIX-BEFORE-MERGE), fixed fail-first

- a, b (major): unknown still read as `[]` one level down.
  - **Cause:** `existsSync` answers false for EACCES. That hit Codex's
    known and indexed rollouts and OpenCode's database in a locked
    directory.
  - **Codex:** its walk skipped a locked `sessions/YYYY/MM/DD`, and an
    index that is there but won't open, with no rollout found, gave `[]`.
  - **Pi:** a session named for the id with a damaged header gave `[]`.
  - **Grok:** a transcript without its `summary.json` gave `[]`.
  - **Claude/Codex:** a transcript whose every line is garbage gave `[]`.
  - Fixed in 0974c69b with `isPresent` and `assertTreeListable` (absent
    vs unknown), `TranscriptUnparseable` in the prompt folder, a Pi header
    parse check and a Grok sibling check. Six tests, all red on the
    previous head.
  - Also: an OpenCode query that fails after the open is typed, and a Grok
    read racing its writer retries twice.
- c (major, test gap): the Pi probe's "absent → `[]`" half. Pinned on a
  fresh home with no `.pi`.
- c (minor): ENOTDIR (a path through a plain file) is pinned as absence,
  and the service's cause log is asserted.
- c residuals, not changed:
  - the prompt folder's stat catch is unreachable through the sources;
  - the stat/read vanish race is untested;
  - the Codex and Pi package-walk catches are unreachable (the packages
    swallow their own errors, and the probes cover the real path);
  - the modal showing the error above "no prompts found" is pre-existing.
- b (minor), declined: an unrelated inaccessible Claude project aborts the
  fallback walk. That is the stated contract (unknown is never "no
  prompts"), and c judged it a design stance, not a defect.
