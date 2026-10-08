// Takes the README screenshots in the real Standard Notes web app
// (app.standardnotes.com, no account), wearing the local build:
//
//   npm run build && npm run screenshots
//
// Writes docs/screenshot.png (desktop, Cypherpunk), docs/screenshot-rain.png
// (desktop, Cypherpunk + Rain) and docs/screenshot-mobile.png (Pixel 7,
// Cypherpunk + Rain). Requests for the published GitHub Pages URLs are
// answered from dist/, so the shots show this checkout, not the deployed site.
// The themes are installed the way web users do it: by importing
// dist/cypherpunk-import.json. The sample notes come in through a second
// import, which is faster and steadier than typing them.
//
// Needs the network (through HTTPS_PROXY when set). Written against the web
// app v3.202.8; if a step times out, the app's UI has probably changed.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from '@playwright/test'

const root = new URL('..', import.meta.url)
const APP = 'https://app.standardnotes.com/'
const SITE = 'https://nickstruglia.github.io/standard-notes-cypherpunk/'
const IMPORT_FILE = new URL('dist/cypherpunk-import.json', root)
const SIZE_LIMIT = 400 * 1024

const TYPES = { css: 'text/css', json: 'application/json', html: 'text/html', zip: 'application/zip', svg: 'image/svg+xml' }

/** Answers GitHub Pages requests for this project from dist/ (main page and frames alike). */
async function serveDist(context) {
  await context.route(`${SITE}**`, async (route) => {
    let path = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/standard-notes-cypherpunk\//, '')
    if (path === '' || path.endsWith('/')) path += 'index.html'
    try {
      const body = await readFile(new URL(`dist/${path}`, root))
      const type = TYPES[path.split('.').pop()] ?? 'application/octet-stream'
      await route.fulfill({ status: 200, headers: { 'content-type': type, 'access-control-allow-origin': '*' }, body })
    } catch {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' })
    }
  })
}

// --- Sample notes ----------------------------------------------------------

// Super notes are stored as Lexical editor state (JSON).
const FORMAT = { plain: 0, bold: 1, code: 16 }
const text = (value, format = FORMAT.plain) => ({ detail: 0, format, mode: 'normal', style: '', text: value, type: 'text', version: 1 })
const node = (type, children, extra = {}) => ({ children, direction: 'ltr', format: '', indent: 0, type, version: 1, ...extra })
const paragraph = (...parts) =>
  node('paragraph', parts.map((part) => (typeof part === 'string' ? text(part) : part)), { textFormat: 0, textStyle: '' })
const heading = (tag, value) => node('heading', [text(value)], { tag })
const checklist = (items) =>
  node(
    'list',
    items.map(([value, checked], index) => node('listitem', [text(value)], { value: index + 1, checked })),
    { listType: 'check', start: 1, tag: 'ul' },
  )
const code = (language, lines) =>
  node(
    'code',
    lines.flatMap((line, index) => [...(index ? [{ type: 'linebreak', version: 1 }] : []), { ...text(line), type: 'code-highlight' }]),
    { language },
  )

const FIELD_GUIDE = 'Field guide: end-to-end encryption'

const fieldGuide = [
  paragraph('How this notebook stays private, in five minutes.'),
  heading('h2', 'What the server sees'),
  paragraph(
    'Every note is encrypted on this device with a key derived from the account password. The server keeps ciphertext, sizes and timestamps, and nothing it can read.',
  ),
  heading('h2', 'Habits'),
  checklist([
    ['Use a passphrase of six random words', true],
    ['Turn on two-factor authentication', true],
    ['Keep an offline backup and test restoring it', false],
    ['Lock the app with a passcode on shared machines', false],
  ]),
  heading('h2', 'Make a key pair'),
  code('bash', [
    "gpg --quick-generate-key 'Alice <alice@example.org>' ed25519 default 2y",
    'gpg --armor --export alice@example.org > alice.asc',
    'gpg --fingerprint alice@example.org',
  ]),
  paragraph('Publish ', text('alice.asc', FORMAT.code), ' and read the fingerprint aloud to anyone who needs to check it. The secret key never leaves this machine.'),
]

