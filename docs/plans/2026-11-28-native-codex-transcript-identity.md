# Restore fresh native Codex transcript ownership

## Evidence

A fresh native Codex 0.172.0 pane can process prompts while Agent Code has no attached rollout.
A resumed pane already has its exact UUID and can read its transcript.
A disposable 0.172.0 TUI emitted SessionStart with source startup, a UUID and a rollout path.
The filename UUID equalled the root session_meta.id and the recorded source was cli.
The existing exact-ID locator and lease validate a candidate before tailing. Use that path.

## Implementation and verification

1. Install a private startup-only receipt for each fresh native launch. Keep reporting and user hooks independent.
2. Accept only root startup identities in the current launch. Wait for the verified rollout to become readable.
3. Reuse the existing exact-ID registration and stop ownership work on disposal or successful attachment.
4. Exercise concurrent same-directory launches, delayed files, invalid evidence, cleanup and real CLI compatibility.

Refs #1565

## Results

Two installed Codex 0.172.0 TUIs shared a disposable home and cwd, with a localhost fixture and no TLDR or proxy. Both returned their own marker from the application transcript and distinct root session IDs. The personal SessionStart hook ran for both launches. Removing the launch identity hook reproduced the empty transcript on the same test.

The receipt can arrive before headless startup or rollout creation. The existing exact-ID locator still owns the final filename, metadata and lease checks. Disabled or unsupported hooks provide no additional evidence. Existing panes need a fresh launch or a resume by known identity.
