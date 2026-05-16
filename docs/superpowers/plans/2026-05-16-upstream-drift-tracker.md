# Upstream Drift Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when Claude Code / Codex publish a release newer than the version a repo has explicitly accepted as supported, and open a humble maintenance issue so a human/agent runs a compatibility pass before the supported version is bumped.

**Architecture:** Each repo owns its own watcher — a checked-in support file (`support/upstream-versions.json`) records the accepted upstream version; a scheduled GitHub Actions workflow runs a small Node script that compares the npm `latest` dist-tag against it; a bash step reconciles exactly one rolling maintenance issue per provider via `gh`. No cross-repo writes, no PAT, no GitHub App, no changelog parsing, no severity inference. The bot only detects drift and opens structured work; it never edits runtime code and never bumps the accepted version.

**Tech Stack:** GitHub Actions (`schedule` + `workflow_dispatch`), Node 20 (built-in `fetch`, no dependencies), `gh` CLI, `jq` — all preinstalled on `ubuntu-latest`.

---

## Why it is shaped this way (read before touching code)

These decisions are load-bearing. Changing them re-introduces a failure the design exists to avoid.

- **Deliberately dumb.** The automation answers one question per provider: *"is npm's `latest` newer than the version this repo accepted?"* It does **not** read changelogs, guess affected code paths, or rank severity. Inferring meaning from release notes is unreliable and gives false confidence; a human/agent does the compatibility judgement. An earlier draft proposed keyword-scanning release notes — that was rejected for exactly this reason.
- **Trigger on the npm `latest` dist-tag, not GitHub release tags.** Codex tags GitHub releases as `rust-v0.131.0-alpha.22` — dozens of pre-releases per day. Polling those would spam. Claude Code also ships GitHub releases ~daily. npm's `latest` dist-tag is the curated stable line for both packages and is the only low-noise machine signal. GitHub Releases / changelog URLs are used **only** as the human-readable link inside the issue body.
- **Per-repo watchers, not one orchestrator.** `GITHUB_TOKEN` can only write issues in its own repo. Cross-repo issue creation needs a PAT (expires → detector silently dies) or a GitHub App (more setup, another moving part). The whole point of this system is reliability, so each repo watches its own upstream with its own scoped `GITHUB_TOKEN`. The cost is that one ~70-line script is copied into three repos; that copy is byte-identical and rarely changes — acceptable, and more reliable than a shared secret. (A shared dependency is impossible anyway: the headless packages are pinned submodules of agent-code, so depending on an agent-code-hosted script would be circular.)
- **One rolling issue per provider, updated — never one issue per release.** Claude Code releases roughly daily. A fresh issue per version would bury the repo. The workflow finds the existing open tracker by its labels and edits it in place. Idempotency key = the label pair (`upstream-update` + `provider:<key>`), which is structured and reliable, unlike full-text body search.
- **The bot closes its own issue when drift resolves.** When a human merges the PR that bumps `accepted`, the next run sees no drift and closes the open tracker with a comment. This is deterministic, not "smart" — it is the inverse of the open condition.
- **`agent-transcript-parser` gets no watcher.** A version number cannot tell you the transcript JSONL / Codex rollout shape changed — that is a human judgement made while reading release notes. The acceptance checklist in the headless-package issues carries an explicit "file an issue in `agent-transcript-parser` if transcript shape changed" line instead. Adding a version watcher there would only emit noise that repo cannot act on.
- **Registry failure fails the run red, it does not open a bogus issue.** If npm is unreachable the script exits non-zero; the Actions run goes red and a human looks. It never falls through to a false "in sync".

## Repos touched

This is one coherent feature, but it lands in three separate git repositories (the headless packages are submodules with their own GitHub repos and their own Actions). Each repo therefore gets its own branch and its own PR — that is a hard repo boundary, not a discretionary split.

