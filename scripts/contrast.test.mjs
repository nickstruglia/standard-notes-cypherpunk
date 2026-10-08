// WCAG contrast checks for the built base theme (dist/index.css).
//
// Reads the custom properties of the top-level :root rules (screen) and of the
// :root rule inside @media print, resolves var() chains, and checks every
// text/background and UI pair the app draws. Run after "npm run build":
//   node --test scripts/contrast.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { THEMES } from './build.mjs'

const css = await readFile(new URL('../dist/index.css', import.meta.url), 'utf8')

// ---- CSS parsing ----------------------------------------------------------

/** Splits CSS into rules: { prelude, at: [enclosing at-rule preludes], body }. */
function parseRules(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const stack = []
  let start = 0
  let quote = null
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') {
      stack.push({ prelude: code.slice(start, i).trim(), bodyStart: i + 1 })
      start = i + 1
    } else if (ch === '}') {
      const open = stack.pop()
      if (!open) throw new Error('Unbalanced "}" in CSS')
      // At-rule blocks (@media, @supports) only group the rules inside them.
      if (!open.prelude.startsWith('@')) {
        rules.push({ prelude: open.prelude, at: stack.map((s) => s.prelude), body: code.slice(open.bodyStart, i) })
      }
      start = i + 1
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1 // top-level statement such as @charset
    }
  }
  return rules
}

/** Splits a declaration block on top-level semicolons. */
function declarations(body) {
  const out = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if ((ch === ';' && depth === 0) || i === body.length) {
      const decl = body.slice(start, i).trim()
      start = i + 1
      const colon = decl.indexOf(':')
      if (colon > 0) out.push([decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()])
    }
  }
  return out
}

const isRoot = (prelude) => prelude.split(',').some((s) => s.trim() === ':root')
const isPrint = (at) => /^@media\b/.test(at) && /\bprint\b/.test(at)

/** Custom properties of :root rules: screen = top level, print = screen + @media print. */
function rootProperties(source) {
  const screen = {}
  const printOnly = {}
  for (const rule of parseRules(source)) {
    if (!isRoot(rule.prelude)) continue
    const target = rule.at.length === 0 ? screen : rule.at.length === 1 && isPrint(rule.at[0]) ? printOnly : null
    if (!target) continue
    for (const [name, value] of declarations(rule.body)) if (name.startsWith('--')) target[name] = value
  }
  // The theme loads with media="screen,print", so top-level rules apply in print too.
  return { screen, print: { ...screen, ...printOnly }, printOnly }
}

/** Replaces var(--name, fallback) references until none are left. */
function resolve(value, vars, seen = []) {
  let out = ''
  let i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at === -1) {
      out += value.slice(i)
      break
    }
    out += value.slice(i, at)
    let depth = 1
    let j = at + 4
    for (; j < value.length && depth; j++) {
      if (value[j] === '(') depth++
      else if (value[j] === ')') depth--
    }
    const inner = value.slice(at + 4, j - 1)
    const comma = inner.indexOf(',')
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim()
    if (seen.includes(name)) throw new Error(`Circular var(): ${[...seen, name].join(' -> ')}`)
    if (name in vars) out += resolve(vars[name], vars, [...seen, name])
    else if (fallback !== null) out += resolve(fallback, vars, seen)
    else throw new Error(`${seen.at(-1) ?? 'value'} uses undefined ${name}`)
    i = j
  }
  return out.trim()
}

// ---- Colors ---------------------------------------------------------------

const NAMED = { black: '#000000', white: '#ffffff', transparent: '#00000000' }

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba() into { r, g, b, a }. */
function parseColor(input) {
  const text = (NAMED[input.trim().toLowerCase()] ?? input).trim()
  const hex = text.match(/^#([0-9a-f]{3,8})$/i)
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (k) => parseInt(h.slice(k, k + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = text.match(/^rgba?\((.*)\)$/i)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length === 3 || parts.length === 4) {
      const channel = (p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p))
      const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
      const [r, g, b] = parts.slice(0, 3).map(channel)
      if ([r, g, b, alpha].every(Number.isFinite)) return { r, g, b, a: alpha }
    }
  }
  throw new Error(`Cannot parse color "${input}"`)
}

/** Paints a (possibly translucent) color over an opaque one. */
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})

const luminance = ({ r, g, b }) => {
  const lin = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const hex = ({ r, g, b }) => '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')

// ---- Pairs ----------------------------------------------------------------

const TEXT = 4.5
const UI = 3
const PRINT = 7
const k = (name) => `--sn-stylekit-${name}`
const BG = k('background-color')
const SURFACES = [BG, k('secondary-background-color'), k('contrast-background-color')]

/** Text color on each of the three main surfaces. */
const onSurfaces = (fg, min = TEXT) => SURFACES.map((bg) => [fg, bg, min])

