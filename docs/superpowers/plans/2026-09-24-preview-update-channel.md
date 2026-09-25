# Preview update channel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let users opt in to preview updates. Settings gets **Update channel: Stable / Preview**; the updater follows it through the rolling `preview` release, and nothing changes for Stable.

**Spec:** `docs/superpowers/specs/2026-09-24-preview-update-channel-design.md` (D1–D6). **Issue:** #1168. **Status:** user-approved 2026-09-24.

**Working tree:** `.worktrees/preview-update-channel`, branch `feat/preview-update-channel`, based on `origin/main` `95413b4f`. Use Node 24.

**Conventions:**
- Write thick WHY comments.
- Use Conventional Commits.
- Tests use real recorded data, including the real v0.1.3 `latest-mac.yml`.
- Verify with `npx tsc -b` and targeted vitest.
- Never launch the app.

### Task 1: Publish the preview feed (D2)
- [ ] `preview.mjs rename`:
  - build `preview-mac.yml` from electron-builder's `*-mac.yml`, with names rewritten to the rolling names;
  - drop the other ymls and every blockmap.
- [ ] `verify-update-feed.mjs` takes an optional feed name.
- [ ] `preview.yml`:
  - verify `preview-mac.yml`;
  - upload it last on the rolling release.
- [ ] Tests: recorded v0.1.3 feed → derived preview feed; the names match the rolling copies; the verifier passes; a feed naming a missing file fails.

### Task 2: Updater channel (D1, D3, D4)
- [ ] `src/shared/updates/updateChannel.ts`:
  - the `UpdateChannel` type;
  - the feed configs, with owner and repo mirrored from `electron-builder.yml`;
  - `defaultUpdateChannel(version)`.
- [ ] `UpdateCheckStore` persists `channel` beside `lastCheckAt`.
- [ ] `UpdateService`:
  - `channel`, `setChannel()`, and the feed applied at construction and on switch;
  - `disableDifferentialDownload` on Preview;
  - switching drops the other channel's found or ready update and runs a forced check;
  - channel-aware messages.
- [ ] Wire it up in `index.ts`.
- [ ] Tests: default inference, the feed configs, switching back and forth with no `channel` property set, `allowDowngrade` staying off, a ready update dropped on switch, and the messages.

### Task 3: Settings row (D5)
- [ ] IPC: `updates:get-channel` and `updates:set-channel`, plus preload.
- [ ] Settings registry marker row `update-channel` in Workspace, rendered by `UpdateChannelRow`.
- [ ] Renderer test: the row shows the current channel, the running version, and calls set.

### Task 4: Docs and verification
- [ ] RELEASE.md: the Channels table and the Previews section describe the opt-in.
- [ ] Run `npx tsc -b` and the targeted tests.
- [ ] Open a PR with `Fixes #1168`.
- [ ] Run the review round and wait for CI.
