// Builds the Keyfold editor for Standard Notes at a pinned commit into
// .cache/keyfold/dist, which the dev server serves at /keyfold/.
//
//   node scripts/keyfold.mjs   (npm run keyfold)
//
// Keyfold is a real third-party editor that reads the theme's --sn-stylekit-*
// variables, so the e2e tests frame it the way Standard Notes does and check
// that the theme reaches it. Building from a pinned commit keeps the tests
// hermetic: no network once the cache exists, and the same editor every run.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const KEYFOLD_REPO = 'https://github.com/nickstruglia/standard-notes-keyfold'
export const KEYFOLD_COMMIT = 'a9a9eaf6349ae33c352271bc4e5eb1c3c90c1330'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, '.cache', 'keyfold')
const dist = join(dir, 'dist')
// Outside dist/ so a rebuild or a deleted dist/ never leaves a stale marker.
const marker = join(dir, '.keyfold-built')

// Keyfold's build also reads SITE_URL, which is meant for this repository's build.
const env = { ...process.env }
delete env.SITE_URL

const run = (command, args) => {
  console.log(`\n> ${command} ${args.join(' ')}`)
  // npm is a .cmd file on Windows, which only runs through a shell.
  const result = spawnSync(command, args, { cwd: dir, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" failed (${result.signal || `exit code ${result.status}`})`)
  }
}

const built = () =>
  existsSync(join(dist, 'index.html')) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === KEYFOLD_COMMIT

/** Fetches and builds Keyfold unless .cache/keyfold already holds a build of the pinned commit. */
export function buildKeyfold() {
  if (built()) {
    console.log(`Keyfold ${KEYFOLD_COMMIT.slice(0, 7)} is already built in .cache/keyfold/dist`)
    return
  }
  mkdirSync(dir, { recursive: true })
  run('git', ['init', '--quiet'])
  run('git', ['fetch', '--depth', '1', KEYFOLD_REPO, KEYFOLD_COMMIT])
  run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--force', 'FETCH_HEAD'])
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
  run('npm', ['run', 'build'])
  if (!existsSync(join(dist, 'index.html'))) throw new Error('the Keyfold build did not produce dist/index.html')
  writeFileSync(marker, KEYFOLD_COMMIT + '\n')
  console.log(`\nBuilt Keyfold ${KEYFOLD_COMMIT.slice(0, 7)} into .cache/keyfold/dist (served at /keyfold/)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    buildKeyfold()
  } catch (error) {
    console.error(`\nnpm run keyfold: ${error.message}`)
    process.exit(1)
  }
}
