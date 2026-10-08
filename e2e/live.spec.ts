import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { MONOSPACE, THEME, cssAnimations, drawnRain, pseudoStyle, saveScreenshot } from './helpers'

// The themes in the real Standard Notes web app (app.standardnotes.com, no
// account), installed the way web users install them: by importing
// dist/cypherpunk-import.json. Run with `npm run build && npm run test:live`;
// it needs the network, so CI doesn't run it.
//
// Written against the web app v3.202.8 (October 2026). The selectors are the
// app's own accessible names; if a step times out, its UI has probably changed.
//
// Requests for the published GitHub Pages URLs are answered from dist/ at the
// browser context level, so editor frames get the local build too.

const APP = 'https://app.standardnotes.com/'
const SITE = 'https://nickstruglia.github.io/standard-notes-cypherpunk/'
const KEYFOLD = 'https://nickstruglia.github.io/standard-notes-keyfold/'
const IMPORT_FILE = fileURLToPath(new URL('../dist/cypherpunk-import.json', import.meta.url))
const DIST = new URL('../dist/', import.meta.url)
const WRITTEN_AGAINST = '3.202.8'

const BASE = 'Cypherpunk'
const RAIN = 'Cypherpunk Rain'
const SCANLINES = 'Cypherpunk Scanlines'
const STYLESHEETS = { [BASE]: `${SITE}index.css`, [RAIN]: `${SITE}rain/index.css`, [SCANLINES]: `${SITE}scanlines/index.css` }

const TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  zip: 'application/zip',
}

// Uses the app as a new visitor would, and keeps every request routable.
test.use({ serviceWorkers: 'block' })

/** Answers this project's GitHub Pages URLs from dist/ and lists the paths it served. */
async function serveDist(context: BrowserContext): Promise<string[]> {
  const served: string[] = []
  await context.route(`${SITE}**`, async (route) => {
    let path = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/standard-notes-cypherpunk\//, '')
    if (path === '' || path.endsWith('/')) path += 'index.html'
    served.push(path)
    try {
      const body = await readFile(new URL(path, DIST))
      const type = TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream'
      await route.fulfill({ status: 200, headers: { 'content-type': type, 'access-control-allow-origin': '*' }, body })
    } catch {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' })
    }
  })
  return served
}

let served: string[] = []
test.beforeEach(async ({ context }) => {
  served = await serveDist(context)
})

/** Uncaught errors in the page, and any error that involves our files. */
function watch(page: Page) {
  const crashes: string[] = []
  const ours: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => crashes.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    consoleErrors.push(message.text())
    if (message.text().includes(SITE)) ours.push(message.text())
  })
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(SITE)) ours.push(`${request.url()}: ${request.failure()?.errorText}`)
  })
  page.on('response', (response) => {
    if (response.url().startsWith(SITE) && response.status() >= 400) ours.push(`${response.url()}: HTTP ${response.status()}`)
  })
  return { crashes, ours, console: consoleErrors }
}

/** True when the element exists and nothing covers it (phone panes slide over each other). */
const onTop = (locator: Locator) =>
  locator.evaluateAll((elements) =>
    elements.some((element) => {
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return Boolean(hit && element.contains(hit))
    }),
  )

/** Opens the app, notes its version, and clears the first-launch account menu and backup warning. */
async function openApp(page: Page, phone: boolean, testInfo: TestInfo): Promise<void> {
  await page.goto(APP, { waitUntil: 'load', timeout: 90_000 })
  await expect(page.locator('#items-column')).toBeVisible({ timeout: 90_000 })

  const account = page.getByRole('list', { name: 'General account menu' })
  await expect(account).toBeVisible({ timeout: 30_000 })
  const version = /v(\d+\.\d+\.\d+)/.exec((await account.getByRole('menuitem', { name: /^Help & feedback/ }).textContent()) ?? '')?.[1]
  testInfo.annotations.push({ type: 'Standard Notes web app', description: `v${version} (written against v${WRITTEN_AGAINST})` })

  // The close control on desktop is an icon next to the menu's title, not a button.
  if (phone) await page.getByRole('button', { name: 'Done', exact: true }).click()
  else await page.getByText('Account', { exact: true }).filter({ visible: true }).locator('xpath=following-sibling::*[1]').click()
  await expect(account).toBeHidden()
  if (phone) await arrive(page, openNavigation(page))
  await page.getByRole('button', { name: 'Ignore warning' }).click() // the "Data not backed up" card
}

/**
 * On phones the panes slide over each other. Waits until the target is in
 * front and the slide has finished, so the next click lands where it should.
 */
