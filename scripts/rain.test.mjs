// Checks the rain tiles and the two layer stylesheets (Rain and Scanlines).
// Run with `npm test`, which builds dist/ first.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { GLYPHS, TILES, assets, tileSize } from './rain-svg.mjs'
import { THEMES, build } from './build.mjs'

const root = new URL('..', import.meta.url)
const theme = (key) => THEMES.find((t) => t.key === key)
const builtPath = (key) => new URL(`dist/${theme(key).dir}index.css`, root)

let rainCss
let scanCss

before(async () => {
  if (!existsSync(builtPath('rain')) || !existsSync(builtPath('scanlines'))) await build({ check: true })
  rainCss = await readFile(builtPath('rain'), 'utf8')
  scanCss = await readFile(builtPath('scanlines'), 'utf8')
})

/** A tiny CSS block parser: enough to see which rules sit inside which at-rules. */
const parse = (css) => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const top = { prelude: '', text: '', children: [] }
  const stack = [top]
  let buffer = ''
  let quote = null
  for (const ch of code) {
    if (quote) {
      buffer += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
    } else if (ch === '{') {
      const node = { prelude: buffer.trim(), text: '', children: [] }
      stack.at(-1).children.push(node)
      stack.push(node)
      buffer = ''
    } else if (ch === '}') {
      stack.pop().text += buffer
      buffer = ''
    } else if (ch === ';' && stack.length > 1) {
      stack.at(-1).text += buffer + ';'
      buffer = ''
    } else {
      buffer += ch
    }
  }
  top.text += buffer
  return top
}

/** Every node, with the at-rule preludes around it. */
const walk = function* (node, context = []) {
  for (const child of node.children) {
    yield { node: child, context }
    yield* walk(child, [...context, child.prelude])
  }
}

const declarations = (text) =>
  text
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])

// ---- Glyphs -------------------------------------------------------------

