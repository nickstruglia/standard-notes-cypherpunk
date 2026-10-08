// Checks what the build publishes: each theme's stylesheet, manifest and
// offline zip, the import file, and that no forbidden words ship in the
// repository or in dist/. Run with `npm test`, which builds dist/ first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'
import { IMPORT_FILE, SITE_URL, THEMES, importFile, manifest, zip } from './build.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const slash = (url) => url.replace(/\/*$/, '/')
// Without SITE_URL the build must point at the canonical GitHub Pages site.
const canonical = !process.env.SITE_URL

const dist = (file) => {
  const full = join(root, 'dist', file)
  if (!existsSync(full)) throw new Error(`dist/${file} is missing: run "npm run build" (npm test does it first)`)
  return readFileSync(full)
}
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
const banner = (theme) => `/*! ${theme.name} ${pkg.version} | MIT License | ${repoUrl} */`

// ---- CSS scanning ---------------------------------------------------------

/**
 * Splits a stylesheet into comments, url() values and the remaining code, so
 * each can be checked on its own terms (the data: URIs legitimately contain
 * the SVG namespace URL, nothing else may).
 */
const scan = (css) => {
  const comments = []
  const urls = []
  let code = ''
  let i = 0
  const readString = (start) => {
    const quote = css[start]
    let end = start + 1
    while (end < css.length && css[end] !== quote) end += css[end] === '\\' ? 2 : 1
    if (end >= css.length) throw new Error(`unclosed string at offset ${start}`)
    return end
  }
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      if (end < 0) throw new Error(`unclosed comment at offset ${i}`)
      comments.push({ text: css.slice(i, end + 2), at: i })
      code += ' '
      i = end + 2
    } else if (css.slice(i, i + 4).toLowerCase() === 'url(' && !/[\w-]/.test(css[i - 1] ?? '')) {
      let j = i + 4
      while (/\s/.test(css[j])) j++
      let value
      if (css[j] === '"' || css[j] === "'") {
        const end = readString(j)
        value = css.slice(j + 1, end)
        j = end + 1
        while (/\s/.test(css[j])) j++
      } else {
        const end = css.indexOf(')', j)
        value = css.slice(j, end < 0 ? css.length : end).trim()
        j = end < 0 ? css.length : end
      }
      if (css[j] !== ')') throw new Error(`malformed url() at offset ${i}`)
      urls.push({ value, at: i })
      code += 'url()'
      i = j + 1
    } else if (css[i] === '"' || css[i] === "'") {
      const end = readString(i)
      code += css.slice(i, end + 1)
      i = end + 1
    } else {
      code += css[i++]
    }
  }
  return { comments, urls, code }
}

/** Rules with their enclosing at-rule preludes, from code that has no comments or url() values. */
const rules = (code) => {
  const found = []
  const stack = []
  let start = 0
  let quote = null
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') {
      stack.push({ prelude: code.slice(start, i).trim(), body: i + 1 })
      start = i + 1
    } else if (ch === '}') {
      const open = stack.pop()
      if (!open) throw new Error('unbalanced "}"')
      if (!open.prelude.startsWith('@')) {
        found.push({ prelude: open.prelude, at: stack.map((s) => s.prelude), body: code.slice(open.body, i) })
      }
      start = i + 1
    } else if (ch === ';') start = i + 1
  }
  if (stack.length) throw new Error(`${stack.length} unclosed "{"`)
  return found
}

/** Declarations of one rule body, as [property, value] pairs. */
const declarations = (body) => {
  const parts = ['']
  let quote = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') parts[parts.length - 1] += body[i++]
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ';') {
      parts.push('')
      continue
    }
    parts[parts.length - 1] += ch
  }
  return parts
    .map((d) => d.trim())
    .filter((d) => d.includes(':'))
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
}

/** Decodes a data: URI's payload as text. */
const decodeDataUri = (uri) => {
  const comma = uri.indexOf(',')
  assert.ok(comma > 0, `data: URI without a comma: ${uri.slice(0, 60)}`)
  const meta = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  return { type: meta.split(';')[0], text: /;base64$/i.test(meta) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload) }
}

// ---- Zip reading ----------------------------------------------------------

