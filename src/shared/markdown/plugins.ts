// Markdown plugin sets — defined at module scope so react-markdown v10
// caches parse results keyed on plugin identity. Fresh array literals
// on every render would bust the cache.

import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// Completed text from JSONL: real markdown, standard rules.
export const COMPLETED_REMARK = [remarkGfm]

// Streaming text from screen buffer: single newlines are load-bearing
// (each line is a genuine line, not a soft wrap). remark-breaks turns
// each hard newline into a <br>.
export const STREAMING_REMARK = [remarkGfm, remarkBreaks]
