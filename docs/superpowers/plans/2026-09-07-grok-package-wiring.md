# Grok package wiring — Task 1 of the grok provider plan

(Verbatim extract of the master plan task; master plan: `docs/superpowers/plans/2026-09-07-grok-code-provider.md` on `feat/grok-code-provider`.)

### Task 1: Bootstrap grok-code-headless repo + agent-code wiring

**Files:**
- Create: the new repo `Juliusolsson05/grok-code-headless` (skeleton below)
- Modify: `.gitmodules`, `package.json`, `tsconfig.node.json`, `tsconfig.web.json`, `electron.vite.config.ts`, `vitest.config.ts`
- Test: `src/providers/importBoundaries.test.ts` (auto-covers), `scripts/verify-submodule-checkouts.mjs` (auto-covers)

**Interfaces:** Produces: empty-but-green package compiled from source by the app's four resolvers, tracking-issue-linked PR.

- [ ] **Step 1: Worktree + plan-first commit**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code
git worktree add .worktrees/grok-package-wiring -b feat/grok-package-wiring origin/main
cd .worktrees/grok-package-wiring && git submodule update --init && ln -s ../../node_modules node_modules
mkdir -p docs/superpowers/plans
# copy Task 1 section verbatim → docs/superpowers/plans/2026-09-07-grok-package-wiring.md
git add docs/superpowers/plans/2026-09-07-grok-package-wiring.md && git commit -m "docs(grok): plan the grok-code-headless package wiring"
```

- [ ] **Step 2: Create the repo with the standard skeleton**

```bash
mkdir -p grok-code-headless && cd grok-code-headless && git init -b main
```
Author `package.json` with the exact script contract from `packages/claude-code-headless/package.json` (`build`, `typecheck`, `test`, `test:core`, `test:system`, `test:live`, `test:coverage`, `test:package`, `test:contract`, `check`, `upstream:check`), name `grok-code-headless`, deps `@xterm/headless ^5.5.0` + `chokidar ^5.0.0`, peerDep `node-pty ^1.0.0`, devDeps matching the sibling (vitest `^4.1.10` — the contract check pins major 4). `tsconfig.json` copied from `packages/codex-headless/tsconfig.json` (module ESNext, strict, outDir dist). `vitest.config.ts` with `core` (node) and `system` projects following the sibling's tier excludes. `LICENSE` (MIT, copyright Julius Olsson), `.gitignore` (node_modules/dist/coverage), `README.md` stating: drives the real Grok Build TUI in a PTY; session layout (`~/.grok/sessions/<encoded resolved cwd>/<uuid>/{summary.json,chat_history.jsonl,updates.jsonl}`); vendor source of truth `xai-org/grok-build`; vendored-shape fixtures policy. `src/index.ts` exporting nothing yet except a version constant; `src/grokVersion.ts`:

```ts
// WHY a version module before any real code: `test:package` in the standard
// contract needs a public entry point to verify, and the app's wiring PR needs
// something importable in all four resolvers. This is replaced by the real
// surface in Task 4.
export const GROK_HEADLESS_VERSION = '0.0.1'
```
One smoke test `src/grokVersion.test.ts` (`expect(GROK_HEADLESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)`). Commit `feat: bootstrap grok-code-headless package skeleton`. Then:

```bash
gh repo create Juliusolsson05/grok-code-headless --public --source . --push
```
Add `.github/workflows/ci.yml` calling the org's reusable package workflow exactly as `packages/codex-headless/.github/workflows/ci.yml` does (read it and mirror; branch protection on `package / quality-gate` per testing standard).

- [ ] **Step 3: Submodule + dependency wiring in agent-code**

```bash
cd .worktrees/grok-package-wiring
git submodule add https://github.com/Juliusolsson05/grok-code-headless.git packages/grok-code-headless
```
`package.json` dependencies (alphabetical, beside the other file: deps): `"grok-code-headless": "file:./packages/grok-code-headless"`.
`.gitmodules` gains the entry (git writes it).
`tsconfig.node.json`: add to `paths` —
```json
"grok-code-headless": ["./packages/grok-code-headless/src/index.ts"],
"grok-code-headless/*": ["./packages/grok-code-headless/src/*"],
```
and add `"packages/grok-code-headless/src/**/*"` to `include`. Mirror nothing in `tsconfig.web.json` paths (renderer must not import headless packages — same as siblings; web include list stays untouched).
`electron.vite.config.ts`: add to `headlessAlias`:
```ts
{ find: /^grok-code-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/grok-code-headless/src')}/$1` },
{ find: 'grok-code-headless', replacement: resolve(__dirname, 'packages/grok-code-headless/src/index.ts') },
```
and add `'grok-code-headless'` to `headlessExclude`.
`vitest.config.ts`: add the same two entries to `alias` (this map is hand-duplicated on purpose — see its header comment).

- [ ] **Step 4: Verify the four resolvers agree**

```bash
source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24
npm install
npm run submodules:check && npm run typecheck
NODE_ENV=test npx vitest run --project unit src/providers/importBoundaries.test.ts
```
Expected: typecheck exit 0; boundary test green (it scans `src/`, unaffected, but run it as the guard it is).

- [ ] **Step 5: Commit, push, PR**

```bash
git add .gitmodules package.json package-lock.json tsconfig.node.json electron.vite.config.ts vitest.config.ts
git commit -m "feat(grok): add grok-code-headless submodule and resolver wiring"
git push -u origin feat/grok-package-wiring
gh pr create --title "feat(grok): add grok-code-headless submodule and resolver wiring" --body "Task 1 of the grok provider plan. Skeleton package compiled from source in all resolvers. Refs #<issue>."
```
CHECKPOINT: merge on explicit confirmation only.

---

