# GitHub CLI auth for extension installs — implementation plan

Implements #982. Worktree `.worktrees/feat-install-gh-cli-auth`, branch `feat/install-gh-cli-auth`, from `origin/main` (includes #981's rate-limit diagnosis).

## Design

- **Credential resolution** (`src/main/extensions/githubCli.ts`, new): `resolveGitHubCliToken()` spawns `gh auth token` (no shell, 5 s timeout, `windowsHide`), reads stdout, accepts only a single non-empty token ≤ 4096 chars. Every failure — not installed (`ENOENT`), non-zero exit, timeout, garbage output — returns `null`; resolution can never throw and never fails an install. `execFile` is dependency-injected (same pattern as `ConsentPrompt`) so the unit tests exercise the real code with a fake runner.
- **Header construction**: pure `githubApiHeaders(token)` adds `authorization: Bearer …` only when a token exists; `accept`/`user-agent` unchanged.
- **Wiring** (`install.ts`): `installExtension(repo, promptConsent?, options?: { githubCliAuth?: boolean })` resolves the token once (skipped when the option is explicitly false) and threads it into `resolveSource`. An `apiGet` helper retries once without the header on 401 — a rotated/revoked gh login degrades to anonymous instead of failing. The codeload tarball path stays unauthenticated (out of scope per #982).
- **Setting**: renderer-owned (the one settings authority), `Settings.extensionsGithubCliAuth: boolean`, default **true**, a standard `toggle` row in the `apps` (Extensions) settings category. It rides the install IPC as an explicit parameter — `extensionsInstall(repo, useGithubCliAuth?)` — so main keeps no second settings store, exactly like `ConsentPrompt` keeps install pure.
- **Token hygiene** (hard rules, commented in code): main-process memory only, lives solely inside the two `api.github.com` requests, never logged (error paths stringify URLs, not headers), never persisted, never crosses IPC.

## Tasks

- [x] `githubCli.test.ts`: DI-runner tests — success trims; ENOENT → null; non-zero exit → null; timeout error → null; empty/garbage/oversized/multi-line output → null; never throws
- [x] `githubCli.test.ts`: `githubApiHeaders` with/without token (lives beside the resolver, not in `install.test.ts`)
- [x] Implement `githubCli.ts`; thread through `install.ts` (options param, token resolve, `apiGet` 401 retry)
- [x] IPC + preload parameter passthrough
- [x] Settings type + default + registry toggle row
- [x] INTEGRATION (added per review instinct): `githubCli.system.test.ts` runs the real default runner against the machine's gh; `install.githubAuth.system.test.ts` drives the real installExtension with stubbed network asserting the bearer header reaches both api.github.com calls, the per-endpoint 401→anonymous retry, disabled ⇒ resolver never called, and null-credential ⇒ anonymous; `githubAuth.live.test.ts` (live tier, opt-in) proves the whole chain against the real API — `x-ratelimit-limit: 5000` is the proof the credential was accepted
- [x] `npx tsc -b` + targeted vitest green (44/44 + live pass)
- [ ] PR → 3 internal review agents → resolve → merge (pre-authorized)

## Verification

`NODE_ENV=test npx vitest run src/main/extensions/install.test.ts src/main/extensions/githubCli.test.ts`, `npx tsc -b`, plus manual smoke of the settings toggle existence via typecheck.
