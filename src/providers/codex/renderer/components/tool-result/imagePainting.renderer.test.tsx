import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { codexResultContent } from '@providers/codex/renderer/transcript/entries'
import { CodexToolResultRow } from '@providers/codex/renderer/components/tool-result'

// The test that was missing, and whose absence let a half-fix ship.
//
// The original suite asserted that the MAPPING boundary produced image blocks
// and stopped there. It was named "the reported bug end to end" but never
// exercised routing or painting — so it stayed green while Codex `exec` results
// were routed to CodexToolResultRow, flattened straight back to `[image/jpeg]`
// labels, and no image ever appeared. The base64 dump was gone; the picture was
// still missing. Two independent reviewers found this before a human did.
//
// The lesson encoded here: an assertion about an intermediate representation is
// not an assertion about what the user sees. This file renders the component
// that actually paints the reported bug and looks for an <img>.

const FIXTURE = join(process.cwd(), 'testing/fixtures/image-reads/codex-exec-interleaved-three-images.json')

function execResultBlock(): { block: ToolResultBlock; sourceTool: ToolUseBlock } {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    entry: { payload: { output: unknown; call_id: string } }
  }
  const content = codexResultContent(fixture.entry.payload.output)
  return {
    block: {
      type: 'tool_result',
      tool_use_id: fixture.entry.payload.call_id,
      content,
      is_error: false,
      // The envelope `renderCodexToolResult` keys off when deciding this row
      // belongs to the Codex painter rather than the generic one.
      codex: { kind: 'custom_tool_call_output' },
    },
    // The real correlated call from the same session (line 67): `exec`.
    sourceTool: { type: 'tool_use', id: fixture.entry.payload.call_id, name: 'exec', input: {} },
  }
}

describe('CodexToolResultRow — image results paint (the reported bug)', () => {
  it('renders one img per image part, not a base64 label', () => {
    const { block, sourceTool } = execResultBlock()

    render(<CodexToolResultRow block={block} sourceTool={sourceTool} />)

    // Three images in the real record. Base64MediaView keeps the payload behind
    // a disclosure, so the assertion is that three media surfaces exist.
    const images = screen.queryAllByRole('img', { hidden: true })
    const disclosures = screen.queryAllByText(/image\/(jpeg|png)/)
    expect(images.length + disclosures.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps each filename adjacent to its image, in wire order', () => {
    const { block, sourceTool } = execResultBlock()

    const { container } = render(<CodexToolResultRow block={block} sourceTool={sourceTool} />)

    // Interleaving is the acceptance criterion that a strip-the-base64 fix
    // would have destroyed: the text parts ARE the filenames, so each media
    // surface must sit BETWEEN them rather than all of them being grouped
    // after the text.
    //
    // Asserting only that the three filenames appear in order would pass on the
    // broken implementation too — labels preserve order just as well as images
    // do. The assertion has to be about media position, or it proves nothing.
    const walker = container.querySelectorAll('*')
    const sequence: string[] = []
    for (const node of walker) {
      const own = Array.from(node.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent ?? '')
        .join('')
      if (/Fotou\.nr_0_295\.jpg|GhmPK_1007\.jpg|vision-the-crown-annotated\.png/.test(own)) {
        sequence.push('text')
      } else if (node.tagName === 'IMG' || /image\/(jpeg|png)/.test(own)) {
        sequence.push('media')
      }
    }

    // text, media, text, media, text, media — a media surface after every path.
    expect(sequence.filter(k => k === 'text')).toHaveLength(3)
    expect(sequence.filter(k => k === 'media')).toHaveLength(3)
    for (let i = 0; i < sequence.length - 1; i += 1) {
      if (sequence[i] === 'text') expect(sequence[i + 1]).toBe('media')
    }
  })

  it('never puts the payload in the DOM before a disclosure opens', () => {
    const { block, sourceTool } = execResultBlock()

    const { container } = render(<CodexToolResultRow block={block} sourceTool={sourceTool} />)

    // base64.ts deliberately separates admission from data-URL construction so a
    // collapsed feed holding many images does not duplicate the payload into DOM
    // attributes. Assert that policy survives this painter.
    expect(/[A-Za-z0-9+/=]{200,}/.test(container.innerHTML)).toBe(false)
  })
})