// [foreground, background, minimum]. A background may be "top over base" for
// translucent layers, and a foreground may be "border:<var>" to read the color
// out of a border shorthand.
const SCREEN_PAIRS = [
  ...onSurfaces(k('foreground-color')),
  [k('foreground-color'), k('editor-background-color'), TEXT],
  [k('editor-foreground-color'), k('editor-background-color'), TEXT],
  [k('paragraph-text-color'), k('editor-background-color'), TEXT],
  ...onSurfaces(k('paragraph-text-color')),
  [k('secondary-foreground-color'), k('secondary-background-color'), TEXT],
  [k('contrast-foreground-color'), k('contrast-background-color'), TEXT],
  [k('secondary-contrast-foreground-color'), k('secondary-contrast-background-color'), TEXT],
  ...onSurfaces(k('info-color')),
  ...onSurfaces('--link-element-color'),
  [k('info-contrast-color'), k('info-color'), TEXT],
  ...onSurfaces(k('neutral-color')),
  [k('neutral-contrast-color'), k('neutral-color'), TEXT],
  ...onSurfaces(k('passive-color-0')),
  ...onSurfaces(k('passive-color-1')),
  [k('success-contrast-color'), k('success-color'), TEXT],
  [k('warning-contrast-color'), k('warning-color'), TEXT],
  [k('danger-contrast-color'), k('danger-color'), TEXT],
  ...onSurfaces(k('success-color')),
  ...onSurfaces(k('warning-color')),
  ...onSurfaces(k('danger-color')),
  [k('danger-color'), k('danger-light-color'), TEXT],
  ...onSurfaces(k('input-placeholder-color')),
  ['--navigation-item-text-color', '--navigation-column-background-color', TEXT],
  ['--navigation-item-text-color', '--navigation-item-selected-background-color', TEXT],
  [k('info-color'), '--navigation-item-selected-background-color', TEXT],
  ['--navigation-section-title-color', '--navigation-column-background-color', TEXT],
  ['--navigation-item-count-color', '--navigation-column-background-color', TEXT],
  [k('foreground-color'), '--item-cell-selected-background-color', TEXT],
  [k('info-color'), '--item-cell-selected-background-color', TEXT],
  ['--editor-title-input-color', k('editor-background-color'), TEXT],
  ['--text-selection-color', '--text-selection-background-color', TEXT],
  [k('foreground-color'), '--popover-background-color', TEXT],
  [k('foreground-color'), '--modal-background-color', TEXT],
  [k('foreground-color'), '--preferences-background-color', TEXT],
  [k('foreground-color'), '--preferences-navigation-selected-background-color', TEXT],
  [k('foreground-color'), '--normal-button-background-color', TEXT],
  [k('info-color'), '--normal-button-background-color', TEXT],
  [k('danger-color'), '--normal-button-background-color', TEXT],
  [k('foreground-color'), k('passive-color-3'), TEXT],
  [k('foreground-color'), k('passive-color-4'), TEXT],
  [k('foreground-color'), k('passive-color-5'), TEXT],
  [k('foreground-color'), `${k('passive-color-4-opacity-variant')} over ${BG}`, TEXT],
  [k('foreground-color'), `${k('info-backdrop-color')} over ${BG}`, TEXT],
  ['--sn-desktop-titlebar-ui-color', '--sn-desktop-titlebar-bg-color', TEXT],
  ['--sn-desktop-titlebar-ui-hover-color', '--sn-desktop-titlebar-bg-color', TEXT],

  ...onSurfaces(k('border-color'), UI),
  ...onSurfaces(k('input-border-color'), UI),
  [k('scrollbar-thumb-color'), BG, UI],
  [k('scrollbar-thumb-color'), k('secondary-background-color'), UI],
  [`border:${k('menu-border')}`, '--popover-background-color', UI],
  ['--popover-border-color', '--popover-background-color', UI],
  ['--item-cell-selected-border-left-color', '--item-cell-selected-background-color', UI],
  ['--sn-desktop-titlebar-border-color', '--sn-desktop-titlebar-bg-color', UI],
  // Focus rings are drawn in the info color.
  ...onSurfaces(k('info-color'), UI).map(([fg, bg]) => [fg, bg, UI, 'focus ring']),
  ...[1, 2, 3, 4, 5, 6].flatMap((n) =>
    [BG, k('secondary-background-color')].map((bg) => [k(`accessory-tint-color-${n}`), bg, UI]),
  ),
]

const PRINT_TEXT = [
  'foreground-color',
  'editor-foreground-color',
  'paragraph-text-color',
  'contrast-foreground-color',
  'secondary-foreground-color',
  'info-color',
  'neutral-color',
  'passive-color-0',
  'passive-color-1',
  'success-color',
  'warning-color',
  'danger-color',
  'input-placeholder-color',
].map(k)

const PRINT_PAIRS = [
  ...[...PRINT_TEXT, '--link-element-color', '--navigation-item-text-color', '--editor-title-input-color'].flatMap(
    (fg) => [BG, k('editor-background-color')].map((bg) => [fg, bg, PRINT]),
  ),
  [k('border-color'), BG, UI],
]

// ---- Evaluation -----------------------------------------------------------