async function arrive(page: Page, target: Locator): Promise<void> {
  await expect.poll(() => onTop(target)).toBe(true)
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running'),
  )
}

const openNavigation = (page: Page) => page.getByRole('button', { name: 'Open navigation menu' }).filter({ visible: true })

/** Footer buttons on desktop; on phones they sit at the bottom of the navigation pane. */
async function footer(page: Page, phone: boolean, name: 'preferences' | 'quick settings menu'): Promise<void> {
  if (!phone) return page.getByRole('contentinfo').getByRole('button', { name: new RegExp(`^Open ${name}`) }).click()
  const button = page.getByRole('button', { name: `Go to ${name}` })
  if (await onTop(openNavigation(page))) {
    await openNavigation(page).click()
    await arrive(page, button)
  }
  await button.click()
}

const preferencesDialog = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Close preferences|Back)$/ }) })

/** Opens Preferences at a section: a side menu on desktop, a drop-down on phones. */
async function openPreferences(page: Page, phone: boolean, section: string): Promise<Locator> {
  await footer(page, phone, 'preferences')
  const preferences = preferencesDialog(page)
  if (phone) {
    await preferences.getByRole('combobox', { name: 'Preferences Menu' }).click()
    await page.getByRole('option', { name: section, exact: true }).click()
  } else {
    await preferences.getByText(section, { exact: true }).filter({ visible: true }).click()
  }
  return preferences
}

async function closePreferences(page: Page): Promise<void> {
  const preferences = preferencesDialog(page)
  await preferences.getByRole('button', { name: /^(Close preferences|Back)$/ }).filter({ visible: true }).click()
  await expect(preferences).toBeHidden()
}

/** Preferences > Backups > Import backup, with the file users download. */
async function importThemes(page: Page, phone: boolean): Promise<void> {
  const preferences = await openPreferences(page, phone, 'Backups')
  const chooser = page.waitForEvent('filechooser')
  await preferences.getByRole('button', { name: 'Import backup' }).click()
  await (await chooser).setFiles(IMPORT_FILE)
  await expect(page.getByText('Your data has been successfully imported.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await closePreferences(page)
}

/** The palette (quick settings) menu, where themes are picked and layers toggled. */
async function openQuickSettings(page: Page, phone: boolean): Promise<Locator> {
  await footer(page, phone, 'quick settings menu')
  const menu = page.getByRole('list', { name: 'Quick settings menu' })
  await expect(menu).toBeVisible()
  return menu
}

/**
 * Closes the menu. Phones then go back from the navigation pane to the note
 * list, since the app removes #items-column from the page while the
 * navigation pane is showing (and the layers only draw where it exists).
 */
async function closeQuickSettings(page: Page, phone: boolean): Promise<void> {
  // Escape would also close it on desktop, but hands focus back to the
  // button, which then shows its tooltip in the screenshots.
  if (phone) await page.getByRole('button', { name: 'Done', exact: true }).click()
  else await footer(page, phone, 'quick settings menu')
  await expect(page.getByRole('list', { name: 'Quick settings menu' })).toBeHidden()
  if (phone) {
    await page.getByRole('button', { name: 'Go to items list' }).click()
    await arrive(page, openNavigation(page))
  }
  await expect(page.locator('#items-column')).toBeVisible()
}

/** Toggles layers in the palette menu and checks the menu shows the new state. */
async function toggleLayers(page: Page, phone: boolean, layers: string[], on: boolean): Promise<void> {
  const menu = await openQuickSettings(page, phone)
  for (const layer of layers) {
    const item = menu.getByRole('menuitemcheckbox', { name: layer })
    await item.click()
    if (on) await expect(item).toBeChecked()
    else await expect(item).not.toBeChecked()
  }
  await closeQuickSettings(page, phone)
}

/** The theme stylesheets the app has added to <head>, with whether each has loaded. */
const themeLinks = (page: Page) =>
  page.evaluate(
    (site) =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .filter((link) => link.href.startsWith(site))
        .map((link) => ({ href: link.href, media: link.media, loaded: Boolean(link.sheet) })),
    SITE,
  )

const expectThemes = async (page: Page, names: (keyof typeof STYLESHEETS)[]) =>
  expect
    .poll(() => themeLinks(page), { timeout: 15_000 })
    .toEqual(names.map((name) => ({ href: STYLESHEETS[name], media: 'screen,print', loaded: true })))

const variable = (page: Page, name: string) =>
  page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name)

/**
 * Animations on pseudo-elements, where the layers draw. The app animates
 * elements of its own (the sync spinner), which have nothing to do with us.
 */
const layerAnimations = async (page: Page) => (await cssAnimations(page)).filter((animation) => animation.target.includes('::'))

/** No hover tooltip or focus ring left over from the last click in the shot. */
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await saveScreenshot(page, testInfo, name)
}

