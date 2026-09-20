# Fix: opaque "GitHub returned 403" when the anonymous API rate limit is exhausted

Fixes #980. Worktree: `.worktrees/fix-install-rate-limit-403`, branch `fix/extension-install-rate-limit-403`, based on `origin/main`.

## Root cause (verified, not assumed)

`resolveSource` in `src/main/extensions/install.ts` makes two unauthenticated
`api.github.com` requests per install attempt. GitHub's anonymous quota is
60/hour per IP; once exhausted every call returns 403 with
`x-ratelimit-remaining: 0`. The installer surfaces the status verbatim, and the
releases/latest probe swallows its 403 and falls through, burning a second
doomed request. Verified live: repo exists, quota exhausted.

Rejected alternative (tested): codeload `tar.gz/refs/heads/HEAD` → 404, so the
default-branch path cannot drop the API.

## Change

1. Add a pure, exported helper `githubApiFailure(res: Response, repo: string): InstallError`
   in `install.ts`:
   - 403 + `x-ratelimit-remaining: 0` → message naming the rate limit, the
     reset time from `x-ratelimit-reset` (epoch seconds, rendered locally,
     omitted when absent/garbage), and the "Load extension from folder" escape
     hatch.
   - 403 otherwise → distinct non-rate-limit 403 message.
   - Any other status → existing `GitHub returned <status> for <repo>.`
2. Use it for the repo-metadata call (replacing the bare `!res.ok` throw).
3. In the releases/latest probe, a rate-limited 403 now throws the same
   diagnosis immediately instead of silently falling through (a 404 or other
   status still falls through exactly as before — repos without releases are
   normal).
4. Tests in `install.test.ts` follow that file's network-free philosophy:
   construct real `Response` objects with headers, assert message content for
   the rate-limited/other-403/other-status cases and the reset-time rendering.

Explicitly out of scope (follow-up candidates recorded in #980): release-tag
resolution via the `github.com/.../releases/latest` redirect; authenticated
requests.

## Verification

`NODE_ENV=test npx vitest run src/main/extensions/install.test.ts` plus
`npm run typecheck` in the worktree.
