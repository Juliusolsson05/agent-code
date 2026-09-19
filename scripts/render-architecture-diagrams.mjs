#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// WHY the source lives in the reference rather than separate .mmd files:
// reviewers need the explanation and the exact diagram in the same diff. The
// SVGs are derived previews because GitHub's runtime renderer failed on this
// long page even after every diagram passed local parse/render validation.
// Plain-text source disclosures keep GitHub from trying to render a second,
// hidden copy. Stable explicit IDs keep asset paths independent of section
// numbering when the architecture document is reorganized.
//
// WHY tools are supplied separately: Mermaid and a browser automation library
// are documentation build dependencies, not Agent Code runtime dependencies.
// A temporary npm prefix keeps them out of the app's lockfile and distribution.
// Pinning their versions here makes an accidental tool upgrade visible before
// it rewrites every SVG. See ARCHITECTURE.md, Appendix B, for the exact command.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const check = argv.includes('--check')
const value = flag => {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}
const toolingDir = value('--tooling-dir')
const browserPath = value('--browser')
if (!toolingDir || !browserPath) {
  throw new Error('Usage: node scripts/render-architecture-diagrams.mjs --tooling-dir <npm-prefix> --browser <Chrome executable> [--check]')
}

const toolRoot = resolve(toolingDir)
for (const [name, expected] of [['mermaid', '11.4.1'], ['puppeteer-core', '24.2.1']]) {
  const manifest = JSON.parse(await readFile(join(toolRoot, 'node_modules', name, 'package.json'), 'utf8'))
  if (manifest.version !== expected) throw new Error(`Expected ${name}@${expected}, found ${manifest.version}`)
}
const requireTool = createRequire(join(toolRoot, 'package.json'))
const puppeteer = requireTool('puppeteer-core')
const markdown = await readFile(join(root, 'ARCHITECTURE.md'), 'utf8')
const pattern = /<!-- architecture-diagram: ([a-z0-9-]+) -->\n([\s\S]*?)```text\n([\s\S]*?)```/g
const diagrams = [...markdown.matchAll(pattern)].map(match => ({ id: match[1], preview: match[2], source: match[3] }))
if (!diagrams.length) throw new Error('No architecture diagram sources found')
// A malformed disclosure must fail validation rather than quietly disappearing
// from the generated set. Crossed marker boundaries are also a malformed block.
if ((markdown.match(/<!-- architecture-diagram:/g) ?? []).length !== diagrams.length
    || diagrams.some(diagram => diagram.preview.includes('<!-- architecture-diagram:'))) {
  throw new Error('An architecture diagram marker has no valid source block')
}
if (new Set(diagrams.map(diagram => diagram.id)).size !== diagrams.length) throw new Error('Duplicate architecture diagram IDs')
for (const diagram of diagrams) {
  if (!diagram.preview.includes(`docs/architecture/diagrams/${diagram.id}.svg`)) {
    throw new Error(`Diagram ${diagram.id} does not reference its expected preview`)
  }
  // Keep the question and its answer beside the editable source. A source that
  // renders successfully can still be a useless diagram; requiring these fields
  // makes its intended reading task visible in review and in the exported SVG.
  diagram.title = diagram.source.match(/^accTitle:\s*(.+)$/m)?.[1]
  diagram.description = diagram.source.match(/^accDescr:\s*(.+)$/m)?.[1]
  diagram.scope = diagram.source.match(/^%% scope:\s*(.+)$/m)?.[1]
  diagram.external = diagram.source.match(/^%% external:\s*(.+)$/m)?.[1].split(',') ?? []
  if (!diagram.title || !diagram.description || !diagram.scope) {
    throw new Error(`Diagram ${diagram.id} needs accTitle, accDescr and a scope comment`)
  }
}

