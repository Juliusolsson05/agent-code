# Unblock release builds: clear new dependency advisories (#1532)

Short plan. The shape is known: the production audit gate (`npm run audit:production`, `--audit-level=high`) fails on advisories published after 2026-09-28; every preview since then stops there, and a stable release would too. Same class as #965.

## Outcome
`npm audit --omit=dev --audit-level=high` passes on the branch, so `build-app` gets past the audit step and the preview and release workflows can publish again.

## Change
- `package.json`: raise the floors of the two direct dependencies to their fixed releases, inside their current majors: `@modelcontextprotocol/sdk` to `^1.32.2`, `zod` to `^4.6.7`.
- `packages/workflow-mcp` submodule: moved to Juliusolsson05/workflow-mcp#83, which raises that package's own exact pins (MCP SDK 1.30.0 → 1.32.2, zod 4.6.5 → 4.6.7, fast-uri override → 3.1.9). The root bump alone left two highs from those nested pins.
- `package-lock.json`: targeted `npm update` of only the affected packages: `@modelcontextprotocol/sdk`, `zod`, `body-parser`, `proxy-addr`, `fast-uri`, `hono`, `ip-address` (plus `qs` and `content-type`, which follow body-parser). No majors.

## Tests
No new tests: there is no behaviour to pin. The contract is the existing suite plus the audit gate, run by CI on the PR. Behaviour risk sits in the MCP SDK minor bump (1.29 → 1.32), which the existing MCP and workflow-mcp tests exercise.

## Verification boundary
Locally: `npm audit --omit=dev --audit-level=high` on the refreshed lockfile. Full typecheck, tests and the macOS build run in CI on the PR. No packaged-app launch here; the preview build after merge is the first packaged run.

## Out of scope
Cutting the release itself (version bump and `release.yml` dispatch follow the merge, per RELEASE.md), and any audit-policy change.

## Rulings
- Ruling: targeted `npm update` instead of `npm audit fix`. `audit fix` also pulled Electron 43.7 → 43.8, which touches native modules and isn't needed to clear the gate. Cost if wrong: none; Electron can move in its own PR.
- Ruling: keep the five dev-only optional wasm entries (`@emnapi/*`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`, Tailwind's wasm32 fallback) that local npm 11.11 prunes. Restored unchanged so the lockfile diff is only the security fix. Cost if wrong: CI's `npm ci` reports drift, and we regenerate with CI's npm.
- Ruling: the voice-dictation `vitest`/`@vitest/*` advisories stay. They're moderate and under the gate's `high` threshold, and they live in another submodule. Cost if wrong: none for release; a follow-up in that repo.
