import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Frame, type Locator, type Page, type TestInfo } from '@playwright/test'

// The Cypherpunk palette (src/cypherpunk.css) as computed colors.
export const THEME = {
  background: 'rgb(5, 8, 5)',
  foreground: 'rgb(166, 255, 191)',
  info: 'rgb(0, 255, 65)',
  infoContrast: 'rgb(0, 26, 7)',
}

/** The theme's all-monospace stack, as a computed font-family. */
export const MONOSPACE = /^ui-monospace\b.*\bmonospace$/

/** Where the rain layer draws (see the comment at the top of src/rain.css). */
export const RAIN_PSEUDOS = ['html::before', 'body::before', '#items-column::before']

/** Collects console errors and uncaught exceptions from the page and its frames. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`))
  return errors
}

/** The themes the preview should load for a query string, in its data-themes format. */
const expectedThemes = (query: string): string => {
  const params = new URLSearchParams(query)
  const layers = (params.get('layers') || '').split(',')
  const keys = [...(params.get('theme') === 'none' ? [] : ['cypherpunk']), ...['rain', 'scanlines'].filter((key) => layers.includes(key))]
  return keys.join(' ') || 'none'
}

/** Opens dev/preview.html and waits until its theme stylesheets have loaded. */
export async function openPreview(page: Page, query = ''): Promise<string[]> {
  const errors = watchErrors(page)
  await page.goto(`/dev/preview.html${query}`)
  await expect(page.locator('html')).toHaveAttribute('data-themes', expectedThemes(query))
  return errors
}

/** The preview's plugin editor frame, once it has loaded the given number of theme stylesheets. */
export async function editorFrame(page: Page, themes: number): Promise<Frame> {
  const frame = await (await page.locator('#editor-frame').elementHandle())?.contentFrame()
  if (!frame) throw new Error('the editor frame did not load')
  await expect(frame.locator('html')).toHaveAttribute('data-themes', String(themes))
  return frame
}

/** On phones the mock, like Standard Notes, mounts the editor only while a note is open. */
export async function openEditor(page: Page): Promise<void> {
  if (await page.locator('#editor-column').isVisible()) return
  await page.locator('#items-column .content-list-item.selected').click()
  await expect(page.locator('#editor-column')).toBeVisible()
}

export const computed = (locator: Locator, property: string, pseudo?: string): Promise<string> =>
  locator.evaluate((element, [name, pseudoElement]) => getComputedStyle(element, pseudoElement).getPropertyValue(name), [
    property,
    pseudo ?? null,
  ] as const)

/** Computed style of a pseudo-element, e.g. pseudoStyle(page, 'html::before'). */
export const pseudoStyle = (target: Page | Frame, selectorAndPseudo: string) =>
  target.evaluate((spec) => {
    const [, selector, pseudo] = /^(.*?)(::[a-z-]+)$/.exec(spec)!
    const element = document.querySelector(selector)
    if (!element) return null
    const style = getComputedStyle(element, pseudo)
    return {
      content: style.content,
      backgroundImage: style.backgroundImage,
      animationName: style.animationName,
      transform: style.transform,
      pointerEvents: style.pointerEvents,
    }
  }, selectorAndPseudo)

/** The rain pseudo-elements that currently draw a tile. */
export const drawnRain = (target: Page | Frame) =>
  target.evaluate((specs) => {
    return specs.filter((spec) => {
      const [, selector, pseudo] = /^(.*?)(::[a-z-]+)$/.exec(spec)!
      const element = document.querySelector(selector)
      if (!element) return false
      const style = getComputedStyle(element, pseudo)
      return style.content !== 'none' && style.backgroundImage.includes('url(')
    })
  }, RAIN_PSEUDOS)

export interface AnimationInfo {
  name: string
  playState: string
  /** e.g. "html::before" or "#items-column::before" */
  target: string
  properties: string[]
}

/** Every CSS animation in the document, with the properties its keyframes change. */
export const cssAnimations = (target: Page | Frame): Promise<AnimationInfo[]> =>
  target.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation instanceof CSSAnimation)
      .map((animation) => {
        const effect = animation.effect as KeyframeEffect
        const element = effect.target as Element
        const name =
          element === document.documentElement ? 'html' : element === document.body ? 'body' : element.id ? `#${element.id}` : element.tagName.toLowerCase()
        const ignore = new Set(['offset', 'computedOffset', 'easing', 'composite'])
        return {
          name: (animation as CSSAnimation).animationName,
          playState: animation.playState,
          target: name + (effect.pseudoElement ?? ''),
          properties: [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame).filter((key) => !ignore.has(key))))],
        }
      }),
  )

/** Saves a screenshot under test-results/screenshots/<project>/ and attaches it to the report. */
export async function saveScreenshot(
  target: Page | Locator,
  testInfo: TestInfo,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  const dir = join(testInfo.project.outputDir, 'screenshots', testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.png`)
  // Finished transitions and the rain at its starting point, so shots are stable.
  if ('goto' in target) await target.screenshot({ path, fullPage: options.fullPage, animations: 'disabled' })
  else await target.screenshot({ path, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