| Repo | Watches | Issue opened in |
|---|---|---|
| `agent-code` | Claude Code **and** Codex (integration level) | `agent-code` |
| `claude-code-headless` (`packages/claude-code-headless`) | Claude Code | `claude-code-headless` |
| `codex-headless` (`packages/codex-headless`) | Codex | `codex-headless` |

The three repos receive **byte-identical** copies of `scripts/check-upstream.mjs`, `.github/scripts/sync-upstream-issues.sh`, and `.github/workflows/upstream-watch.yml`. Only `support/upstream-versions.json` differs (which providers it lists). Part A defines every file in full; Parts B and C copy them verbatim and only swap the support file.

## GitHub Actions constraints (known, accepted)

- Scheduled workflows run only on the **default branch** (`main`). The `schedule:` trigger therefore does nothing until the workflow file is merged. This is why per-task verification leans on running the Node script **locally** (fully exercisable pre-merge) and a post-merge `gh workflow run` smoke test.
- Scheduled workflows are auto-disabled after 60 days of repo inactivity and never run on forks. Both repos are active; not a concern today. Noted so a future reader is not surprised.

---

## Part A — agent-code

Work on a branch in a worktree (`.worktrees/upstream-drift-tracker`), main checkout stays on `main`. All paths below are relative to the agent-code repo root.

### Task A1: Support file + acceptance docs

**Files:**
- Create: `support/upstream-versions.json`
- Create: `support/README.md`

- [ ] **Step 1: Create the support file**

This is the source of truth for which upstream versions agent-code has accepted. The `accepted` values are placeholders here — Step 3 of Task A5 replaces them with the real current `latest` so the repo starts in sync.

Create `support/upstream-versions.json`:

```json
{
  "_comment": "Source of truth for the upstream CLI versions this repo has explicitly accepted as supported. The upstream-watch workflow compares npm's `latest` dist-tag against `accepted`; a human bumps `accepted` only after a compatibility review. Never edited by automation. See support/README.md.",
  "providers": {
    "claude": {
      "label": "Claude Code",
      "pkg": "@anthropic-ai/claude-code",
      "changelog": "https://github.com/anthropics/claude-code/releases",
      "accepted": "0.0.0",
      "checkedAt": "2026-05-16"
    },
    "codex": {
      "label": "Codex",
      "pkg": "@openai/codex",
      "changelog": "https://github.com/openai/codex/releases",
      "accepted": "0.0.0",
      "checkedAt": "2026-05-16"
    }
  }
}
```

- [ ] **Step 2: Create the support README**

Create `support/README.md`:

```markdown
# Upstream version support

`upstream-versions.json` records the Claude Code / Codex CLI versions
this repo has **explicitly accepted as supported** — meaning a human or
agent has reviewed the upstream release and confirmed this repo still
works against it.

## How drift is detected

`.github/workflows/upstream-watch.yml` runs daily. It calls
`scripts/check-upstream.mjs`, which fetches npm's `latest` dist-tag for
each package and compares it to `accepted`. If `latest` is newer, the
workflow opens (or updates) one rolling maintenance issue per provider.

The automation **only detects drift**. It never reads changelogs,
guesses what broke, or edits this file. An open drift issue does not
imply a known breakage — it only means upstream moved.

## How to accept a new version

1. Read the upstream release notes linked in the drift issue.
2. Work through the issue's acceptance checklist (runtime smoke test,
   transcript/session paths, parsers, fixtures).
3. If the transcript or rollout JSONL shape changed, file an issue in
   `agent-transcript-parser`.
4. Bump `accepted` (and `checkedAt`) for that provider in a PR.
5. On the next run the bot sees no drift and closes the issue.

Bumping `accepted` is a deliberate human act. Do not bump it to silence
the bot without doing the review.
```

- [ ] **Step 3: Commit**

```bash
git add support/upstream-versions.json support/README.md
git commit -m "chore(upstream): add accepted-version support file + docs"
```

### Task A2: Drift detection script

**Files:**
- Create: `scripts/check-upstream.mjs`
- Modify: `package.json` (add one script entry)

