import { expect, test, type Locator, type Page } from '@playwright/test'
import { MONOSPACE, THEME, computed, editorFrame, openEditor, openPreview, saveScreenshot } from './helpers'

// The base theme on dev/preview.html, a mock of the Standard Notes layout that
// reads the same CSS variables as the app.

const ring = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 ? style.outlineColor : ''
    return { outline, boxShadow: style.boxShadow === 'none' ? '' : style.boxShadow }
  })

const expectRing = async (locator: Locator) => {
  const { outline, boxShadow } = await ring(locator)
  expect(outline || boxShadow, 'no outline or box-shadow on the focused element').not.toBe('')
  expect(`${outline} ${boxShadow}`).toContain(THEME.info)
}

const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

const variable = (page: Page, name: string) =>
  page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name)

test('sets the background variable as a #rrggbb color and paints with it', async ({ page }) => {
  const errors = await openPreview(page)
  // Standard Notes parses this value for the status bar and theme-color.
  expect(await variable(page, '--sn-stylekit-background-color')).toBe('#050805')
  await expect(page.locator('body')).toHaveCSS('background-color', THEME.background)
  await expect(page.locator('#items-column')).toHaveCSS('background-color', THEME.background)
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#050805')
  expect(errors).toEqual([])
})

test('uses the foreground for text and the monospace stack everywhere', async ({ page }) => {
  const errors = await openPreview(page)
  const body = page.locator('body')
  await expect(body).toHaveCSS('color', THEME.foreground)
  expect(await computed(body, 'font-family')).toMatch(MONOSPACE)
  expect(await computed(page.locator('#search-bar'), 'font-family')).toMatch(MONOSPACE)

  await openEditor(page)
  const paragraph = page.locator('#blocks-editor .Lexical__paragraph').first()
  await expect(paragraph).toHaveCSS('color', THEME.foreground)
  expect(await computed(paragraph, 'font-family')).toMatch(MONOSPACE)
  expect(await computed(page.locator('#blocks-editor .Lexical__code'), 'font-family')).toMatch(MONOSPACE)
  expect(errors).toEqual([])
})

test('glows on the selected note title, never on body text', async ({ page }) => {
  const errors = await openPreview(page)
  const selected = page.locator('#items-column .content-list-item.selected .font-semibold')
  const other = page.locator('#items-column .content-list-item:not(.selected) .font-semibold').first()
  expect(await computed(selected, 'text-shadow')).not.toBe('none')
  expect(await computed(other, 'text-shadow')).toBe('none')
  expect(await computed(page.locator('#items-column .item-preview').first(), 'text-shadow')).toBe('none')

  await openEditor(page)
  for (const text of await page.locator('#blocks-editor .Lexical__paragraph, #blocks-editor li').all()) {
    expect(await computed(text, 'text-shadow')).toBe('none')
  }
  expect(errors).toEqual([])
})

test('shows a focus ring on fields and buttons', async ({ page }) => {
  const errors = await openPreview(page)
  const search = page.locator('#search-bar')
  await search.focus()
  await expect(search).toBeFocused()
  await expectRing(search)

  // Reach the button with the keyboard, so it matches :focus-visible.
  const button = page.locator('#kit .sn-button.primary').first()
  await button.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(button).toBeFocused()
  await expectRing(button)
  expect(errors).toEqual([])
})

test('selects text in green with dark text', async ({ page }) => {
  const errors = await openPreview(page)
  const preview = page.locator('#items-column .item-preview').first()
  expect(await computed(preview, 'background-color', '::selection')).toBe(THEME.info)
  expect(await computed(preview, 'color', '::selection')).toBe(THEME.infoContrast)
  expect(errors).toEqual([])
})

test('prints black on white', async ({ page }) => {
  const errors = await openPreview(page)
  await openEditor(page)
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(0, 0, 0)')
  await expect(page.locator('#blocks-editor .Lexical__paragraph').first()).toHaveCSS('color', 'rgb(0, 0, 0)')
  expect(await computed(page.locator('#blocks-editor .Lexical__h2').first(), 'text-shadow')).toBe('none')
  expect(errors).toEqual([])
})

test('leaves the light layout alone with ?theme=none', async ({ page }) => {
  const errors = await openPreview(page, '?theme=none')
  await expect(page.locator('link[data-theme]')).toHaveCount(0)
  expect(luminance(await computed(page.locator('body'), 'background-color'))).toBeGreaterThan(0.9)
  expect(luminance(await computed(page.locator('body'), 'color'))).toBeLessThan(0.2)
  expect(await computed(page.locator('body'), 'font-family')).not.toMatch(MONOSPACE)
  expect(errors).toEqual([])
})

test('reaches the plugin editor frame through the stylesheet links it is sent', async ({ page }) => {
  const errors = await openPreview(page)
  const frame = await editorFrame(page, 1)
  await expect(frame.locator('body')).toHaveCSS('background-color', THEME.background)
  await expect(frame.locator('textarea')).toHaveCSS('color', THEME.foreground)
  expect(await computed(frame.locator('textarea'), 'font-family')).toMatch(MONOSPACE)
  await expect(frame.locator('.mode [aria-pressed="true"]')).toHaveCSS('background-color', THEME.info)
  expect(errors).toEqual([])
})

test('screenshots', async ({ page }, testInfo) => {
  const errors = await openPreview(page)
  await saveScreenshot(page, testInfo, 'preview', { fullPage: true })
  // The editor frame runs in its own process and stays blank in full-page
  // captures below the fold, so the controls get their own shot.
  await editorFrame(page, 1)
  await saveScreenshot(page.locator('#kit'), testInfo, 'preview-controls')
  if (page.viewportSize()!.width < 768) {
    await openEditor(page)
    await saveScreenshot(page, testInfo, 'preview-editor')
  }
  await openPreview(page, '?theme=none')
  await saveScreenshot(page, testInfo, 'preview-unthemed')
  expect(errors).toEqual([])
})
