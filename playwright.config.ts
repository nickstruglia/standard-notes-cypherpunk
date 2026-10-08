import { defineConfig, devices } from '@playwright/test'

// Runs against the production build (dist/), the preview pages (dev/) and a
// locally built copy of the Keyfold editor (npm run keyfold). Phone profiles
// run in Chromium with phone screen sizes and touch.
export default defineConfig({
  testDir: 'e2e',
  testIgnore: /live\.spec\.ts/,
  timeout: 30_000,
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:4173/dev/preview.html',
    reuseExistingServer: !process.env.CI,
  },
})
