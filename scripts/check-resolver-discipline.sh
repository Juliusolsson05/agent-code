#!/usr/bin/env bash
#
# Resolver-discipline CI check.
#
# WHY this script exists: the grid-vs-dispatch session-set divergence
# kept recurring (PRs #37 / #39 / #44 / #45 / #46 / #58 / #59 / #69
# / #83 + issue #104) because surfaces walked `tab.root` directly via
# collectLeaves and forgot to compose with detached agents. The
# resolver layer (resolveTabSessions / isDetached in
# src/renderer/src/workspace/queries.ts) provides the right answer;
# this check is the gate that prevents the pattern from coming back.
# Runs on every push and PR.
#
# Forbidden patterns (in renderer code, outside the allowlist):
#   1. collectLeaves(<expr>.root) — walking a tile-tree directly.
#      Should use resolveTabSessions instead, which composes grid
#      leaves with detached agents owned by the tab.
#   2. state.detachedSessions[<expr>] or
#      Object.{values,keys,entries}(state.detachedSessions) — direct
#      detached-bucket access. Should use a named query in
#      workspace/queries.ts (resolveTabSessions, isDetached) instead.
#   3. const|let|var { ...detachedSessions... } = state — destructuring
#      the bucket out of state so subsequent `detachedSessions[id]`
#      bypasses pattern #2. Cover the back door too.
#
# Comment lines (`//`, ` *`) are skipped so the explainer prose can
# reference the literal pattern without tripping the check.
#
# Known limitation: patterns are matched line-by-line. A forbidden
# call wrapped across multiple lines
#   `collectLeaves(\n   tab.root\n)` would slip through. That's an
# acceptable trade — the patterns we forbid are short enough that
# wrapping is unusual, and the cost of a multi-line matcher
# (introducing pcre2grep or a Node script) is higher than the value.
#
# If you genuinely need one of these patterns in a new file, add the
# file to ALLOWED_FILES below with a brief comment explaining why
# (e.g. the file IS the resolver layer, or the code is tile-tree
# mutation where grid-only is correct by design).

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files where the forbidden patterns are allowed.
#
# Resolver layer — defines the contract:
#   - queries.ts                   (the resolver itself)
#   - dispatchSelectors.ts         (legacy dispatch-UI selectors that
#                                   resolveTabSessions composes with)
#   - sessionOwnership.ts          (owner-tab classifier; the broader
#                                   placement model lives here)
#   - tile-tree/treeOps.ts         (defines collectLeaves)
#   - commandTargetSessionId.ts    (Dispatch-aware focus reader)
#
# Tree mutation / persistence — grid-only is correct by design:
#   - hook/actions/*.ts            (split/close/move/duplicate panes,
#                                   plus reader/spotlight action layer
#                                   which deliberately uses
#                                   collectLeaves to gate
#                                   tab.focusedSessionId writes on
#                                   grid-leaf membership)
#   - hook/persistence/*.ts        (rehydrate)
#   - layout/helpers.ts            (geometry from tile tree)
#   - persistence.ts               (workspace.json migrations)
#   - tile-tree/TileTree.tsx       (renders the tree)
#   - tile-tree/useKeybinds.ts     (arrow-key navigation walks tree)
#
# DELIBERATELY NOT ALLOWLISTED (used to be, removed after review of
# PR #107):
#   - hook/invalidation/effects.ts — the Reader/Spotlight focus
#     validator MUST match the view source-of-truth, which is
#     resolveTabSessions (not collectLeaves). Allowlisting this dir
#     hid a real bug where a detached focus was reset to the first
#     grid pane.
#   - tile-tree/paneLabels.ts — labels for grid AND detached sessions;
#     the new implementation uses resolveTabSessions so it doesn't
#     need an exemption.
ALLOWED_FILES=(
  "src/renderer/src/workspace/queries.ts"
  "src/renderer/src/workspace/dispatch/dispatchSelectors.ts"
  "src/renderer/src/workspace/sessionOwnership.ts"
  "src/renderer/src/workspace/tile-tree/treeOps.ts"
  "src/renderer/src/workspace/hook/selectors/commandTargetSessionId.ts"
  "src/renderer/src/workspace/hook/actions/"
  "src/renderer/src/workspace/hook/persistence/"
  "src/renderer/src/workspace/layout/helpers.ts"
  "src/renderer/src/workspace/persistence.ts"
  "src/renderer/src/workspace/tile-tree/TileTree.tsx"
  "src/renderer/src/workspace/tile-tree/useKeybinds.ts"
)

build_filter() {
  local pattern=""
  for f in "${ALLOWED_FILES[@]}"; do
    pattern+="$f|"
  done
  echo "(${pattern%|})"
}

FILTER="$(build_filter)"

violations=0

# strip_comment_lines — drop lines that are entirely a // comment or
# the continuation of a /* block comment. A `path:LINENO:` prefix from
# `grep -n` precedes the source code, so the check has to apply AFTER
# the prefix.
strip_comment_lines() {
  grep -vE ':[[:space:]]*//' | grep -vE ':[[:space:]]*\*'
}

check_pattern() {
  local label="$1"
  local pattern="$2"
  local hits
  hits=$(grep -rnE "$pattern" \
    --include="*.ts" --include="*.tsx" \
    src/ 2>/dev/null \
    | strip_comment_lines \
    | grep -E -v "$FILTER" \
    || true)
  if [ -n "$hits" ]; then
    echo ""
    echo "Violation: $label"
    echo "$hits"
    violations=$((violations + 1))
  fi
}

check_pattern \
  "collectLeaves walking a .root expression outside the resolver layer" \
  'collectLeaves\([^)]*\.root\)'

check_pattern \
  "direct state.detachedSessions subscript outside the resolver layer" \
  '(state|workspace\.state)\.detachedSessions\['

check_pattern \
  "Object.{values,keys,entries}(...detachedSessions) outside the resolver layer" \
  'Object\.(values|keys|entries)\([^)]*detachedSessions'

# Destructuring back door — without this, a writer could route around
# the subscript check via
#   const { detachedSessions } = state
#   detachedSessions[id]
# and the next reviewer would see only `detachedSessions[id]` (no
# `state.` prefix). Forbid destructuring the bucket out of state in
# the first place.
check_pattern \
  "destructuring detachedSessions out of state outside the resolver layer" \
  '\b(const|let|var)\s+\{[^}]*\bdetachedSessions\b[^}]*\}\s*='

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Found $violations resolver-discipline violation(s)."
  echo ""
  echo "If you need 'every session in this tab' use resolveTabSessions"
  echo "from src/renderer/src/workspace/queries.ts. If you need 'is this"
  echo "session currently detached' use isDetached from the same file."
  echo ""
  echo "If your usage is genuinely grid-only by design (tile-tree"
  echo "mutation, persistence migration), add the file or its parent"
  echo "directory to ALLOWED_FILES in scripts/check-resolver-discipline.sh"
  echo "with a comment explaining why."
  exit 1
fi

echo "Resolver discipline: no violations."
exit 0
