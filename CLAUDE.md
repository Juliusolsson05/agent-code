# Agent Code

This codebase is written and developed by AI. Future you will pick up where past you left off, with no shared memory beyond what's in the repo.

## Comment policy

Write **thick WHY comments** liberally throughout the code. Be generous — over-comment, don't under-comment. The cost of an extra paragraph is nothing; the cost of future-you re-deriving a tricky decision from scratch is real.

A good comment answers questions like:

- *Why this approach and not the obvious alternative?*
- *What constraint forced this shape?*
- *What did we try first that didn't work?*
- *What invariant must hold here, and what breaks if it doesn't?*
- *What's the source of truth for this value?*

Don't bother explaining *what* the code does — that's what reading the code is for. Explain *why it exists*, *why it's shaped this way*, and *what would make it wrong*.

Make agentic development and decision-making **transparent in the diff**, not in a doc that drifts.

## Directory conventions

Two top-level folders look superficially similar but mean very different things. Do not mix them.

- `vendor/` — read-only **source code references** kept locally so future-you can grep the original implementation of something we wrap or interoperate with. Never imported, never built, never shipped. Examples: `claude-code-src/`, vendored upstream checkouts for bug-bisection.
- `third_party/` — pinned **runtime artifacts** that we ship inside packaged Agent Code (or that the release pipeline fetches at build time). Each tool gets its own directory with a `manifest.json` (version + per-arch sha256 + URL template), `README.md`, `LICENSE.md`, and a `.gitignore` that keeps `cache/` and `build/` out of git. Binaries are NEVER committed — the manifest plus `scripts/runtime-tools/<tool>` is the source of truth, and version bumps are one-file PRs against `manifest.json`. Examples: `third_party/mitmproxy/`, `third_party/tmux/`. See issues #119 and #120 for the full bundling plan.