/** Reads a zip archive: just enough of the format to check the build's own output. */
const unzip = (buf) => {
  const end = buf.length - 22
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'end of central directory record is not at the end (no archive comment expected)')
  const count = buf.readUInt16LE(end + 10)
  assert.equal(buf.readUInt16LE(end + 8), count, 'entry counts disagree')
  const size = buf.readUInt32LE(end + 12)
  const offset = buf.readUInt32LE(end + 16)
  assert.equal(offset + size, end, 'central directory does not end where the end record starts')

  const entries = []
  let p = offset
  let expectedLocal = 0
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `central directory entry ${n} has a bad signature`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressed = buf.readUInt32LE(p + 20)
    const length = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    p += 46 + nameLength + extraLength + commentLength

    assert.equal(flags & 0x0008, 0, `${name}: data descriptors are not expected`)
    assert.equal(local, expectedLocal, `${name}: local header is not right after the previous entry`)
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name}: local header has a bad signature`)
    assert.equal(buf.readUInt32LE(local + 14), crc, `${name}: local and central CRCs differ`)
    assert.equal(buf.readUInt32LE(local + 18), compressed, `${name}: local and central sizes differ`)
    const localName = buf.readUInt16LE(local + 26)
    const localExtra = buf.readUInt16LE(local + 28)
    assert.equal(buf.toString('utf8', local + 30, local + 30 + localName), name, `${name}: local and central names differ`)
    const start = local + 30 + localName + localExtra
    const raw = buf.subarray(start, start + compressed)
    assert.ok(method === 0 || method === 8, `${name}: unsupported compression method ${method}`)
    let data
    try {
      data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    } catch (error) {
      assert.fail(`${name}: cannot inflate (${error.message})`)
    }
    assert.equal(data.length, length, `${name}: uncompressed size does not match`)
    assert.equal(crc32(data), crc, `${name}: CRC does not match the content`)
    entries.push({ name, data })
    expectedLocal = start + compressed
  }
  assert.equal(p, end, 'central directory has trailing bytes')
  assert.equal(expectedLocal, offset, 'bytes between the last entry and the central directory')
  return entries
}

// ---- Stylesheets ----------------------------------------------------------

const allowedNamespace = /\sxmlns(?::xlink)?=(['"])http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)\1/g

for (const theme of THEMES) {
  const file = `${theme.dir}index.css`

  test(`${theme.name}: ${file} starts with the banner and fits its budget`, (t) => {
    const css = dist(file).toString('utf8')
    assert.ok(css.startsWith(`${banner(theme)}\n`), `dist/${file} should start with the line ${banner(theme)}`)
    const size = Buffer.byteLength(css)
    t.diagnostic(`dist/${file}: ${kb(size)} of ${kb(theme.budget)}`)
    assert.ok(size <= theme.budget, `dist/${file} is ${kb(size)} (${size} bytes), over its ${kb(theme.budget)} budget`)
  })

  test(`${theme.name}: ${file} loads nothing from outside`, () => {
    const css = dist(file).toString('utf8')
    const { comments, urls, code } = scan(css)

    // The banner is the only place a web address may appear in plain text.
    assert.equal(comments[0]?.at, 0, 'the banner comment must come first')
    assert.equal(comments[0].text, banner(theme))
    for (const { text } of comments.slice(1)) {
      assert.doesNotMatch(text, /https?:/i, `comment with a web address: ${text.slice(0, 80)}`)
    }

    for (const { value } of urls) {
      const shown = value.slice(0, 60)
      assert.match(value, /^data:/, `url() that is not a data: URI: ${shown}`)
      const { type, text } = decodeDataUri(value)
      assert.match(type, /^(?:image|font)\//, `unexpected data: URI type "${type}"`)
      if (type !== 'image/svg+xml') continue
      // Inside an SVG the namespace declaration is the only allowed address;
      // references must stay within the document (#id).
      const svg = text.replace(allowedNamespace, '')
      assert.doesNotMatch(svg, /https?:|\/\/|javascript:|@import|<script|<foreignObject|\son\w+\s*=/i, `SVG data: URI loads or runs something: ${shown}`)
      for (const [, ref] of svg.matchAll(/href\s*=\s*['"]([^'"]*)['"]/gi)) assert.match(ref, /^#/, `SVG href outside the document: ${ref}`)
      for (const [, ref] of svg.matchAll(/url\(\s*['"]?([^'")]*)/gi)) assert.match(ref, /^#/, `SVG url() outside the document: ${ref}`)
    }

    const checks = [
      [/https?:/i, 'a web address'],
      [/@import/i, '@import'],
      [/["']inline:/, 'an unresolved inline: asset'],
      [/javascript:/i, 'javascript:'],
      [/(?<![\w-])expression\s*\(/i, 'expression()'],
      [/(?<![\w-])behavior\s*:/i, 'behavior:'],
      [/-moz-binding/i, '-moz-binding'],
      [/image-set\(\s*["']/i, 'image-set() with a plain file name'],
    ]
    for (const [pattern, what] of checks) {
      const match = code.match(pattern)
      assert.equal(match, null, `dist/${file} contains ${what}${match ? ` near "${code.slice(Math.max(0, match.index - 40), match.index + 40)}"` : ''}`)
    }
  })
}

test('the background color is a literal 6-digit hex wherever a theme sets it', () => {
  // The app parses this value for the phone status bar, the browser theme
  // color and translucent menus; anything but #rrggbb breaks that.
  const property = '--sn-stylekit-background-color'
  for (const theme of THEMES) {
    const found = rules(scan(dist(`${theme.dir}index.css`).toString('utf8')).code)
    const sets = found.flatMap((rule) =>
      declarations(rule.body)
        .filter(([name]) => name === property)
        .map(([, value]) => ({ rule, value: value.replace(/\s*!important$/i, '') })),
    )
    for (const { rule, value } of sets) {
      assert.match(value, /^#[0-9a-fA-F]{6}$/, `${theme.name}: ${property}: ${value} in "${[...rule.at, rule.prelude].join(' > ')}"`)
    }
    if (!theme.layerable) {
      const topLevel = sets.filter(({ rule }) => rule.at.length === 0 && rule.prelude.split(',').some((s) => s.trim() === ':root'))
      assert.ok(topLevel.length > 0, `${theme.name} must set ${property} in a top-level :root rule`)
    }
  }
})

// ---- Manifests ------------------------------------------------------------

test('there is one main theme, the rest are layers, each with its own files', () => {
  const main = THEMES.filter((theme) => !theme.layerable)
  assert.equal(main.length, 1, 'exactly one theme should be a main theme')
  assert.equal(main[0].dir, '', 'the main theme is published at the site root')
  for (const field of ['identifier', 'name', 'dir', 'zip']) {
    const values = THEMES.map((theme) => theme[field])
    assert.equal(new Set(values).size, values.length, `theme ${field}s must be unique: ${values.join(', ')}`)
  }
})

for (const theme of THEMES) {
  test(`${theme.name}: ${theme.dir}ext.json is a valid theme manifest`, () => {
    const ext = JSON.parse(dist(`${theme.dir}ext.json`).toString('utf8'))
    assert.deepEqual(ext, manifest(theme), `dist/${theme.dir}ext.json is stale`)

    for (const field of ['identifier', 'name', 'description', 'url', 'download_url', 'latest_url']) {
      assert.ok(typeof ext[field] === 'string' && ext[field].trim(), `${field} is required`)
    }
    assert.equal(ext.identifier, theme.identifier)
    assert.equal(ext.name, theme.name)
    assert.equal(ext.content_type, 'SN|Theme')
    assert.equal(ext.area, 'themes')
    assert.equal(ext.version, pkg.version, 'manifest version must match package.json')
    if (theme.layerable) assert.equal(ext.layerable, true, 'layers need "layerable": true')
    else assert.equal('layerable' in ext, false, 'only layers may be layerable')

    for (const [field, value] of Object.entries(ext).filter(([key]) => key.endsWith('_url') || key === 'url')) {
      assert.equal(new URL(value).protocol, 'https:', `${field} must be https: ${value}`)
    }
    assert.equal(ext.url, `${SITE_URL}${theme.dir}index.css`)
    assert.equal(ext.download_url, `${SITE_URL}${theme.dir}${theme.zip}`)
    assert.equal(ext.latest_url, `${SITE_URL}${theme.dir}ext.json`)
    if (canonical) assert.ok(ext.url.startsWith(slash(pkg.homepage)), `without SITE_URL, URLs must be on ${pkg.homepage}`)

    for (const [key, color] of Object.entries(ext.dock_icon ?? {}).filter(([key]) => key.endsWith('_color'))) {
      assert.match(color, /^#[0-9a-fA-F]{6}$/, `dock_icon.${key}`)
    }
  })
}

test('manifest identifiers are unique', () => {
  const ids = THEMES.map((theme) => JSON.parse(dist(`${theme.dir}ext.json`).toString('utf8')).identifier)
  assert.equal(new Set(ids).size, ids.length, ids.join(', '))
})

// ---- Import file ----------------------------------------------------------

test(`${IMPORT_FILE} holds one theme item per theme`, () => {
  const file = JSON.parse(dist(IMPORT_FILE).toString('utf8'))
  assert.deepEqual(file, importFile(), `dist/${IMPORT_FILE} is stale`)
  assert.equal(file.version, '004')
  assert.equal(file.items.length, THEMES.length)

  const uuids = file.items.map((item) => item.uuid)
  assert.equal(new Set(uuids).size, uuids.length, `uuids must be unique: ${uuids.join(', ')}`)
  for (const [i, theme] of THEMES.entries()) {
    const item = file.items[i]
    const ext = manifest(theme)
    assert.match(item.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `${theme.name}: not a version 5 UUID`)
    assert.equal(item.content_type, 'SN|Theme')
    for (const field of ['created_at', 'updated_at']) assert.ok(!Number.isNaN(Date.parse(item[field])), `${theme.name}: ${field}`)
    assert.equal(item.content.name, theme.name)
    assert.equal(item.content.area, 'themes')
    assert.deepEqual(item.content.package_info, ext)
    assert.equal(item.content.hosted_url, ext.url)
    assert.deepEqual(item.content.references, [])
    assert.equal(item.content.package_info.layerable === true, theme.layerable, `${theme.name}: layerable only on layers`)
  }
})

// ---- Zips -----------------------------------------------------------------

for (const theme of THEMES) {
  const file = `${theme.dir}${theme.zip}`

  test(`${theme.name}: ${file} holds the stylesheet and package.json`, () => {
    const archive = dist(file)
    const entries = unzip(archive)
    assert.deepEqual(
      entries.map((e) => e.name),
      ['index.css', 'package.json'],
    )
    const [css, json] = entries
    assert.ok(css.data.equals(dist(`${theme.dir}index.css`)), `index.css in ${file} differs from dist/${theme.dir}index.css`)

    const info = JSON.parse(json.data.toString('utf8'))
    assert.equal(info.name, theme.identifier)
    assert.equal(info.version, pkg.version)
    assert.equal(info.license, pkg.license)
    assert.equal(info.sn?.main, 'index.css')

    // Rezipping the same entries must give the same bytes: the published zip
    // is reproducible.
    assert.ok(zip(entries).equals(archive), `${file} is not what zip() produces for its own entries`)
  })
}

test('zip() is deterministic and round-trips', () => {
  const files = [
    { name: 'index.css', data: Buffer.from(':root { --x: #000000; }\n'.repeat(50)) },
    { name: 'package.json', data: Buffer.from('{"sn":{"main":"index.css"}}\n') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]
  const first = zip(files)
  assert.ok(first.equals(zip(files.map((f) => ({ ...f, data: Buffer.from(f.data) })))), 'same input, different bytes')
  assert.deepEqual(
    unzip(first).map((e) => [e.name, e.data.toString('hex')]),
    files.map((f) => [f.name, f.data.toString('hex')]),
  )
})

// ---- Forbidden words ------------------------------------------------------

// Words that must never ship: a trademark this project keeps out of its name,
// docs and artwork, and attributions to writing tools. The bracketed letters
// keep this file from matching its own patterns.
const FORBIDDEN = [/m[a]trix/i, /\b(?:c[l]aude|a[n]thropic|c[h]atgpt|o[p]enai|c[o]pilot|a[i]-generated|g[e]nerated\s+by)\b/i]
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'test-results', 'playwright-report', 'dist'])
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|zip|gz|woff2?|ttf|otf|pdf|mp4|webm)$/i

const walk = (dir, skip = new Set()) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(path, skip)
    return entry.isFile() ? [path] : []
  })

/** Files in the repository: tracked plus new ones git does not ignore, or the whole tree without git. */
const repositoryFiles = () => {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean)
  return walk('', SKIP_DIRS)
}

test('no forbidden words in the repository or dist/', (t) => {
  const files = new Set([...repositoryFiles(), ...(existsSync(join(root, 'dist')) ? walk('dist') : [])])
  const hits = []
  let scanned = 0
  for (const file of [...files].sort()) {
    for (const pattern of FORBIDDEN) if (pattern.test(file)) hits.push(`${file}: file name`)
    const full = join(root, ...file.split('/'))
    if (BINARY.test(file) || !existsSync(full)) continue
    const data = readFileSync(full)
    if (data.subarray(0, 8000).includes(0)) continue
    scanned++
    for (const [n, line] of data.toString('utf8').split('\n').entries()) {
      for (const pattern of FORBIDDEN) {
        const match = line.match(pattern)
        if (match) hits.push(`${relative(root, full).split(sep).join('/')}:${n + 1}: "${match[0]}"`)
      }
    }
  }
  t.diagnostic(`scanned ${scanned} text files`)
  assert.ok(scanned > 0, 'found no files to scan')
  assert.deepEqual(hits, [])
})
