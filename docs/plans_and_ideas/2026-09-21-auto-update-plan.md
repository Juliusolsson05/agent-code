# Agent Code auto-update — implementation plan

Status: researched 2026-09-21; implementation on `feat/auto-update`. Issue: see GitHub.
Owner of this plan: the goal loop that follows it stage by stage.

## Verified facts (not assumptions — each checked on this machine)

1. **The feed already ships.** Release v0.1.0 carries `latest-mac.yml` plus
   dmg/zip and `.blockmap` pairs for arm64+x64 — electron-updater's complete
   GitHub feed shape, produced by the existing pipeline.
2. **The repo is public**, so anonymous `GitHubOptions` update checks work in
   the packaged app with no embedded tokens.
3. **Signing exists**: a "Developer ID Application: Julius Olsson" cert is in
   the keychain, and `scripts/package-mac.mjs` is the single home of the
   unsigned-when-no-cert policy (CSC_LINK/CSC_NAME; strips all three
   notarization credential paths). CI (`release.yml`, workflow_dispatch with
   `publish_release`/`prerelease`/`tag` inputs) validates signing secrets
   before publishing.
4. **No updater code exists** (zero electron-updater references) and
   **electron-builder.yml has no `publish` config**, so packaged apps do NOT
   embed `app-update.yml` — the updater would have nothing to read. This is
   the actual wiring gap, bigger than the client code.
5. **macOS constraint chain**: Squirrel.Mac requires the update zip to be
   signed with the SAME identity as the installed app; updates apply by
   replacing the app and relaunching — there is no in-place hot swap.
6. **The app has a committed-quit choreography** (#945: before-quit veto,
   "Keep Editing", stopExtensions inventory, will-quit gate). Any update
   application MUST ride that path — a `quitAndInstall()` that bypasses it
   would hard-kill live PTYs/agents, the exact disaster this app exists to
   avoid.
7. electron.build docs were unreachable from this session (404s via fetch);
   implementation-time research should use web search (Brave API key provided
   by the user — see loop prompt for handling rules) plus the installed
   package's TypeScript definitions as the source of truth for API shape.

## A → D

**A (exists, trusted):** `release/latest-mac.yml` + signed artifacts published
to GitHub Releases by workflow; app has `buildInfo.ts`, a native app menu
(`appMenu`), extension host services, and the #945 shutdown choreography.

**D (goal):** a packaged app, on launch and on demand, checks GitHub for a
newer stable release, downloads it in the background (blockmap differential
where possible), shows a non-invasive "Restart to update" affordance, and —
only on explicit user action — applies it THROUGH the existing graceful-quit
path and relaunches. Unsigned dev builds and CI builds without publish config
no-op cleanly. First release through the new path: **v0.1.1 (patch)**.

## Stages

### B — Feed and embed verification (no product code)
- Confirm `reusable-package-release.yml`/`reusable-app-build-macos.yml`
  upload `latest-mac.yml` + blockmaps for every future release (they did for
  v0.1.0; make it explicit, not accidental).
- Add `publish: [{ provider: github, owner: Juliusolsson05, repo: agent-code }]`
  to electron-builder.yml; verify a local package embeds
  `resources/app-update.yml`. Unsigned local builds must still succeed
  (package-mac policy) — embed happens regardless of signing.
- Anonymous `GET /releases/latest` asset check script (manual/CI-diagnostic).

### C — `src/main/updates/UpdateService.ts` (isolated, test-first)
- Constructor takes an injected `autoUpdater`-shaped object (real one from
  `electron-updater` in production; fakes in tests) — same pattern as the
  extension services' deadline/spawn injection.
- State machine: `idle → checking → (available → downloading → ready) | none`,
  plus `error`. Events surface through the existing notification/toast fan-out.
- Hard rules, encoded as tests:
  - NEVER auto-restarts; `autoInstallOnAppQuit = false`.
  - `restartToUpdate()` routes through the #945 quit flow (the same
    before-quit veto the close button uses) and only then `quitAndInstall()`.
  - No-op + one log line when `!app.isPackaged` or `app-update.yml` missing.
  - Signature-mismatch / network / no-update errors become actionable
    user-facing strings, never stack dumps.

### D — Wiring + UX
- GitHubOptions from buildInfo/publish config; channel `latest`;
  `allowDowngrade: false`; logger into the app run journal.
- App menu: "Check for Updates…" + status line (agent-code's appMenu).
- On-launch check delayed past startup-critical work; re-check at most daily
  (persist last-check timestamp in existing state store).
- Download progress → quiet status; completion → "Restart to update" button.

### E — Tests, review, release
- Unit: state machine, no-restart invariant, dev no-op, error mapping.
- **Claude-agent consultations (user-requested)**: (1) policy review — when
  may an update apply given live PTYs/agents; (2) electron-updater pitfalls
  (mac signature identity continuity, blockmap edge cases, GitHub rate
  limits) against our plan; (3) pre-merge code review.
- PR → merge after review (user pre-approved merge in the loop directive).
- Cut **v0.1.1** patch: bump package.json, run release workflow
  (`publish_release=true`, `stable`), verify the release carries latest-mac.yml
  + blockmaps and that a v0.1.0 install's updater would see it (feed diff).
- Honest limits: no interactive "watch it update" proof without UI automation;
  record what was verified programmatically.

## After this ships — finish Agent Code Poker loop remainder

Real Electron acceptance of the in-app LAN flow (harness or user-assisted),
promotion/closure of open gates, docs sync. Tracked by the same loop.

## Non-goals

Windows/Linux channels, nightly-channel switching UI, forced updates,
update while sessions run, embedding any token for private feeds.