- [ ] **Step 1: Create the detection script**

Create `scripts/check-upstream.mjs`:

```javascript
// Upstream drift detector.
//
// Deliberately dumb: it answers exactly one question per provider —
// "is the version on npm's `latest` dist-tag newer than the version
// this repo has explicitly accepted as supported in
// support/upstream-versions.json?"
//
// It does NOT read changelogs, guess affected code, or rank severity.
// Inferring meaning from release notes is unreliable and gives false
// confidence; a human/agent does the compatibility pass. See
// docs/superpowers/plans/2026-05-16-upstream-drift-tracker.md and
// support/README.md for the full rationale.
//
// Output: machine-readable JSON to stdout, a human summary to stderr,
// and (under GitHub Actions) a `result=<json>` line to $GITHUB_OUTPUT
// so the workflow can branch on it. Exit 0 = ran fine (drift is a
// signal, not an error). Exit 1 = the registry was unreachable or
// returned junk — fail the run red rather than emit a false "in sync".

import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// support/upstream-versions.json sits one directory up from scripts/.
// This layout is identical in all three repos that carry this script,
// so the relative resolve is portable.
const SUPPORT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'support',
  'upstream-versions.json',
)

// Parse "2.1.143" / "v2.1.143" / "0.131.0-alpha.2" into a comparable
// [major, minor, patch] tuple. The prerelease suffix is intentionally
// dropped: npm's `latest` dist-tag points at a stable release by
// convention, but stripping the suffix keeps the comparison total even
// if a prerelease ever lands on `latest`. A non-numeric segment
// becomes 0 so a malformed version sorts low instead of throwing.
function core(version) {
  const [release] = String(version).trim().replace(/^v/, '').split('-')
  const parts = release.split('.').map(n => Number.parseInt(n, 10))
  return [0, 1, 2].map(i => (Number.isFinite(parts[i]) ? parts[i] : 0))
}

// True when `a` is strictly newer than `b`.
function isNewer(a, b) {
  const ca = core(a)
  const cb = core(b)
  for (let i = 0; i < 3; i += 1) {
    if (ca[i] > cb[i]) return true
    if (ca[i] < cb[i]) return false
  }
  return false
}

// Fetch npm's ABBREVIATED registry metadata. The
// `application/vnd.npm.install-v1+json` Accept header returns the small
// abbreviated document — it still carries `dist-tags`, so we get
// `latest` without downloading the full registry doc (which contains
// every version ever published and is multiple MB for these packages).
async function fetchLatest(pkg) {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${pkg}`)
  }
  const body = await res.json()
  const latest = body['dist-tags']?.latest
  if (typeof latest !== 'string' || latest.length === 0) {
    throw new Error(`no dist-tags.latest for ${pkg}`)
  }
  return latest
}

async function main() {
  const support = JSON.parse(await readFile(SUPPORT_FILE, 'utf8'))
  const results = []

  for (const [provider, entry] of Object.entries(support.providers)) {
    const latest = await fetchLatest(entry.pkg)
    results.push({
      provider,
      label: entry.label,
      pkg: entry.pkg,
      accepted: entry.accepted,
      latest,
      drift: isNewer(latest, entry.accepted),
      changelog: entry.changelog,
    })
  }

  // Human summary to stderr so stdout stays pure JSON.
  for (const r of results) {
    process.stderr.write(
      `${r.label}: accepted ${r.accepted}, latest ${r.latest} — ` +
        `${r.drift ? 'DRIFT' : 'in sync'}\n`,
    )
  }

  const json = JSON.stringify({ results })
  process.stdout.write(`${json}\n`)

  // GitHub Actions exposes a per-step output file via $GITHUB_OUTPUT.
  // Absent when run locally — that is fine, the JSON is also on stdout.
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `result=${json}\n`)
  }
}

