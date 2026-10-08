// Serves the build at /, the preview pages at /dev/ and, once `npm run keyfold`
// has built it, the Keyfold editor at /keyfold/. Used by the e2e tests.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT || 4173)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.zip': 'application/zip',
}
const mounts = [
  ['/dev/', 'dev'],
  ['/keyfold/', join('.cache', 'keyfold', 'dist')],
  ['/', 'dist'],
]

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const [prefix, dir] = mounts.find(([prefix]) => path.startsWith(prefix))
  const base = join(root, dir)
  const rel = path.slice(prefix.length)
  const file = normalize(join(base, rel.endsWith('/') || !rel ? `${rel}index.html` : rel))
  if (file !== base && !file.startsWith(base + sep)) return res.writeHead(403).end()
  try {
    const body = await readFile(file)
    res
      .writeHead(200, {
        'content-type': types[extname(file)] || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      })
      .end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`))
