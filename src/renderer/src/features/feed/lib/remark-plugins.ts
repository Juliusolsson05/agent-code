import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// Plugin sets used by react-markdown inside the feed.
//
// Defined at module scope because react-markdown v10 caches parse
// results keyed on plugin identity — passing fresh array literals on
// every parent render busts the cache and costs real frames.
//
// The two sets differ in ONE plugin:
//
//   COMPLETED_REMARK: just `remark-gfm`. Completed assistant text from
//   the JSONL is real markdown source with proper paragraph breaks,
//   so standard markdown rules apply.
//
//   STREAMING_REMARK: `remark-gfm` + `remark-breaks`. The streaming
//   source is CC's screen buffer — plain text stripped of ANSI. CC's
//   Ink already converted markdown syntax (** _ ` ```) to terminal
//   attributes and discarded the characters by the time it hits our
//   buffer, so there's no real markdown to parse. But single newlines
//   are load-bearing in the streaming text (each line is a genuine
//   line, not a soft wrap), and standard markdown collapses single
//   newlines into soft wraps that flow together as one paragraph.
//   `remark-breaks` turns each hard newline into a <br>, preserving
//   the visual line layout. Without it, a multi-line response like
//   "There are 19 entries:\n  body.txt\n  claude-501\n…" would
//   collapse into one blob.
//
// Rendering streaming through react-markdown instead of a raw <pre>
// also makes the typography match completed messages exactly: same
// font, size, line-height, paragraph rhythm. When the JSONL entry
// lands and the structured version takes over, the visual jump is
// minimal — just richer formatting on top of the same base layout.

export const COMPLETED_REMARK = [remarkGfm]
export const STREAMING_REMARK = [remarkGfm, remarkBreaks]