test('imports from cypherpunk-import.json and wears Cypherpunk', async ({ page, isMobile }, testInfo) => {
  const errors = watch(page)
  await openApp(page, isMobile, testInfo)
  await importThemes(page, isMobile)

  const menu = await openQuickSettings(page, isMobile)
  // The base theme is a main theme; the other two are layers.
  await expect(menu.getByRole('menuitemradio', { name: BASE, exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitemcheckbox', { name: RAIN })).toBeVisible()
  await expect(menu.getByRole('menuitemcheckbox', { name: SCANLINES })).toBeVisible()
  await menu.getByRole('menuitemradio', { name: BASE, exact: true }).click()
  await expect(menu.getByRole('menuitemradio', { name: BASE, exact: true })).toBeChecked()
  await expectThemes(page, [BASE])

  // The app parses this value for the browser's theme color, the phone status
  // bar and translucent menus; a value it can't parse throws.
  await expect.poll(() => variable(page, '--sn-stylekit-background-color')).toBe('#050805')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#050805')
  await expect(page.locator('body')).toHaveCSS('background-color', THEME.background)
  await expect(page.locator('body')).toHaveCSS('color', THEME.foreground)
  expect(await page.locator('body').evaluate((body) => getComputedStyle(body).fontFamily)).toMatch(MONOSPACE)

  // Translucent UI is on by default: menus get our background at 65% opacity.
  // (Phones show this menu as an opaque bottom sheet instead of a popover.)
  await expect(page.locator('body')).toHaveClass(/\btranslucent-ui\b/)
  expect(await variable(page, '--popover-background-color')).toBe('rgba(5, 8, 5, 0.65)')
  if (!isMobile) {
    const menuBackgrounds = await menu.evaluate((element) => {
      const colors: string[] = []
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        colors.push(getComputedStyle(node).backgroundColor)
      }
      return colors
    })
    expect(menuBackgrounds, 'no element behind the menu uses the translucent background').toContain('rgba(5, 8, 5, 0.65)')
  }

  await closeQuickSettings(page, isMobile)
  await shoot(page, testInfo, 'app-cypherpunk')
  expect(errors.crashes, 'uncaught errors in the app').toEqual([])
  expect(errors.ours, 'errors from our files').toEqual([])
})

test('Cypherpunk can be the automatic dark theme', async ({ page, isMobile }, testInfo) => {
  const errors = watch(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await openApp(page, isMobile, testInfo)
  await importThemes(page, isMobile)

  // Preferences > Appearance > Use system color scheme, then Cypherpunk as the dark theme.
  const preferences = await openPreferences(page, isMobile, 'Appearance')
  const systemScheme = preferences.locator('div.justify-between', {
    has: page.getByRole('heading', { name: 'Use system color scheme', exact: true }),
  })
  await systemScheme.locator('label').click()
  await expect(systemScheme.getByRole('checkbox')).toBeChecked()
  const darkTheme = preferences.getByRole('combobox', { name: 'Select the automatic dark theme' })
  await darkTheme.click()
  const options = page.getByRole('listbox', { name: 'Select the automatic dark theme' })
  await expect(options.getByRole('option', { name: BASE, exact: true })).toHaveCount(1)
  // Layers stack on a theme, so they are not offered as one.
  await expect(options.getByRole('option', { name: RAIN })).toHaveCount(0)
  await expect(options.getByRole('option', { name: SCANLINES })).toHaveCount(0)
  await options.getByRole('option', { name: BASE, exact: true }).click()
  await expect(darkTheme).toHaveText(BASE)
  await closePreferences(page)

  await page.emulateMedia({ colorScheme: 'dark' })
  await expectThemes(page, [BASE])
  await expect(page.locator('body')).toHaveCSS('background-color', THEME.background)
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#050805')
  await page.emulateMedia({ colorScheme: 'light' })
  await expectThemes(page, [])

  expect(errors.crashes, 'uncaught errors in the app').toEqual([])
  expect(errors.ours, 'errors from our files').toEqual([])
})

test('the Rain and Scanlines layers draw in the app and turn off again', async ({ page, isMobile }, testInfo) => {
  const errors = watch(page)
  await openApp(page, isMobile, testInfo)
  await importThemes(page, isMobile)

  const menu = await openQuickSettings(page, isMobile)
  await menu.getByRole('menuitemradio', { name: BASE, exact: true }).click()
  await closeQuickSettings(page, isMobile)
  await toggleLayers(page, isMobile, [RAIN, SCANLINES], true)
  await expectThemes(page, [BASE, RAIN, SCANLINES])

  // Wide screens get rain behind the panels, phones inside the note list.
  await expect.poll(() => drawnRain(page)).toEqual(isMobile ? ['#items-column::before'] : ['html::before', 'body::before'])
  const rain = await layerAnimations(page)
  expect(rain.length, 'no rain animation').toBeGreaterThan(0)
  for (const animation of rain) expect(animation.properties, animation.target).toEqual(['transform'])
  expect(rain.every((animation) => animation.playState === 'running'), 'the rain is not running').toBe(true)
  const scanlines = await pseudoStyle(page, 'html::after')
  expect(scanlines?.backgroundImage).toContain('repeating-linear-gradient')
  expect(scanlines?.pointerEvents).toBe('none')
  await shoot(page, testInfo, 'app-layers')

  await toggleLayers(page, isMobile, [RAIN], false)
  await expectThemes(page, [BASE, SCANLINES])
  await expect.poll(() => drawnRain(page)).toEqual([])
  expect(await layerAnimations(page)).toEqual([])
  expect((await cssAnimations(page)).filter((animation) => animation.name.startsWith('cp-'))).toEqual([])
  expect((await pseudoStyle(page, 'html::after'))?.backgroundImage).toContain('repeating-linear-gradient')

  await toggleLayers(page, isMobile, [SCANLINES], false)
  await expectThemes(page, [BASE])
  await expect.poll(async () => (await pseudoStyle(page, 'html::after'))?.content).toBe('none')

  expect(errors.crashes, 'uncaught errors in the app').toEqual([])
  expect(errors.ours, 'errors from our files').toEqual([])
})

// Why the README sends web users to the import file: the web app's Content
// Security Policy doesn't let it fetch a manifest from GitHub Pages.
test('the web app cannot install from the GitHub Pages manifest URL', async ({ page, isMobile }, testInfo) => {
  const errors = watch(page)
  await openApp(page, isMobile, testInfo)
  const preferences = await openPreferences(page, isMobile, 'Plugins')
  await preferences.getByPlaceholder('Enter Plugin URL').fill(`${SITE}ext.json`)
  // The gallery's Install buttons are disabled without a subscription; the custom one isn't.
  await preferences.getByRole('button', { name: 'Install', exact: true, disabled: false }).click()

  await expect(page.getByText(/Error downloading package details/)).toBeVisible({ timeout: 30_000 })
  // Blocked inside the page: the request never reached the network.
  expect(served).not.toContain('ext.json')
  expect(errors.console.join('\n')).toMatch(/Refused to connect to 'https:\/\/nickstruglia\.github\.io\/standard-notes-cypherpunk\/ext\.json'/)
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(preferences.getByText('No plugins installed.')).toBeVisible()
  expect(errors.crashes, 'uncaught errors in the app').toEqual([])
})

// Keyfold is a third-party editor that reads the theme variables. Its live demo
// runs outside Standard Notes, so the stylesheets are added the way the app
// adds them to editor frames.
test("Keyfold's live demo wears the theme and none of the rain", async ({ page }, testInfo) => {
  const errors = watch(page)
  await page.goto(KEYFOLD, { waitUntil: 'load', timeout: 60_000 })
  await expect(page.getByRole('main')).toBeVisible({ timeout: 30_000 })

  await page.evaluate(
    (urls) =>
      Promise.all(
        urls.map(
          (href) =>
            new Promise<void>((resolve, reject) => {
              const link = document.createElement('link')
              link.rel = 'stylesheet'
              link.media = 'screen,print'
              link.href = href
              link.onload = () => resolve()
              link.onerror = () => reject(new Error(`could not load ${href}`))
              document.head.append(link)
            }),
        ),
      ),
    [STYLESHEETS[BASE], STYLESHEETS[RAIN]],
  )

  const body = page.locator('body')
  await expect(body).toHaveCSS('background-color', THEME.background)
  await expect(body).toHaveCSS('color', THEME.foreground)
  expect(await body.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(MONOSPACE)
  for (const pseudo of ['html::before', 'html::after', 'body::before', 'body::after']) {
    expect((await pseudoStyle(page, pseudo))?.content, pseudo).toBe('none')
  }
  expect(await drawnRain(page)).toEqual([])
  expect(await cssAnimations(page)).toEqual([])

  await saveScreenshot(page, testInfo, 'keyfold-live')
  expect(errors.crashes, 'uncaught errors in Keyfold').toEqual([])
  expect(errors.ours, 'errors from our files').toEqual([])
})