main().catch(err => {
  process.stderr.write(`upstream check failed: ${err.message}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Register an `upstream:check` npm script**

In `package.json`, inside the `"scripts"` object, add an `upstream:check` entry next to the existing `runtime:verify` line so a developer can run the same comparison locally (mirrors the existing `runtime:*` convention). The line to add:

```json
    "upstream:check": "node scripts/check-upstream.mjs",
```

Place it immediately after the `"runtime:verify": "...",` entry. Do not change any other script.

- [ ] **Step 3: Run the script locally to verify it works**

Run: `node scripts/check-upstream.mjs`

Expected: a stderr summary line for each provider and a single JSON object on stdout. Because `accepted` is still `0.0.0`, both providers report `DRIFT` and the JSON shows `"drift":true`. Example stderr:

```
Claude Code: accepted 0.0.0, latest 2.1.143 — DRIFT
Codex: accepted 0.0.0, latest 0.131.0 — DRIFT
```

If it exits non-zero with `upstream check failed:`, npm was unreachable — retry; do not proceed until it succeeds.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-upstream.mjs package.json
git commit -m "chore(upstream): add npm dist-tag drift detection script"
```

### Task A3: Issue reconciliation script

**Files:**
- Create: `.github/scripts/sync-upstream-issues.sh`

- [ ] **Step 1: Create the sync script**

Create `.github/scripts/sync-upstream-issues.sh`:

```bash
#!/usr/bin/env bash
# Reconcile one rolling maintenance issue per provider from the drift
# result JSON in $RESULT (produced by scripts/check-upstream.mjs).
#
# Idempotent: the existing tracker is found by its label pair
# (upstream-update + provider:<key>), so repeated cron runs edit the
# same issue instead of opening duplicates. Claude Code ships ~daily —
# a fresh issue per release would bury the repo.
#
# This script only opens / updates / closes issues. It never edits
# runtime code and never touches support/upstream-versions.json — that
# bump is a deliberate human PR after a compatibility review.
set -euo pipefail

# Ensure the two generic labels exist. --force is create-or-update, so
# this is safe against a repo that has never seen these labels.
gh label create upstream-update --color FBCA04 \
  --description "Upstream CLI moved; needs a compatibility pass" --force
gh label create maintenance --color 0E8A16 \
  --description "Maintenance work" --force

echo "$RESULT" | jq -c '.results[]' | while read -r row; do
  provider=$(jq -r '.provider'   <<<"$row")
  label_name=$(jq -r '.label'    <<<"$row")
  pkg=$(jq -r '.pkg'             <<<"$row")
  accepted=$(jq -r '.accepted'   <<<"$row")
  latest=$(jq -r '.latest'       <<<"$row")
  drift=$(jq -r '.drift'         <<<"$row")
  changelog=$(jq -r '.changelog' <<<"$row")

  # Per-provider label, created only for providers this repo watches.
  gh label create "provider:${provider}" --color 6F42C1 \
    --description "Affects ${label_name} integration" --force

  marker="<!-- upstream-watch:${provider} -->"
  title="chore(upstream): ${label_name} ${latest} is newer than accepted ${accepted}"

  # The tracker is keyed by its labels — structured and reliable,
  # unlike full-text body search. There is at most one open tracker
  # per provider by construction.
  existing=$(gh issue list --state open \
    --label upstream-update --label "provider:${provider}" \
    --json number --jq '.[0].number // empty')

  if [ "$drift" = "true" ]; then
    body=$(cat <<EOF
${marker}

## Upstream version detected

| | |
|---|---|
| Provider | ${label_name} |
| npm package | \`${pkg}\` |
| Accepted (supported) version | \`${accepted}\` |
| Latest upstream version | \`${latest}\` |

Release notes / changelog: ${changelog}

## What this issue means

Upstream moved. **This is not a known breakage.** It only means a newer
${label_name} release exists than the version this repo has explicitly
accepted in \`support/upstream-versions.json\`.

A human or agent must read the upstream release notes and verify this
repo still works against the new version. **Do not bump the accepted
version until that review is done.**

## Acceptance checklist

- [ ] Upstream release notes reviewed
- [ ] Headless runtime still starts and attaches
- [ ] Transcript / session-list paths still parse
- [ ] Screen / condition parsers still behave
- [ ] Existing fixtures / verification scripts still pass
- [ ] If transcript or rollout JSONL shape changed, an issue was filed in \`agent-transcript-parser\`
- [ ] \`support/upstream-versions.json\` bumped to \`${latest}\` in a PR

_Maintained automatically by \`.github/workflows/upstream-watch.yml\`. The bot keeps this issue current as upstream moves and closes it once the accepted version catches up._
EOF
)
    if [ -n "$existing" ]; then
      gh issue edit "$existing" --title "$title" --body "$body"
      echo "Updated #${existing} for ${provider} (latest ${latest})"
    else
      gh issue create --title "$title" --body "$body" \
        --label upstream-update --label maintenance --label "provider:${provider}"
      echo "Opened tracker for ${provider} (latest ${latest})"
    fi
  else
    # No drift. If a tracker is still open, a human merged the bump PR
    # and the accepted version has caught up — close it.
    if [ -n "$existing" ]; then
      gh issue close "$existing" \
        --comment "Accepted version is now \`${accepted}\`, in sync with upstream \`${latest}\`. Closed automatically."
      echo "Closed #${existing} for ${provider} — drift resolved"
    else
      echo "${provider}: in sync (accepted ${accepted}, latest ${latest})"
    fi
  fi
done
```

- [ ] **Step 2: Make the script executable**

```bash
chmod +x .github/scripts/sync-upstream-issues.sh
```

- [ ] **Step 3: Syntax-check the script (no network, no `gh` calls made)**

Run: `bash -n .github/scripts/sync-upstream-issues.sh`
Expected: no output, exit 0. This only parses the script; it does not execute it. Full execution is exercised post-merge in Task A5 Step 6.

- [ ] **Step 4: Commit**

```bash
git add .github/scripts/sync-upstream-issues.sh
git commit -m "chore(upstream): add maintenance-issue reconciliation script"
```

### Task A4: Scheduled workflow

**Files:**
- Create: `.github/workflows/upstream-watch.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/upstream-watch.yml`:

```yaml
name: Upstream drift watch

# Detects when Claude Code / Codex publish a release newer than the
# version this repo has explicitly accepted in
# support/upstream-versions.json, and opens a maintenance issue.
#
# It ONLY detects drift. It never edits runtime code and never bumps
# the accepted version — that is a human PR after a compatibility pass.
# See docs/superpowers/plans/2026-05-16-upstream-drift-tracker.md.

on:
  schedule:
    # Daily at 06:17 UTC. Claude Code ships ~daily, so daily polling is
    # the right cadence. Off-the-hour to dodge cron congestion on the
    # hour. Scheduled workflows run on the default branch only — this
    # trigger does nothing until the file is merged to main.
    - cron: '17 6 * * *'
  workflow_dispatch: {}

# Scoped to exactly what is needed: read the checkout, write issues in
# THIS repo. No cross-repo scope — each repo watches its own upstream
# with its own GITHUB_TOKEN, so there is no PAT or GitHub App that can
# silently expire and kill the detector.
permissions:
  contents: read
  issues: write

# A slow run must never overlap the next scheduled run.
concurrency:
  group: upstream-watch
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Detect upstream drift
        id: detect
        run: node scripts/check-upstream.mjs

      - name: Sync maintenance issues
        env:
          GH_TOKEN: ${{ github.token }}
          RESULT: ${{ steps.detect.outputs.result }}
        run: bash .github/scripts/sync-upstream-issues.sh
```

- [ ] **Step 2: Validate the YAML parses**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/upstream-watch.yml','utf8');if(!s.includes('upstream-watch'))process.exit(1);console.log('workflow file present, '+s.split('\n').length+' lines')"`
Expected: prints `workflow file present, NN lines`, exit 0. (A full schema check happens when GitHub ingests the file after merge.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/upstream-watch.yml
git commit -m "chore(upstream): add daily drift-watch workflow"
```

### Task A5: Seed accepted versions, verify, open PR

**Files:**
- Modify: `support/upstream-versions.json` (replace placeholder `accepted` values)

- [ ] **Step 1: Verify the no-drift / drift branches of the detector**

The detector logic must be confirmed both ways before merge (the workflow's issue step can only be fully exercised post-merge — see Step 6).

Run: `node scripts/check-upstream.mjs`
Note the `latest` value printed for each provider in the stderr summary — these are the real current upstream versions.

- [ ] **Step 2: Seed `accepted` with the real current versions**

Edit `support/upstream-versions.json`: replace each provider's `"accepted": "0.0.0"` with the `latest` value observed in Step 1, and set `checkedAt` to today's date (`2026-05-16`). The repo starts honestly in sync — agent-code *is* currently built against the current upstream.

- [ ] **Step 3: Re-run to confirm the no-drift branch**

Run: `node scripts/check-upstream.mjs`
Expected: every provider now reports `in sync` on stderr and the stdout JSON shows `"drift":false` for all of them.

- [ ] **Step 4: Confirm the drift branch still fires**

Temporarily edit one provider's `accepted` to an obviously old value (e.g. `1.0.0`), run `node scripts/check-upstream.mjs`, and confirm that provider reports `DRIFT` again. Then **revert** that edit so the file holds the real current versions from Step 2.

- [ ] **Step 5: Commit and open the PR**

```bash
git add support/upstream-versions.json
git commit -m "chore(upstream): seed accepted versions to current upstream"
```

Then push the branch and open a PR against `main`. Ensure the active `gh` account is `Juliusolsson05` before running any `gh pr` command. Do **not** merge the PR — open it and stop.

- [ ] **Step 6: Post-merge smoke test (after the PR is merged by the maintainer)**

Once the workflow file is on `main`, trigger it manually and confirm end to end:

```bash
gh workflow run upstream-watch.yml
gh run watch
```

Expected: the run is green. Because `accepted` was seeded to current in Step 2, no issue is opened (or, if upstream moved since merge, exactly one rolling issue per drifting provider appears with the `upstream-update` + `provider:<key>` labels). Re-running the workflow must **not** create a second issue for the same provider.

---

## Part B — claude-code-headless

This is the agent-code repo's `packages/claude-code-headless` submodule, which is its own GitHub repository. Work on a branch in that repository (a worktree of the submodule). All paths below are relative to the `claude-code-headless` repo root.

The script and workflow files are **byte-identical** to agent-code's. Only the support file differs (Claude only).

### Task B1: Add the watcher to claude-code-headless

**Files:**
- Create: `support/upstream-versions.json`
- Create: `support/README.md`
- Create: `scripts/check-upstream.mjs`
- Create: `.github/scripts/sync-upstream-issues.sh`
- Create: `.github/workflows/upstream-watch.yml`
- Modify: `package.json` (add one script entry)

- [ ] **Step 1: Create the Claude-only support file**

Create `support/upstream-versions.json`:

```json
{
  "_comment": "Source of truth for the Claude Code CLI version this package has explicitly accepted as supported. The upstream-watch workflow compares npm's `latest` dist-tag against `accepted`; a human bumps `accepted` only after a compatibility review. Never edited by automation. See support/README.md.",
  "providers": {
    "claude": {
      "label": "Claude Code",
      "pkg": "@anthropic-ai/claude-code",
      "changelog": "https://github.com/anthropics/claude-code/releases",
      "accepted": "0.0.0",
      "checkedAt": "2026-05-16"
    }
  }
}
```

- [ ] **Step 2: Create `support/README.md`**

Use the exact content from Part A Task A1 Step 2, with one wording change: this package watches Claude Code only, so the sentence "fetches npm's `latest` dist-tag for each package" still reads correctly (there is one provider). No other change needed — copy that README verbatim.

- [ ] **Step 3: Create the detection script**

Create `scripts/check-upstream.mjs` with the **exact** content from Part A Task A2 Step 1 (byte-identical — the script is provider-agnostic and reads whatever `support/upstream-versions.json` contains). If the repo has no `scripts/` directory yet, creating the file creates it.

- [ ] **Step 4: Create the sync script**

Create `.github/scripts/sync-upstream-issues.sh` with the **exact** content from Part A Task A3 Step 1 (byte-identical), then `chmod +x` it.

- [ ] **Step 5: Create the workflow**

Create `.github/workflows/upstream-watch.yml` with the **exact** content from Part A Task A4 Step 1 (byte-identical).

- [ ] **Step 6: Register the `upstream:check` npm script**

In `package.json`, inside the `"scripts"` object, add:

```json
    "upstream:check": "node scripts/check-upstream.mjs",
```

Place it among the existing scripts (order does not matter). Do not change any other script.

- [ ] **Step 7: Verify locally**

Run: `node scripts/check-upstream.mjs`
Expected: one stderr summary line for Claude Code and a JSON object on stdout with one result. With `accepted` still `0.0.0` it reports `DRIFT`.

- [ ] **Step 8: Seed the accepted version**

Replace `"accepted": "0.0.0"` with the `latest` value the script just printed for Claude Code; set `checkedAt` to `2026-05-16`. Re-run `node scripts/check-upstream.mjs` and confirm it now reports `in sync`.

- [ ] **Step 9: Syntax-check the bash and YAML**

```bash
bash -n .github/scripts/sync-upstream-issues.sh
node -e "const s=require('fs').readFileSync('.github/workflows/upstream-watch.yml','utf8');if(!s.includes('upstream-watch'))process.exit(1);console.log('ok')"
```

Expected: no bash output (exit 0), then `ok`.

- [ ] **Step 10: Commit and open the PR**

```bash
git add support/ scripts/check-upstream.mjs .github/scripts/sync-upstream-issues.sh .github/workflows/upstream-watch.yml package.json
git commit -m "chore(upstream): add Claude Code drift-watch workflow"
```

Push the branch and open a PR against the `claude-code-headless` default branch with the `gh` account set to `Juliusolsson05`. Do not merge.

- [ ] **Step 11: Post-merge smoke test**

After merge, run `gh workflow run upstream-watch.yml` (in the `claude-code-headless` repo) and `gh run watch`. Expected: green run; no duplicate issue on a second run.

---

## Part C — codex-headless

This is the agent-code repo's `packages/codex-headless` submodule, its own GitHub repository. Work on a branch in that repository. All paths below are relative to the `codex-headless` repo root.

Identical to Part B except the support file lists Codex.

### Task C1: Add the watcher to codex-headless

**Files:**
- Create: `support/upstream-versions.json`
- Create: `support/README.md`
- Create: `scripts/check-upstream.mjs`
- Create: `.github/scripts/sync-upstream-issues.sh`
- Create: `.github/workflows/upstream-watch.yml`
- Modify: `package.json` (add one script entry)

- [ ] **Step 1: Create the Codex-only support file**

Create `support/upstream-versions.json`:

```json
{
  "_comment": "Source of truth for the Codex CLI version this package has explicitly accepted as supported. The upstream-watch workflow compares npm's `latest` dist-tag against `accepted`; a human bumps `accepted` only after a compatibility review. Never edited by automation. See support/README.md.",
  "providers": {
    "codex": {
      "label": "Codex",
      "pkg": "@openai/codex",
      "changelog": "https://github.com/openai/codex/releases",
      "accepted": "0.0.0",
      "checkedAt": "2026-05-16"
    }
  }
}
```

- [ ] **Step 2: Create `support/README.md`**

Copy the README content from Part A Task A1 Step 2 verbatim (it reads correctly for a single-provider repo).

- [ ] **Step 3: Create the detection script**

Create `scripts/check-upstream.mjs` with the **exact** content from Part A Task A2 Step 1 (byte-identical).

- [ ] **Step 4: Create the sync script**

Create `.github/scripts/sync-upstream-issues.sh` with the **exact** content from Part A Task A3 Step 1 (byte-identical), then `chmod +x` it.

- [ ] **Step 5: Create the workflow**

Create `.github/workflows/upstream-watch.yml` with the **exact** content from Part A Task A4 Step 1 (byte-identical).

- [ ] **Step 6: Register the `upstream:check` npm script**

In `package.json`, inside `"scripts"`, add:

```json
    "upstream:check": "node scripts/check-upstream.mjs",
```

- [ ] **Step 7: Verify locally**

Run: `node scripts/check-upstream.mjs`
Expected: one stderr summary line for Codex; stdout JSON with one result; `DRIFT` while `accepted` is `0.0.0`.

Note: `@openai/codex`'s `latest` dist-tag is the stable line (e.g. `0.131.0`), not the `rust-v…-alpha.NN` pre-releases visible on GitHub. The script reads `dist-tags.latest`, so the noisy alpha tags never reach it — this is the whole reason the trigger is npm and not GitHub tags.

- [ ] **Step 8: Seed the accepted version**

Replace `"accepted": "0.0.0"` with the `latest` value just printed for Codex; set `checkedAt` to `2026-05-16`. Re-run and confirm `in sync`.

- [ ] **Step 9: Syntax-check the bash and YAML**

```bash
bash -n .github/scripts/sync-upstream-issues.sh
node -e "const s=require('fs').readFileSync('.github/workflows/upstream-watch.yml','utf8');if(!s.includes('upstream-watch'))process.exit(1);console.log('ok')"
```

Expected: no bash output (exit 0), then `ok`.

- [ ] **Step 10: Commit and open the PR**

```bash
git add support/ scripts/check-upstream.mjs .github/scripts/sync-upstream-issues.sh .github/workflows/upstream-watch.yml package.json
git commit -m "chore(upstream): add Codex drift-watch workflow"
```

Push and open a PR against the `codex-headless` default branch with the `gh` account set to `Juliusolsson05`. Do not merge.

- [ ] **Step 11: Post-merge smoke test**

After merge, run `gh workflow run upstream-watch.yml` (in the `codex-headless` repo) and `gh run watch`. Expected: green run; no duplicate issue on a second run.

---

## Self-review against the spec

- **Poll the upstream version source** — Task A2 / B1 / C1: `check-upstream.mjs` fetches the npm `latest` dist-tag. ✓
- **Compare against a repo-declared accepted version** — `support/upstream-versions.json` in every repo; `isNewer()` does the compare. ✓
- **Open/update a maintenance issue on drift** — `sync-upstream-issues.sh`: create when no tracker exists, edit when one does. ✓
- **Humble issue body** ("does not imply a known breakage") + changelog link + acceptance checklist — issue body heredoc in the sync script. ✓
- **Idempotent — no duplicate spam** — tracker found by `upstream-update` + `provider:<key>` labels; one rolling issue per provider; daily-release noise handled. ✓
- **Labels** `maintenance`, `upstream-update`, `provider:claude`, `provider:codex` — created with `gh label create --force`. ✓
- **Human acceptance via PR that bumps the version file** — Task A5 Step 5, `support/README.md`, and the checklist's final item; automation never edits the support file. ✓
- **`agent-transcript-parser` hand-off** — explicit checklist line; no watcher there (a version number cannot detect a shape change). ✓
- **Right repos get the right issues** — per-repo watchers: agent-code (both, integration), claude-code-headless (Claude), codex-headless (Codex). ✓
- **Minimal token permissions, no cross-repo secret** — `permissions: contents: read / issues: write`, `GITHUB_TOKEN` only. ✓
- **Registry failure is visible, not a false "in sync"** — script exits 1 on a registry error; the run goes red. ✓
- **Local parity** — `npm run upstream:check` in every repo. ✓
```
