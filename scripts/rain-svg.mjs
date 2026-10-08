// Generates the digital-rain tiles for the Cypherpunk Rain layer.
//
//   node scripts/rain-svg.mjs [rain-near|rain-far|glyphs]   print an SVG to inspect
//
// The build inlines each tile as a data: URI wherever src/rain.css says
// url("inline:<name>"). Output is byte-for-byte deterministic: a seeded PRNG
// picks the glyphs and trails, so rebuilding never changes the theme.
//
// The glyphs are an original set of 5x7 dot bitmaps drawn below: invented
// brush-stroke shapes (plus some mirrored), squared digits and a few symbols.
// No font is involved.
import { pathToFileURL } from 'node:url'

const STROKES = [
  ['#####', '....#', '...#.', '..##.', '..#..', '.#...', '#....'],
  ['..#..', '#####', '..#..', '.###.', '#.#.#', '..#..', '..#..'],
  ['#####', '#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  ['#.#.#', '#.#.#', '....#', '...#.', '..#..', '.#...', '#....'],
  ['####.', '...#.', '...#.', '#####', '...#.', '...#.', '..#..'],
  ['.#...', '#####', '.#..#', '.#..#', '.#.#.', '.#...', '.#...'],
  ['#####', '....#', '.##.#', '.#..#', '.####', '.....', '#####'],
  ['#....', '#.###', '#....', '#.###', '#....', '#....', '#####'],
  ['#...#', '.#.#.', '..#..', '#####', '..#..', '.#.#.', '#...#'],
  ['....#', '...##', '..#.#', '.#..#', '#...#', '....#', '....#'],
  ['#####', '#...#', '#.#.#', '#...#', '#####', '#....', '#....'],
  ['..#..', '..#..', '#####', '..#..', '..#..', '..##.', '..#.#'],
  ['###..', '#....', '#.#.#', '#..#.', '#.#.#', '#....', '###..'],
  ['#####', '...#.', '..#..', '.####', '..#..', '.#...', '#....'],
  ['#####', '.#.#.', '.#.#.', '.#.#.', '.#.#.', '#..#.', '...##'],
  ['#.#..', '.#...', '#.###', '....#', '...#.', '..#..', '.#...'],
  ['.....', '####.', '#..#.', '####.', '...#.', '...#.', '...##'],
  ['#...#', '.#.#.', '#.#.#', '.#.#.', '..#..', '..#..', '.##..'],
]

// Strokes that also appear flipped left to right, the way digital rain mixes
// mirrored characters in.
const MIRRORED = [0, 3, 4, 5, 9, 13, 15, 16]

const DIGITS = [
  ['#####', '#...#', '#..##', '#.#.#', '##..#', '#...#', '#####'],
  ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  ['#####', '....#', '....#', '#####', '#....', '#....', '#####'],
  ['#####', '....#', '....#', '.####', '....#', '....#', '#####'],
  ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  ['#####', '#....', '#....', '#####', '....#', '....#', '#####'],
  ['#....', '#....', '#....', '#####', '#...#', '#...#', '#####'],
  ['#####', '....#', '....#', '...#.', '..#..', '..#..', '..#..'],
  ['#####', '#...#', '#...#', '.###.', '#...#', '#...#', '#####'],
  ['#####', '#...#', '#...#', '#####', '....#', '....#', '....#'],
]

const SYMBOLS = [
  ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ['.....', '#####', '.....', '#####', '.....', '#####', '.....'],
  ['.....', '..#..', '.#.#.', '#...#', '.#.#.', '..#..', '.....'],
  ['#....', '.#...', '..#..', '...#.', '..#..', '.#...', '#....'],
]

const mirror = (glyph) => glyph.map((row) => [...row].reverse().join(''))

/** Every glyph as 7 rows of 5 characters, '#' for a lit dot. */
export const GLYPHS = [...STROKES, ...MIRRORED.map((i) => mirror(STROKES[i])), ...DIGITS, ...SYMBOLS]

// Layout in SVG units: one unit per dot, glyphs on an 8 x 9 grid (5 x 7 dots
// plus spacing). `scale` is CSS pixels per unit, so a tile's pixel size is
// cols * 8 * scale by rows * 9 * scale. src/rain.css animates each layer by
// exactly its tile height; scripts/rain.test.mjs checks the two agree.
const CELL_W = 8
const CELL_H = 9

/**
 * The parallax layers. The far layer is smaller, dimmer and denser; the near
 * one larger and sparser. `trails` is the chance a column carries a trail,
 * `second` the chance it carries another one further up.
 */
export const TILES = {
  'rain-far': { seed: 0x7a11, cols: 40, rows: 56, scale: 1.25, trails: 0.62, second: 0.4, length: [5, 17], head: '#c8f5d6', tail: '#22d957' },
  'rain-near': { seed: 0x5eed, cols: 40, rows: 40, scale: 2, trails: 0.52, second: 0.25, length: [7, 19], head: '#e4fff0', tail: '#2bff62' },
}

/** Tile size in CSS pixels. */
export const tileSize = (name) => {
  const t = TILES[name]
  return { width: t.cols * CELL_W * t.scale, height: t.rows * CELL_H * t.scale }
}

/** mulberry32: a tiny seeded PRNG, so the same seed always draws the same rain. */
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Short ids keep the inlined data: URI small.
const ID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * One glyph as a path of horizontal dot runs. The tile strokes every path with
 * a 0.8 dash and 0.2 gap, which turns each run into separate square dots.
 */
const glyphPath = (glyph) => {
  let d = ''
  glyph.forEach((row, y) => {
    for (const run of row.matchAll(/#+/g)) d += `M${run.index} ${y}h${run[0].length}`
  })
  return d
}

const opacity = (value) => String(Math.round(value * 100) / 100).replace(/^0\./, '.')

/** Builds one tile: columns of glyph trails that wrap top to bottom, so it repeats seamlessly. */
const tile = (name) => {
  const t = TILES[name]
  const random = prng(t.seed)
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const groups = new Map() // stroke opacity -> [glyph uses], '' = heads

  const place = (key, col, row) => {
    const x = col * CELL_W + 1
    const y = ((row + t.rows) % t.rows) * CELL_H + 1
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(`<use href="#${ID[int(0, GLYPHS.length - 1)]}" x="${x}" y="${y}"/>`)
  }

  const trail = (col, head, length) => {
    place('', col, head)
    for (let k = 1; k < length; k++) {
      // A short gap now and then keeps trails from looking like solid bars.
      if (k > 2 && random() < 0.06) continue
      const fade = 1 - k / length
      place(opacity(Math.max(0.05, 0.92 * fade ** 1.35)), col, head - k)
    }
  }

  for (let col = 0; col < t.cols; col++) {
    if (random() >= t.trails) continue
    const head = int(0, t.rows - 1)
    const length = int(...t.length)
    trail(col, head, length)
    if (random() < t.second) {
      const gap = int(4, 12)
      const next = int(...t.length)
      if (length + gap + next <= t.rows) trail(col, head - length - gap, next)
    }
  }

  const { width, height } = tileSize(name)
  const defs = GLYPHS.map((g, i) => `<path id="${ID[i]}" d="${glyphPath(g)}"/>`).join('')
  const body = [...groups.keys()]
    .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : Number(b) - Number(a)))
    .map((key) =>
      key === ''
        ? `<g stroke="${t.head}">${groups.get(key).join('')}</g>`
        : `<g stroke-opacity="${key}">${groups.get(key).join('')}</g>`,
    )
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${t.cols * CELL_W} ${t.rows * CELL_H}"` +
    ` fill="none" stroke="${t.tail}" stroke-width=".8" stroke-dasharray=".8 .2">` +
    `<defs>${defs}</defs>${body}</svg>`
  )
}

