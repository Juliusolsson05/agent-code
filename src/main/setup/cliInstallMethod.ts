import { realpath } from 'fs/promises'
import { homedir } from 'os'
import { sep } from 'path'

import type { CliInstallMethod } from '@shared/types/cliUpdate.js'

// Classify an installed CLI by its resolved binary path.
//
// WHY match paths instead of asking the CLI:
//   Both CLIs have a `<cli> doctor` subcommand that reports its install
//   method, but calling that is (a) a second spawn per launch on the boot
//   path we're trying to keep cheap, (b) a text-parse against unstable
//   output ("Installation type: native (~/.local/bin)" today, who knows
//   tomorrow), and (c) subject to the same PATH weirdness as the actual
//   update — if `doctor` can't find brew, it'll misclassify. Matching the
//   binary path is deterministic and matches how Anthropic's own updater
//   was documented to work in claude-code #28625 (the misdetection bug we
//   don't want to reproduce).
//
// WHY realpath first:
//   Users install through nvm/volta/asdf/bun/pnpm, all of which put a
//   shim in ~/.<manager>/... that dispatches to a versioned node_modules
//   tree. Homebrew symlinks /opt/homebrew/bin/codex → Cellar/codex/X.Y.Z/
//   bin/codex. The shim path tells us nothing; the realpath tells us the
//   install root. We follow one hop; nested shims will be classified as
//   'unknown' and fall back to the CLI's own updater, which is fine.

const home = homedir()

// Install-root markers, checked in order. First match wins. The order
// matters when a path contains multiple markers (e.g. a Volta shim
// pointing at a node_modules copy of @openai/codex would match both npm
// and native — we want npm because Volta manages the npm install).
const MARKERS: Array<{ method: CliInstallMethod; matches: (path: string) => boolean }> = [
  // npm — anything under a node_modules directory. Covers plain
  // `npm i -g`, nvm, volta, asdf, bun, pnpm, yarn, and any package
  // manager that ends up in a node_modules layout. This has to win over
  // native for the case above because `codex update` on npm-managed
  // installs must run `npm install -g`, not the native installer script.
  { method: 'npm', matches: (p) => p.includes(`${sep}node_modules${sep}`) },
  // Homebrew — Cellar (Intel) or Homebrew prefix (Apple Silicon). Both
  // the symlink target under /Cellar/ and the direct prefix hit here.
  // Linuxbrew lives at /home/linuxbrew.
  {
    method: 'brew',
    matches: (p) =>
      p.startsWith('/opt/homebrew/') ||
      p.startsWith('/usr/local/Cellar/') ||
      p.startsWith('/usr/local/opt/') ||
      p.startsWith('/home/linuxbrew/'),
  },
  // WinGet on Windows — the WinGet package cache lives under LocalAppData.
  { method: 'winget', matches: (p) => p.toLowerCase().includes(`${sep}winget${sep}`) },
  // Native — Claude ships to `~/.local/share/claude/versions/<VERSION>/`
  // and symlinks to `~/.local/bin/claude`; Codex's standalone installer
  // drops the binary directly at `~/.local/bin/codex`. Anything under
  // ~/.local matches, as does the versioned Claude tree.
  {
    method: 'native',
    matches: (p) =>
      p.startsWith(`${home}${sep}.local${sep}`) ||
      p.includes(`${sep}.local${sep}share${sep}claude${sep}versions${sep}`),
  },
]

export async function detectCliInstallMethod(binaryPath: string): Promise<CliInstallMethod> {
  // realpath follows symlinks — the whole point. If realpath fails
  // (dangling symlink, permission denied, missing binary at the moment
  // of check) we fall back to the raw path, which still lets us
  // pattern-match the manager's own shim location.
  let resolved = binaryPath
  try {
    resolved = await realpath(binaryPath)
  } catch {
    // Fall through with the un-resolved path; the shim-location patterns
    // above catch nvm/volta/asdf without needing the target.
  }
  // Check both the resolved path AND the shim path; the manager shim
  // (e.g. ~/.volta/bin/codex) is unrelated to the install root but is
  // itself a signal about which command to use for updates.
  for (const { method, matches } of MARKERS) {
    if (matches(resolved) || matches(binaryPath)) return method
  }
  return 'unknown'
}