const NOTES = [
  {
    title: FIELD_GUIDE,
    super: fieldGuide,
    preview: 'How this notebook stays private, in five minutes.',
    tags: ['cryptography', 'privacy'],
  },
  {
    title: 'Threat model',
    text: [
      'What these notes protect, from whom, and how.',
      '',
      'Assets',
      '- notes, contacts, travel plans',
      '',
      'Adversaries',
      '- someone who steals the laptop',
      '- a hostile network at the airport',
      '- a service that gets breached',
      '',
      'Mitigations',
      '- full-disk encryption and a short screen lock',
      '- TLS everywhere, a VPN on public Wi-Fi',
      '- end-to-end encrypted sync, so a breach leaks only ciphertext',
    ],
    tags: ['privacy'],
  },
  {
    title: 'Key ceremony checklist',
    text: [
      'Making the long-term signing key, offline and in one sitting.',
      '',
      'Before',
      '[ ] offline laptop, fresh live USB',
      '[ ] two new hardware keys',
      '[ ] paper and pen for the fingerprint',
      '',
      'During',
      '[ ] generate the primary key offline',
      '[ ] add signing and encryption subkeys',
      '[ ] move the subkeys to both hardware keys',
      '',
      'After',
      '[ ] store the primary key backup in two places',
      '[ ] publish the public key',
      '[ ] wipe the live USB',
    ],
    tags: ['cryptography'],
  },
  {
    title: 'Passphrases',
    text: [
      'Six words from a 7,776-word list give about 77 bits of entropy.',
      'Roll real dice; words picked by hand are easier to guess.',
      '',
      'Format only, not a real one:',
      '  orbit-velvet-candle-harbor-sixty-moss',
      '',
      'One passphrase per vault. Never stored next to the device.',
    ],
    tags: ['cryptography'],
  },
  {
    title: 'Reading list',
    text: [
      'The specifications behind the tools in this notebook.',
      '',
      '- RFC 9106: Argon2, memory-hard key derivation',
      '- RFC 8439: ChaCha20 and Poly1305',
      '- RFC 7748: X25519 key agreement',
      '- Signal: X3DH and Double Ratchet specifications',
      '- Notes on forward secrecy and deniability',
    ],
    tags: ['reading', 'cryptography'],
  },
]

/** A decrypted Standard Notes backup holding the sample notes and their tags. */
function sampleBackup() {
  // Newest first in the list, a few hours apart.
  const newest = Date.parse('2026-10-07T21:40:00Z')
  const notes = NOTES.map((note, index) => {
    const date = new Date(newest - index * 3.5 * 3600_000).toISOString()
    const body = note.super ? JSON.stringify({ root: node('root', note.super) }) : note.text.join('\n')
    // The app derives the list preview when a note is saved; imported notes bring their own.
    const preview = note.preview ?? note.text[0]
    return {
      uuid: randomUUID(),
      content_type: 'Note',
      created_at: date,
      updated_at: date,
      content: {
        title: note.title,
        text: body,
        preview_plain: preview,
        ...(note.super ? { noteType: 'super', editorIdentifier: 'com.standardnotes.super-editor' } : {}),
        references: [],
        appData: {},
      },
      tags: note.tags,
    }
  })
  const tagNames = [...new Set(notes.flatMap((note) => note.tags))].sort()
  const tags = tagNames.map((title) => ({
    uuid: randomUUID(),
    content_type: 'Tag',
    created_at: notes.at(-1).created_at,
    updated_at: notes.at(-1).created_at,
    content: {
      title,
      references: notes.filter((note) => note.tags.includes(title)).map((note) => ({ uuid: note.uuid, content_type: 'Note' })),
      appData: {},
    },
  }))
  const items = [...notes.map(({ tags: _, ...note }) => note), ...tags]
  return { name: 'sample-notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: '004', items })) }
}

// --- Driving the app -------------------------------------------------------

/** True when the element exists and nothing covers it (phone panes slide over each other). */
const onTop = (locator) =>
  locator.evaluateAll((elements) =>
    elements.some((element) => {
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return Boolean(hit && element.contains(hit))
    }),
  )

async function openApp(page, phone) {
  await page.goto(APP, { waitUntil: 'load', timeout: 90_000 })
  await page.locator('#items-column').waitFor({ timeout: 90_000 })
  // The account menu opens by itself on first launch.
  const account = page.getByRole('list', { name: 'General account menu' })
  await account.waitFor({ timeout: 30_000 })
  if (phone) await page.getByRole('button', { name: 'Done', exact: true }).click()
  else await page.getByText('Account', { exact: true }).filter({ visible: true }).locator('xpath=following-sibling::*[1]').click()
  await account.waitFor({ state: 'hidden' })
  if (phone) await arrive(page, openNavigation(page))
  // The "Data not backed up" card above the note list.
  await page.getByRole('button', { name: 'Ignore warning' }).click()
}

/**
 * On phones the panes slide over each other. Waits until the target is in
 * front and the slide has finished, so the next click lands where it should.
 */
async function arrive(page, target) {
  for (const start = Date.now(); !(await onTop(target)); await page.waitForTimeout(100)) {
    if (Date.now() - start > 30_000) throw new Error(`${target} did not come to the front`)
  }
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running'),
  )
}

const openNavigation = (page) => page.getByRole('button', { name: 'Open navigation menu' }).filter({ visible: true })