/** All glyphs on one sheet, for checking the drawings by eye. */
const sheet = () => {
  const cols = 10
  const rows = Math.ceil(GLYPHS.length / cols)
  const uses = GLYPHS.map((_, i) => `<use href="#${ID[i]}" x="${(i % cols) * CELL_W + 1}" y="${Math.floor(i / cols) * CELL_H + 1}"/>`)
  const defs = GLYPHS.map((g, i) => `<path id="${ID[i]}" d="${glyphPath(g)}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * CELL_W * 8}" height="${rows * CELL_H * 8}" viewBox="0 0 ${cols * CELL_W} ${rows * CELL_H}"` +
    ` fill="none" stroke="#2bff62" stroke-width=".8" stroke-dasharray=".8 .2"><rect width="100%" height="100%" fill="#050805" stroke="none"/>` +
    `<defs>${defs}</defs>${uses.join('')}</svg>`
  )
}

/** The SVGs the build can inline, by name. */
export const assets = () => Object.fromEntries(Object.keys(TILES).map((name) => [name, tile(name)]))

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2] || 'rain-near'
  if (name === 'glyphs') console.log(sheet())
  else if (name in TILES) console.log(tile(name))
  else {
    console.error(`Unknown tile "${name}". Try: ${[...Object.keys(TILES), 'glyphs'].join(', ')}`)
    process.exit(1)
  }
}
