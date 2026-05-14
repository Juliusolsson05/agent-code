#!/usr/bin/env node
// Static tmux builder — stub. Real implementation lands in PR 3
// (issue #120).
//
// PR 1 ships this stub so:
//   - npm scripts referencing it resolve cleanly
//   - the filesystem layout (third_party/tmux/{cache,build}) is
//     established and the .gitignore is enforced
//   - PR 3 can swap the implementation without re-litigating any of
//     the surrounding contract
//
// When PR 3 lands, this script will:
//   1. Download pinned tmux + libevent + ncurses + utf8proc sources.
//   2. Verify each source archive against
//      `manifest.sources.<name>.sha256`.
//   3. Configure with --enable-static --disable-shared, build, link
//      tmux statically.
//   4. Run the proof-of-life lifecycle (see third_party/tmux/README.md).
//   5. Write the binary to `cache/<platform>-<arch>/tmux` and record
//      its sha256 into manifest.platforms.<platformKey>.sha256.

process.stderr.write(
  '[build-tmux] not yet implemented; tracked in issue #120 (PR 3).\n' +
    '[build-tmux] manifest under third_party/tmux/manifest.json still has TBD-PR3 placeholders.\n',
)
process.exit(2)
