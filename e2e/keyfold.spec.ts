import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { MONOSPACE, THEME, computed, cssAnimations, pseudoStyle, saveScreenshot, watchErrors } from './helpers'

// Keyfold, a real third-party editor that reads the theme variables, framed
// by dev/keyfold.html with the sandbox and messages Standard Notes uses.
// It is built locally from a pinned commit by `npm run keyfold`.

const BUILT = existsSync(fileURLToPath(new URL('../.cache/keyfold/dist/index.html', import.meta.url)))
const MISSING = 'Keyfold is not built: run npm run keyfold'

test.beforeEach(() => {
  if (BUILT) return
  if (process.env.CI) throw new Error(MISSING)
  test.skip(true, MISSING)
})

test('Keyfold wears the theme and none of the rain', async ({ page }, testInfo) => {
  const errors = watchErrors(page)
  await page.goto('/dev/keyfold.html?layers=rain')
  const keyfold = page.frameLocator('#editor')

  // The vault from the host's note, so there is real UI to look at.
  const entry = keyfold.getByText('Cold storage').first()
  await expect(entry).toBeVisible()
  const frame = page.frame({ url: /\/keyfold\// })!
  await expect.poll(() => frame.evaluate(() => [...document.querySelectorAll('link[data-sn-theme]')].length)).toBe(2)

  const body = keyfold.locator('body')
  await expect(body).toHaveCSS('background-color', THEME.background)
  await expect(body).toHaveCSS('color', THEME.foreground)
  expect(await computed(body, 'font-family')).toMatch(MONOSPACE)

  // The accent reaches something visible, such as the primary button.
  const accented = await frame.evaluate((info) => {
    return [...document.querySelectorAll('body *')].some((element) => {
      const box = element.getBoundingClientRect()
      if (!box.width || !box.height) return false
      const style = getComputedStyle(element)
      return style.visibility !== 'hidden' && (style.backgroundColor === info || style.color === info)
    })
  }, THEME.info)
  expect(accented, 'nothing visible uses the info color').toBe(true)

  for (const pseudo of ['html::before', 'html::after', 'body::before', 'body::after']) {
    expect((await pseudoStyle(frame, pseudo))?.content, pseudo).toBe('none')
  }
  expect(await cssAnimations(frame)).toEqual([])

  await entry.click()
  await expect(keyfold.getByText(/Valid BIP39 checksum/)).toBeVisible()
  await saveScreenshot(page, testInfo, 'keyfold')
  expect(errors).toEqual([])
})