/** Footer buttons on desktop; on phones they sit at the bottom of the navigation pane. */
async function footer(page, phone, name) {
  if (!phone) return page.getByRole('contentinfo').getByRole('button', { name: new RegExp(`^Open ${name}`) }).click()
  const button = page.getByRole('button', { name: `Go to ${name}` })
  if (await onTop(openNavigation(page))) {
    await openNavigation(page).click()
    await arrive(page, button)
  }
  await button.click()
}

async function importBackup(page, phone, file) {
  await footer(page, phone, 'preferences')
  const preferences = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Close preferences|Back)$/ }) })
  if (phone) {
    await preferences.getByRole('combobox', { name: 'Preferences Menu' }).click()
    await page.getByRole('option', { name: 'Backups', exact: true }).click()
  } else {
    await preferences.getByText('Backups', { exact: true }).filter({ visible: true }).click()
  }
  const chooser = page.waitForEvent('filechooser')
  await preferences.getByRole('button', { name: 'Import backup' }).click()
  await (await chooser).setFiles(file)
  await page.getByText('Your data has been successfully imported.').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await preferences.getByRole('button', { name: /^(Close preferences|Back)$/ }).filter({ visible: true }).click()
  await preferences.waitFor({ state: 'hidden' })
}

/** Picks themes in the palette (quick settings) menu: a name for the main theme, layers by name. */
async function chooseThemes(page, phone, { theme, layers = [] }) {
  await footer(page, phone, 'quick settings menu')
  if (theme) await page.getByRole('menuitemradio', { name: theme }).click()
  for (const layer of layers) await page.getByRole('menuitemcheckbox', { name: layer }).click()
  // Escape would also close it, but hands focus back to the button, which then shows its tooltip.
  if (phone) await page.getByRole('button', { name: 'Done', exact: true }).click()
  else await footer(page, phone, 'quick settings menu')
  await page.getByRole('list', { name: 'Quick settings menu' }).waitFor({ state: 'hidden' })
}

/** Waits until every stylesheet the app added for a theme has loaded. */
async function themesLoaded(page, count) {
  await page.waitForFunction(
    ([site, expected]) => {
      const links = [...document.querySelectorAll('link[rel=stylesheet]')].filter((link) => link.href.startsWith(site))
      return links.length === expected && links.every((link) => link.sheet)
    },
    [SITE, count],
  )
}

async function settle(page) {
  // No hover tooltips, focus rings or blinking caret in the shots.
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)
}

async function shoot(page, name) {
  const path = fileURLToPath(new URL(`docs/${name}`, root))
  await settle(page)
  // animations: 'disabled' parks the rain at its first frame.
  await page.screenshot({ path, animations: 'disabled' })
  const { size } = await stat(path)
  const kb = Math.round(size / 1024)
  console.log(`docs/${name}  ${kb} KB${size > SIZE_LIMIT ? '  (over the 400 KB budget)' : ''}`)
}

async function session(browser, options, phone, run) {
  const context = await browser.newContext({ ...options, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' })
  await serveDist(context)
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on('pageerror', (error) => console.warn(`page error: ${error.message}`))
  try {
    await openApp(page, phone)
    await importBackup(page, phone, sampleBackup())
    await importBackup(page, phone, fileURLToPath(IMPORT_FILE))
    await run(page)
  } finally {
    await context.close()
  }
}

async function main() {
  await stat(IMPORT_FILE).catch(() => {
    throw new Error('dist/cypherpunk-import.json is missing: run npm run build first')
  })
  await mkdir(new URL('docs/', root), { recursive: true })
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined
  const browser = await chromium.launch(proxy ? { proxy } : {})
  try {
    await session(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, false, async (page) => {
      await page.locator('#items-column').getByText(FIELD_GUIDE).click()
      await page.locator('#editor-column').getByText('Make a key pair').waitFor()
      await chooseThemes(page, false, { theme: 'Cypherpunk' })
      await themesLoaded(page, 1)
      await shoot(page, 'screenshot.png')
      await chooseThemes(page, false, { layers: ['Cypherpunk Rain'] })
      await themesLoaded(page, 2)
      await shoot(page, 'screenshot-rain.png')
    })

    // A phone shows one pane at a time: the note list, where the rain falls.
    const { deviceScaleFactor, ...pixel7 } = devices['Pixel 7']
    await session(browser, { ...pixel7, deviceScaleFactor: Math.min(deviceScaleFactor, 2) }, true, async (page) => {
      await chooseThemes(page, true, { theme: 'Cypherpunk', layers: ['Cypherpunk Rain'] })
      await themesLoaded(page, 2)
      await page.getByRole('button', { name: 'Go to items list' }).click()
      await arrive(page, openNavigation(page))
      await page.locator('#items-column').getByText(FIELD_GUIDE).waitFor()
      await shoot(page, 'screenshot-mobile.png')
    })
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
