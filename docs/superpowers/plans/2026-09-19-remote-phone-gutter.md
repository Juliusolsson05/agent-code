# Remote phone gutter: plan

**Branch:** `fix/remote-phone-gutter` from `origin/main`. It carries work finished by
an earlier agent session (the phone gutter thread), which was left uncommitted in
the main checkout. Release-readiness ledger thread T3.

## Problem

The owner reported that margin and padding on mobile are broken. On the phone
(remote-client) shell, the v1 chrome bands used a 14px horizontal gutter, while the
mounted desktop feed, the composer and the v2 chrome all use 12px. Adjacent bands
sat 2px apart, which on a monospace grid reads as broken padding.

## Change

- One gutter, 12px, on `.topbar`, `.section-label`, `.session-row`, `.terminal`
  and `.working`.
- A "gutter contract" header comment in `src/remote-client/src/styles.css`.
- `src/remote-client/src/ui/gutterContract.test.ts` asserts the stylesheet text,
  which is the file the phone actually loads. jsdom never evaluates this CSS, so
  computed-style assertions could not see it; this is the same approach as
  `nordTheme.test.ts`.

## Verification

- Against main's stylesheet the contract fails on 4 bands.
- With the fix, the remote-client unit suite passes 33/33.
- There is no visual check (the app is never launched), so the owner should look
  on the phone after the release.
