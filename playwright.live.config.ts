import { defineConfig, devices } from '@playwright/test'

// Installs the themes in the real Standard Notes web app (app.standardnotes.com,
// no account needed). Needs a network connection, so it is not part of CI:
// run it with `npm run test:live` before a release.
//
// Requests for the published GitHub Pages URLs are answered from the local
// build, so this tests the files in dist/ before they are deployed.
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined

export default defineConfig({
  testDir: 'e2e',
  testMatch: /live\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/live',
  workers: 1,
  retries: 0,
  use: {
    locale: 'en-US',
    launchOptions: proxy ? { proxy } : {},
  },
  projects: [
    { name: 'live-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'live-android', use: { ...devices['Pixel 7'] } },
  ],
})
