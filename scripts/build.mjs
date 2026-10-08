// Builds the published themes into dist/: for each theme its stylesheet,
// manifest (ext.json) and the zip the desktop app keeps for offline use, plus
// cypherpunk-import.json, a Standard Notes backup file holding all three
// themes.
//
// The import file exists because the web app cannot install a plugin from a
// URL on GitHub: its Content Security Policy blocks GitHub Pages, and it sends
// the request with credentials, which GitHub's wildcard CORS header does not
// allow. Importing a backup creates the same item that installing from a URL
// would, and works on every platform.
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { deflateRawSync, crc32 } from 'node:zlib'
import { assets } from './rain-svg.mjs'

const root = new URL('..', import.meta.url)
const path = (p) => new URL(p, root)
const pkg = JSON.parse(await readFile(path('package.json'), 'utf8'))

const slash = (url) => url.replace(/\/*$/, '/')
const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
// The deploy workflow passes the GitHub Pages URL, so forks publish manifests
// that point at their own copy.
export const SITE_URL = slash(process.env.SITE_URL || pkg.homepage)
export const IMPORT_FILE = 'cypherpunk-import.json'

export const THEMES = [
  {
    key: 'cypherpunk',
    name: 'Cypherpunk',
    identifier: 'io.github.nickstruglia.cypherpunk',
    description: pkg.description,
    src: 'src/cypherpunk.css',
    dir: '',
    zip: 'cypherpunk.zip',
    layerable: false,
    budget: 30 * 1024,
    dock_icon: { type: 'circle', background_color: '#00ff41', foreground_color: '#001a07', border_color: '#00ff41' },
  },
  {
    key: 'rain',
    name: 'Cypherpunk Rain',
    identifier: 'io.github.nickstruglia.cypherpunk.rain',
    description:
      'Digital rain behind the Standard Notes sidebar and note list. A layer: turn it on over Cypherpunk or any other theme.',
    src: 'src/rain.css',
    dir: 'rain/',
    zip: 'cypherpunk-rain.zip',
    layerable: true,
    budget: 60 * 1024,
    dock_icon: { type: 'circle', background_color: '#0b130d', foreground_color: '#00ff41', border_color: '#00ff41' },
  },
  {
    key: 'scanlines',
    name: 'Cypherpunk Scanlines',
    identifier: 'io.github.nickstruglia.cypherpunk.scanlines',
    description: 'Faint CRT scanlines over Standard Notes. A layer: turn it on over Cypherpunk or any other theme.',
    src: 'src/scanlines.css',
    dir: 'scanlines/',
    zip: 'cypherpunk-scanlines.zip',
    layerable: true,
    budget: 10 * 1024,
    dock_icon: { type: 'circle', background_color: '#050805', foreground_color: '#4fbf6a', border_color: '#2a7a40' },
  },
]

export const manifest = (theme) => ({
  identifier: theme.identifier,
  name: theme.name,
  content_type: 'SN|Theme',
  area: 'themes',
  version: pkg.version,
  description: theme.description,
  url: `${SITE_URL}${theme.dir}index.css`,
  download_url: `${SITE_URL}${theme.dir}${theme.zip}`,
  latest_url: `${SITE_URL}${theme.dir}ext.json`,
  marketing_url: repoUrl,
  ...(theme.layerable ? { layerable: true } : {}),
  dock_icon: theme.dock_icon,
})

/** SVG as a compact data: URI (URL-encoded, which is smaller than base64 for SVG). */
export const svgDataUri = (svg) =>
  'data:image/svg+xml,' +
  svg
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
    .replace(/"/g, "'")
    .replace(/[%#<>{}|\\^`]/g, encodeURIComponent)

/** Replaces url("inline:<name>") with the generated asset as a data: URI. */
const inline = (css, file) => {
  const generated = assets()
  return css.replace(/url\((["']?)inline:([\w-]+)\1\)/g, (_, _q, name) => {
    if (!(name in generated)) throw new Error(`${file}: unknown inline asset "${name}"`)
    return `url("${svgDataUri(generated[name])}")`
  })
}

/** Catches unbalanced braces, which make browsers drop the rest of the file. */
const validate = (css, file) => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  let depth = 0
  for (const [i, ch] of [...code].entries()) {
    if (ch === '{') depth++
    if (ch === '}' && --depth < 0) throw new Error(`${file}: unexpected "}" near "${code.slice(Math.max(0, i - 40), i + 1)}"`)
  }
  if (depth !== 0) throw new Error(`${file}: ${depth} unclosed "{"`)
}

// A minimal, deterministic zip writer (deflate, fixed 1980-01-01 timestamps),
// so the desktop app's offline copy is byte-for-byte reproducible.
export const zip = (files) => {
  const local = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const fileName = Buffer.from(name)
    const body = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(0, 10) // time 00:00
    header.writeUInt16LE(0x21, 12) // date 1980-01-01
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(fileName.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, fileName, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // made by
    entry.writeUInt16LE(20, 6) // version needed
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(fileName.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, fileName)
    offset += header.length + fileName.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** Name-based UUID (version 5), so importing the file twice targets the same items. */
const uuid = (name) => {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex') // RFC 4122 URL namespace
  const hash = createHash('sha1').update(namespace).update(name).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * A decrypted Standard Notes backup containing one theme item per theme, with
 * the same content the app stores when it installs a plugin from its manifest.
 */
export const importFile = () => {
  const date = '2026-01-01T00:00:00.000Z'
  return {
    version: '004',
    items: THEMES.map((theme) => {
      const ext = manifest(theme)
      return {
        uuid: uuid(`${repoUrl}#${theme.identifier}`),
        content_type: ext.content_type,
        created_at: date,
        updated_at: date,
        content: {
          area: ext.area,
          name: ext.name,
          package_info: ext,
          valid_until: new Date(0).toISOString(),
          hosted_url: ext.url,
          references: [],
          appData: {},
        },
      }
    }),
  }
}

export const build = async () => {
  for (const theme of THEMES) {
    const source = await readFile(path(theme.src), 'utf8')
    const banner = `/*! ${theme.name} ${pkg.version} | MIT License | ${repoUrl} */\n`
    const css = banner + inline(source, theme.src)
    validate(css, theme.src)
    const zipped = zip([
      { name: 'index.css', data: Buffer.from(css) },
      {
        name: 'package.json',
        data: Buffer.from(
          json({ name: theme.identifier, version: pkg.version, description: theme.description, license: pkg.license, sn: pkg.sn }),
        ),
      },
    ])

    const dir = path(`dist/${theme.dir}`)
    await mkdir(dir, { recursive: true })
    await writeFile(new URL('index.css', dir), css)
    await writeFile(new URL('ext.json', dir), json(manifest(theme)))
    await writeFile(new URL(theme.zip, dir), zipped)
  }
  await writeFile(path(`dist/${IMPORT_FILE}`), json(importFile()))

  // The site's front page is the preview: a mock of the Standard Notes layout
  // wearing the theme, with the install instructions.
  for (const [from, to] of [
    ['dev/preview.html', 'dist/index.html'],
    ['dev/editor.html', 'dist/editor.html'],
  ]) {
    if (existsSync(path(from))) await copyFile(path(from), path(to))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await build()
    console.log(`Built ${THEMES.length} themes for ${SITE_URL}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