const outputDir = join(root, 'docs', 'architecture', 'diagrams')
if (!check) await mkdir(outputDir, { recursive: true })
const expectedFiles = new Set(diagrams.map(diagram => `${diagram.id}.svg`))
const obsolete = (await readdir(outputDir)).filter(file => file.endsWith('.svg') && !expectedFiles.has(file))
if (obsolete.length) throw new Error(`Remove obsolete previews explicitly: ${obsolete.join(', ')}`)
const browser = await puppeteer.launch({ executablePath: resolve(browserPath), headless: true })
const failures = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ path: join(toolRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js') })
  for (const diagram of diagrams) {
    try {
      // Each render starts with its own deterministic seed. Otherwise Mermaid
      // can retain counters/configuration from a preceding diagram, making a
      // harmless insertion earlier in the document churn unrelated assets.
      // Pure SVG text avoids foreignObject compatibility problems when GitHub
      // loads the result as an image rather than as an interactive HTML page.
      const rendered = await page.evaluate(async ({ id, source, external }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          htmlLabels: false,
          // SVGs are usually scaled down inside Markdown. Slightly heavier
          // boundaries keep grouping and arrow paths visible at that size;
          // color contrast alone does not compensate for a subpixel stroke.
          themeCSS: '.edge-thickness-normal { stroke-width: 1.5px; } .node rect, .node polygon, .node path, .node ellipse, .node circle, .cluster rect { stroke-width: 1.5px; } .actor-line { stroke-width: 1.5px; }',
          flowchart: { htmlLabels: false, curve: 'linear', nodeSpacing: 32, rankSpacing: 44, padding: 14 },
          class: { htmlLabels: false },
          sequence: { mirrorActors: false, actorMargin: 40, messageMargin: 30, wrap: true, useMaxWidth: false },
          deterministicIds: true,
          deterministicIDSeed: id,
          // Class-box paths use RoughJS internally even with the classic
          // look. Its zero/default seed randomizes invisible control points,
          // so deterministicIds alone still produces a different file each run.
          handDrawnSeed: 42,
          // Blue always denotes Agent Code; gray denotes an external tool,
          // client or its data; amber is reserved for checks and cautions.
          // Explicit labels and dashed external borders preserve that meaning
          // in grayscale. No hue is assigned merely to make a box different.
          themeVariables: {
            fontFamily: 'Arial, sans-serif', fontSize: '18px',
            background: '#ffffff', primaryColor: '#eaf2f8', primaryTextColor: '#172b3a',
            primaryBorderColor: '#356681', secondaryColor: '#f1f4f6',
            secondaryTextColor: '#172b3a', secondaryBorderColor: '#526477',
            tertiaryColor: '#f8fafc', tertiaryTextColor: '#172b3a', tertiaryBorderColor: '#67788a',
            lineColor: '#526477', textColor: '#172b3a', mainBkg: '#eaf2f8',
            nodeBorder: '#356681', clusterBkg: '#f8fafc', clusterBorder: '#67788a',
            edgeLabelBackground: '#ffffff', titleColor: '#172b3a',
            actorBkg: '#eaf2f8', actorBorder: '#356681', actorTextColor: '#172b3a',
            actorLineColor: '#526477', actorFontSize: '18px', messageFontSize: '18px',
            signalColor: '#526477', signalTextColor: '#172b3a',
            labelBoxBkgColor: '#fff4d6', labelBoxBorderColor: '#886116',
            labelTextColor: '#432f10', loopTextColor: '#432f10',
            noteBkgColor: '#fff4d6', noteBorderColor: '#886116', noteTextColor: '#432f10',
            activationBkgColor: '#eaf2f8', activationBorderColor: '#356681',
          },
        })
        await mermaid.parse(source)
        const result = await mermaid.render(`architecture-${id}`, source)
        const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement
        // Mermaid 11 has per-node classes for flowcharts, but no equivalent
        // participant style declaration. Its generated actor boxes carry their
        // declared participant name. Color only those explicitly tagged in the
        // source's external comment; do not infer ownership from display text.
        for (const name of external) {
          for (const actor of svg.querySelectorAll('rect.actor')) {
            if (actor.getAttribute('name') !== name) continue
            actor.setAttribute('style', 'fill:#f1f4f6;stroke:#526477;stroke-dasharray:5 3')
          }
        }
        return new XMLSerializer().serializeToString(svg)
      }, diagram)

      // The preview needs its own background: GitHub dark mode must not turn
      // dark SVG text into dark text on a transparent dark page. Cover exactly
      // the viewBox so negative origins or padding retain the same background.
      const box = rendered.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number)
      if (!box || box.length !== 4 || box.some(n => !Number.isFinite(n)) || box[2] <= 0 || box[3] <= 0) {
        throw new Error('Rendered SVG has no valid nonempty viewBox')
      }
      if (/<foreignObject\b|<script\b/.test(rendered)) throw new Error('Expected a standalone SVG without HTML or scripts')
      // The exported figure includes its question, scope and key. A reader who
      // opens just the image must not need the surrounding Markdown to decode
      // it. The inner SVG keeps Mermaid's coordinates, paths and marker IDs;
      // the frame only adds whitespace and text outside that drawing.
      const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      const width = Math.max(880, Math.ceil(box[2]) + 48)
      const height = Math.ceil(box[3]) + 180
      const sequence = diagram.source.startsWith('sequenceDiagram')
      const state = diagram.source.startsWith('stateDiagram')
      const classes = diagram.source.startsWith('classDiagram')
      const key = sequence ? 'Time runs downward. Solid arrow: request. Dashed arrow: reply or event.'
        : state ? 'Arrow: state change; its label is the trigger. Filled dot: starting state.'
        : classes ? 'Diamond: contains. Triangle: variant. Dotted arrow: reference. 2: two children.'
        : 'Arrow: read its label in the arrow direction. Cylinder: stored data. Diamond: a check.'
      const inner = rendered.replace(/<svg\b[^>]*>/, match => match
        .replace(/\s(?:width|height|style|x|y)="[^"]*"/g, '')
        .replace('<svg', `<svg x="${(width - box[2]) / 2}" y="92" width="${box[2]}" height="${box[3]}"`))
      const svg = '<!-- Generated from ARCHITECTURE.md by scripts/render-architecture-diagrams.mjs. Do not edit directly. -->\n'
        + `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${diagram.id}-title ${diagram.id}-description">`
        + `<title id="${diagram.id}-title">${escapeXml(diagram.title)}</title><desc id="${diagram.id}-description">${escapeXml(diagram.description)}</desc>`
        + `<rect width="${width}" height="${height}" fill="#ffffff"/>`
        + `<text x="24" y="34" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#172b3a">${escapeXml(diagram.title)}</text>`
        + `<text x="24" y="61" font-family="Arial, sans-serif" font-size="16" fill="#435668">${escapeXml(diagram.scope)}</text>`
        + inner
        + `<path d="M24 ${height - 69}H${width - 24}" stroke="#67788a"/>`
        + `<text x="24" y="${height - 43}" font-family="Arial, sans-serif" font-size="16" fill="#172b3a">Blue: Agent Code · Gray / dashed border: external · Amber: checks and cautions</text>`
        + `<text x="24" y="${height - 18}" font-family="Arial, sans-serif" font-size="16" fill="#172b3a">${key}</text></svg>\n`
      const file = join(outputDir, `${diagram.id}.svg`)
      if (check) {
        const previous = await readFile(file, 'utf8').catch(() => null)
        if (previous !== svg) throw new Error('Preview is missing or differs from rendered source')
      } else {
        await writeFile(file, svg)
      }
    } catch (error) {
      failures.push(`${diagram.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} finally {
  await browser.close()
}

for (const failure of failures) console.error(failure)
console.log(`${diagrams.length - failures.length}/${diagrams.length} architecture diagrams ${check ? 'verified' : 'rendered'}`)
if (failures.length) process.exitCode = 1
