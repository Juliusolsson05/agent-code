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