function colorOf(ref, vars) {
  if (ref.startsWith('border:')) {
    const value = resolve(vars[ref.slice(7)] ?? '', vars)
    const color = value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i)
    if (!color) throw new Error(`No color in ${ref.slice(7)}: "${value}"`)
    return parseColor(color[0])
  }
  if (!(ref in vars)) throw new Error(`${ref} is not defined`)
  return parseColor(resolve(vars[ref], vars, [ref]))
}

function measure([fgRef, bgRef, min, note], vars) {
  const base = colorOf(BG, vars)
  const [top, under] = bgRef.split(' over ')
  let bg = colorOf(top, vars)
  bg = over(bg, under ? over(colorOf(under, vars), base) : base)
  const fg = over(colorOf(fgRef, vars), bg)
  const label = `${fgRef.replace(/^border:/, '')} on ${bgRef}${note ? ` (${note})` : ''}`
  return { label, fg: hex(fg), bg: hex(bg), ratio: contrast(fg, bg), min }
}

const report = (t, rows) => {
  t.diagnostic('| Pair | Foreground | Background | Ratio | Minimum |')
  t.diagnostic('| --- | --- | --- | --- | --- |')
  for (const r of rows) t.diagnostic(`| ${r.label} | ${r.fg} | ${r.bg} | ${r.ratio.toFixed(2)}:1 | ${r.min}:1 |`)
}

const check = (rows) => {
  const failing = rows.filter((r) => r.ratio < r.min)
  assert.equal(
    failing.length,
    0,
    'Contrast too low:\n' +
      failing.map((r) => `  ${r.label}: ${r.fg} on ${r.bg} is ${r.ratio.toFixed(2)}:1, needs ${r.min}:1`).join('\n'),
  )
}

const { screen, print, printOnly } = rootProperties(css)

test('the base theme is self-contained and within budget', () => {
  const { budget } = THEMES.find((t) => t.key === 'cypherpunk')
  const size = Buffer.byteLength(css)
  assert.ok(size <= budget, `dist/index.css is ${size} bytes, budget ${budget}`)
  assert.doesNotMatch(css, /@import/i, 'no @import')
  const urls = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)].map((m) => m[2])
  const outside = urls.filter((u) => !u.startsWith('data:'))
  assert.deepEqual(outside, [], `only data: URLs are allowed, found: ${outside.join(', ')}`)
})

test('the background color is a literal 6-digit hex', () => {
  for (const [where, vars] of [
    ['screen', screen],
    ['print', print],
  ]) {
    const value = vars[BG]
    assert.ok(value, `${BG} is missing (${where})`)
    assert.match(value, /^#[0-9a-f]{6}$/i, `${BG} must be a literal #rrggbb for the app's parser (${where}), got "${value}"`)
  }
})

test('the theme declares itself dark and defines the colors the app reads', () => {
  assert.equal(screen[k('theme-type')], 'dark', `${k('theme-type')} must be "dark"`)
  const required = [
    ...['neutral', 'info', 'success', 'warning', 'danger'].flatMap((c) => [k(`${c}-color`), k(`${c}-contrast-color`)]),
    ...['background', 'foreground', 'border'].map((c) => k(`${c}-color`)),
    ...['contrast', 'secondary', 'secondary-contrast'].flatMap((s) =>
      ['background', 'foreground', 'border'].map((c) => k(`${s}-${c}-color`)),
    ),
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => k(`passive-color-${n}`)),
    ...[1, 2, 3, 4, 5, 6].map((n) => k(`accessory-tint-color-${n}`)),
    k('info-backdrop-color'),
    k('danger-light-color'),
    k('shadow-color'),
    k('editor-background-color'),
    k('editor-foreground-color'),
    k('paragraph-text-color'),
    k('input-placeholder-color'),
    k('input-border-color'),
    k('scrollbar-thumb-color'),
    k('passive-color-4-opacity-variant'),
    k('menu-border'),
    k('sans-serif-font'),
    k('monospace-font'),
    k('editor-font-family'),
    '--navigation-item-selected-background-color',
    '--normal-button-background-color',
    '--text-selection-color',
    '--text-selection-background-color',
    '--sn-desktop-titlebar-bg-color',
    '--sn-desktop-titlebar-ui-color',
  ]
  const missing = required.filter((name) => !(name in screen))
  assert.deepEqual(missing, [], `Missing from :root: ${missing.join(', ')}`)
  for (const name of required) assert.doesNotThrow(() => resolve(screen[name], screen, [name]), `${name} does not resolve`)
})

test('screen colors meet WCAG contrast (text 4.5:1, UI 3:1)', (t) => {
  const rows = SCREEN_PAIRS.map((pair) => measure(pair, screen))
  report(t, rows)
  check(rows)
})

test('print is black on white (text 7:1)', (t) => {
  assert.ok(Object.keys(printOnly).length > 0, 'No :root rule inside @media print')
  assert.equal(parseColor(print[BG]).r + parseColor(print[BG]).g + parseColor(print[BG]).b, 765, 'Print background must be white')
  const rows = PRINT_PAIRS.map((pair) => measure(pair, print))
  report(t, rows)
  check(rows)
})
