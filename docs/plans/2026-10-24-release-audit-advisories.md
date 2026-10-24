# Unblock release builds: clear new dependency advisories (#1532)

Short plan. The shape is known: the production audit gate (`npm run audit:production`, `--audit-level=high`) fails on advisories published after 2026-09-28; every preview since then stops there, and a stable release would too. Same class as #965.

## Outcome
`npm audit --omit=dev --audit-level=high` passes on the branch, so `build-app` gets past the audit step and the preview and release workflows can publish again.

## Change
- `package.json`: raise the floors of the two direct dependencies to their fixed releases, inside their current majors: `@modelcontextprotocol/sdk` to `^1.32.2`, `zod` to `^4.6.7`.
- `package-lock.json`: refreshed with `npm audit fix --package-lock-only`, which moves the transitive ones (`proxy-addr`, `body-parser`, `fast-uri`, `hono`, `ip-address`, and the voice-dictation package's `vitest`) to their fixed versions. No `--force`, no semver-major moves.

## Tests
No new tests: there is no behaviour to pin. The contract is the existing suite plus the audit gate, run by CI on the PR. Behaviour risk sits in the MCP SDK minor bump (1.29 → 1.32), which the existing MCP and workflow-mcp tests exercise.

## Verification boundary
Locally: `npm audit --omit=dev --audit-level=high` on the refreshed lockfile. Full typecheck, tests and the macOS build run in CI on the PR. No packaged-app launch here; the preview build after merge is the first packaged run.

## Out of scope
Cutting the release itself (version bump and `release.yml` dispatch follow the merge, per RELEASE.md), and any audit-policy change.
