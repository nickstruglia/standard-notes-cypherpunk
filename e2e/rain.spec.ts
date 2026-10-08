import { expect, test, type Frame, type Page } from '@playwright/test'
import { THEME, cssAnimations, drawnRain, editorFrame, openPreview, pseudoStyle, saveScreenshot } from './helpers'

// The Rain and Scanlines layers on dev/preview.html. Both must draw in the
// main app only: Standard Notes loads the same stylesheets in every editor
// frame, where they must leave no trace.

const PSEUDOS = ['html::before', 'html::after', 'body::before', 'body::after']

const expectNoLayers = async (frame: Frame) => {
  for (const pseudo of PSEUDOS) expect((await pseudoStyle(frame, pseudo))?.content, pseudo).toBe('none')
  expect(await cssAnimations(frame)).toEqual([])
}

const loadedSheets = (frame: Frame) =>
  frame.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => new URL((link as HTMLLinkElement).href).pathname))

const textColors = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      ['#navigation .section-title-bar', '#navigation .tag .title', '#navigation .tag .count', '#items-title-bar .title', '.content-list-item .item-title', '.content-list-item .item-preview', '.content-list-item .item-meta'].map(
        (selector) => [selector, getComputedStyle(document.querySelector(selector)!).color],
      ),
    ),
  )

test('draws rain in the main app, moved by a running transform animation', async ({ page }) => {
  const errors = await openPreview(page, '?layers=rain')
  const drawn = await drawnRain(page)
  expect(drawn.length, 'no rain pseudo-element draws').toBeGreaterThan(0)

  const animations = await cssAnimations(page)
  for (const pseudo of drawn) {
    expect(animations.some((animation) => animation.target === pseudo && animation.playState === 'running'), `${pseudo} is not animated`).toBe(true)
  }
  // It actually moves (sampled, since it is a continuous animation).
  const transform = async () => (await pseudoStyle(page, drawn[0]))!.transform
  const first = await transform()
  await expect.poll(transform, { intervals: [100, 200, 400] }).not.toBe(first)
  expect(errors).toEqual([])
})

test('animates nothing but transform', async ({ page }) => {
  const errors = await openPreview(page, '?layers=rain')
  const animations = await cssAnimations(page)
  expect(animations.length).toBeGreaterThan(0)
  for (const animation of animations) expect(animation.properties, animation.name).toEqual(['transform'])
  expect(errors).toEqual([])
})

test('keeps the plugin editor frame free of rain', async ({ page }) => {
  const errors = await openPreview(page, '?layers=rain')
  const frame = await editorFrame(page, 2)
  // The frame did load the layer, so this checks the layer's scoping.
  expect(await loadedSheets(frame)).toContain('/rain/index.css')
  await expect(frame.locator('body')).toHaveCSS('background-color', THEME.background)
  await expectNoLayers(frame)
  expect(errors).toEqual([])
})

test('leaves sidebar and note list text colors alone', async ({ page }) => {
  await openPreview(page)
  const without = await textColors(page)
  const errors = await openPreview(page, '?layers=rain')
  expect(await textColors(page)).toEqual(without)
  expect(errors).toEqual([])
})

test.describe('with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('still draws the rain but runs no animation', async ({ page }) => {
    const errors = await openPreview(page, '?layers=rain')
    expect((await drawnRain(page)).length).toBeGreaterThan(0)
    expect((await cssAnimations(page)).filter((animation) => animation.playState === 'running')).toEqual([])
    expect(errors).toEqual([])
  })
})

test('scanlines draw an overlay that clicks pass through', async ({ page }) => {
  const errors = await openPreview(page, '?layers=scanlines')
  const overlay = await pseudoStyle(page, 'html::after')
  expect(overlay?.content).not.toBe('none')
  expect(overlay?.pointerEvents).toBe('none')

  const button = page.locator('#new-note')
  const box = (await button.boundingBox())!
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.id,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
  expect(hit).toBe('new-note')

  // A real click through the overlay reaches the toggle under it.
  await page.getByRole('button', { name: 'Rain', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-themes', 'cypherpunk rain scanlines')

  const frame = await editorFrame(page, 3)
  await expectNoLayers(frame)
  expect(errors).toEqual([])
})

test('stacks both layers', async ({ page }, testInfo) => {
  const errors = await openPreview(page, '?layers=rain,scanlines')
  expect((await drawnRain(page)).length).toBeGreaterThan(0)
  expect((await pseudoStyle(page, 'html::after'))?.content).not.toBe('none')
  const frame = await editorFrame(page, 3)
  expect(await loadedSheets(frame)).toEqual(expect.arrayContaining(['/rain/index.css', '/scanlines/index.css']))
  await expectNoLayers(frame)
  await saveScreenshot(page, testInfo, 'preview-rain-scanlines')
  expect(errors).toEqual([])
})

test('toggles the layers from the bar and sends them to the editor frame', async ({ page }, testInfo) => {
  const errors = await openPreview(page)
  const rain = page.getByRole('button', { name: 'Rain', exact: true })
  await rain.click()
  await expect(rain).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-themes', 'cypherpunk rain')
  expect(new URL(page.url()).searchParams.get('layers')).toBe('rain')
  expect((await drawnRain(page)).length).toBeGreaterThan(0)
  await expectNoLayers(await editorFrame(page, 2))
  await saveScreenshot(page, testInfo, 'preview-rain')

  await rain.click()
  await expect(page.locator('html')).toHaveAttribute('data-themes', 'cypherpunk')
  expect(await drawnRain(page)).toEqual([])
  await editorFrame(page, 1)
  expect(errors).toEqual([])
})