test('glyphs are 5x7 dot bitmaps', () => {
  assert.ok(GLYPHS.length >= 24 && GLYPHS.length <= 52, `${GLYPHS.length} glyphs`)
  for (const [i, glyph] of GLYPHS.entries()) {
    assert.equal(glyph.length, 7, `glyph ${i} has 7 rows`)
    for (const row of glyph) assert.match(row, /^[#.]{5}$/, `glyph ${i} row "${row}"`)
    assert.ok(glyph.join('').includes('#'), `glyph ${i} is not blank`)
  }
})

test('glyphs are all different', () => {
  const seen = new Map()
  for (const [i, glyph] of GLYPHS.entries()) {
    const key = glyph.join('/')
    assert.ok(!seen.has(key), `glyph ${i} repeats glyph ${seen.get(key)}`)
    seen.set(key, i)
  }
})

// ---- Tiles --------------------------------------------------------------

test('tiles are deterministic', () => {
  assert.deepEqual(assets(), assets())
  assert.deepEqual(Object.keys(assets()).sort(), Object.keys(TILES).sort())
})

test('tiles are self-contained, well-formed SVG', () => {
  for (const [name, svg] of Object.entries(assets())) {
    const { width, height } = tileSize(name)
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, name)
    assert.match(svg, new RegExp(`^<svg [^>]*\\bwidth="${width}" height="${height}" viewBox="0 0 \\d+ \\d+"`), name)
    assert.ok(svg.endsWith('</svg>'), name)
    assert.equal(svg.replaceAll('http://www.w3.org/2000/svg', '').match(/https?:/), null, `${name}: no other URLs`)
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|<style|@import|url\(|javascript:|\bon\w+=/i, name)
    for (const [, ref] of svg.matchAll(/href="([^"]*)"/g)) assert.match(ref, /^#\w+$/, `${name}: href ${ref}`)

    // Every tag closes, in order.
    const open = []
    for (const [tag, closing, tagName, selfClosing] of svg.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
      if (selfClosing) continue
      if (closing) assert.equal(open.pop(), tagName, `${name}: ${tag}`)
      else open.push(tagName)
    }
    assert.deepEqual(open, [], `${name}: unclosed tags`)

    // Every referenced glyph is defined.
    const ids = new Set([...svg.matchAll(/<path id="(\w+)"/g)].map((m) => m[1]))
    for (const [, id] of svg.matchAll(/href="#(\w+)"/g)) assert.ok(ids.has(id), `${name}: #${id} defined`)
  }
})

test('tiles hold columns of trails, each with a bright head', () => {
  for (const [name, svg] of Object.entries(assets())) {
    const heads = svg.match(/<g stroke="#[0-9a-f]{6}">(.*?)<\/g>/)
    assert.ok(heads, `${name}: head group`)
    const headCount = heads[1].split('<use').length - 1
    const total = svg.split('<use').length - 1
    assert.ok(headCount >= 10, `${name}: ${headCount} heads`)
    assert.ok(total >= headCount * 5, `${name}: trails behind the heads`)
  }
})

// ---- Rain layer stylesheet ------------------------------------------------

test('rain CSS inlines every tile and nothing else', () => {
  assert.doesNotMatch(rainCss, /inline:/)
  assert.doesNotMatch(rainCss, /@import/)
  for (const [, url] of rainCss.matchAll(/url\(\s*["']?([^"')]*)/g)) assert.match(url, /^data:image\/svg\+xml,/)
  assert.equal(rainCss.replaceAll('http://www.w3.org/2000/svg', '').match(/https?:\/\/(?!github\.com\/nickstruglia\/)/), null)
})

for (const key of ['rain', 'scanlines']) {
  test(`${key} CSS: every rule sits inside @media screen`, () => {
    const css = key === 'rain' ? rainCss : scanCss
    const tree = parse(css)
    assert.equal(tree.text.trim(), '', 'no top-level declarations')
    assert.ok(tree.children.length > 0)
    for (const node of tree.children) assert.equal(node.prelude, '@media screen')
  })

  test(`${key} CSS: anything that draws is keyed to the main app`, () => {
    const css = key === 'rain' ? rainCss : scanCss
    for (const { node } of walk(parse(css))) {
      if (!declarations(node.text).some(([prop, value]) => prop === 'content' && value !== 'none')) continue
      for (const selector of node.prelude.split(',')) {
        assert.match(selector, /#items-column/, `"${selector.trim()}" only matches inside the app`)
      }
    }
  })
}

test('rain CSS honours reduced motion', () => {
  assert.match(rainCss, /@media \(prefers-reduced-motion: reduce\)/)
  const reduce = [...walk(parse(rainCss))].filter(({ context }) => context.some((c) => c.includes('prefers-reduced-motion')))
  assert.ok(reduce.some(({ node }) => declarations(node.text).some(([p, v]) => p === 'animation' && v === 'none')))
})

test('rain CSS switches off for reduced data, reduced transparency and forced colors', () => {
  const off = [...walk(parse(rainCss))].find(({ node }) => /prefers-reduced-data: reduce/.test(node.prelude))
  assert.ok(off, 'off switch')
  assert.match(off.node.prelude, /prefers-reduced-transparency: reduce/)
  assert.match(off.node.prelude, /forced-colors: active/)
  const rules = [...walk(off.node)].map(({ node }) => node)
  assert.ok(rules.some((r) => /::before/.test(r.prelude) && /content:\s*none/.test(r.text)), 'rain removed')
  assert.ok(rules.some((r) => /--cp-rain-panel:\s*100%/.test(r.text)), 'panels made solid')
})

test('rain keyframes move by exactly one tile, using transform only', () => {
  const frames = [...walk(parse(rainCss))].filter(({ node }) => node.prelude.startsWith('@keyframes'))
  assert.ok(frames.length >= 2, 'one animation per layer')
  for (const { node } of frames) {
    const name = node.prelude.replace('@keyframes', '').trim()
    for (const step of node.children) {
      for (const [prop] of declarations(step.text)) assert.equal(prop, 'transform', `${name} animates ${prop}`)
    }
    const tile = name.replace(/^cp-/, '')
    assert.ok(tile in TILES, `${name} matches a tile`)
    const end = node.children.find((s) => s.prelude === 'to')
    assert.match(end.text, new RegExp(`translate3d\\(0, ${tileSize(tile).height}px, 0\\)`), `${name} moves one tile`)
  }
  // Each animated layer starts one tile above the viewport and is one tile taller.
  for (const name of Object.keys(TILES)) {
    const h = tileSize(name).height
    const uses = [...walk(parse(rainCss))].filter(({ node }) => new RegExp(`animation: cp-${name} `).test(node.text))
    assert.ok(uses.length > 0, `${name} is used`)
    for (const { node } of uses) {
      assert.match(node.text, new RegExp(`top: -${h}px`), `${node.prelude}: top`)
      assert.match(node.text, new RegExp(`height: calc\\(100% \\+ ${h}px\\)`), `${node.prelude}: height`)
    }
  }
})

test('rain panels turn see-through only where color-mix() is supported', () => {
  const tree = parse(rainCss)
  for (const { node, context } of walk(tree)) {
    if (/color-mix\(/.test(node.text) && !node.prelude.startsWith('@')) {
      assert.ok(context.some((c) => c.startsWith('@supports') && c.includes('color-mix')), node.prelude)
    }
  }
})

// ---- Scanlines layer stylesheet ---------------------------------------------

test('scanlines never intercept the pointer and never move', () => {
  const drawing = [...walk(parse(scanCss))].filter(({ node }) => /content:\s*""/.test(node.text))
  assert.ok(drawing.length > 0)
  for (const { node } of drawing) {
    assert.match(node.text, /pointer-events:\s*none/)
    assert.match(node.text, /repeating-linear-gradient/)
  }
  assert.doesNotMatch(scanCss, /@keyframes|animation/)
  assert.doesNotMatch(scanCss, /url\(/)
})

test('scanlines switch off for more contrast and forced colors', () => {
  const off = [...walk(parse(scanCss))].find(({ node }) => /prefers-contrast: more/.test(node.prelude))
  assert.ok(off)
  assert.match(off.node.prelude, /forced-colors: active/)
  assert.match(off.node.children[0].text, /content:\s*none/)
})

test('rain and scanlines draw on different pseudo-elements', () => {
  const pseudos = (css) =>
    new Set(
      [...walk(parse(css))]
        .filter(({ node }) => /content:\s*""/.test(node.text))
        .flatMap(({ node }) => node.prelude.split(','))
        .map((s) => s.trim().replace(/:has\([^)]*\)/g, '').replace(/^.*\s/, '')),
    )
  const rain = pseudos(rainCss)
  const scan = pseudos(scanCss)
  assert.ok(rain.has('html::before') && rain.has('body::before'), [...rain].join(' '))
  assert.ok(scan.has('html::after'), [...scan].join(' '))
  for (const p of scan) assert.ok(!rain.has(p), `${p} used by both layers`)
})

// ---- Budgets ----------------------------------------------------------------

test('layer stylesheets stay within budget', () => {
  assert.ok(Buffer.byteLength(rainCss) < theme('rain').budget, `rain: ${Buffer.byteLength(rainCss)} bytes`)
  assert.ok(Buffer.byteLength(scanCss) < theme('scanlines').budget, `scanlines: ${Buffer.byteLength(scanCss)} bytes`)
  assert.ok(Buffer.byteLength(rainCss) < 60 * 1024)
  assert.ok(Buffer.byteLength(scanCss) < 10 * 1024)
})
