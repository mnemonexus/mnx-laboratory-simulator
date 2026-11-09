// Keep a MnemoNexus browser run from writing to the real app data.
//
// The MnemoNexus dev server bridges `/__mnx_dev__/app-local` straight to the
// real app data folder the desktop app uses, so even a fresh browser profile
// rewrites settings and packs there. This overlays the bridge in memory: reads
// come from disk, while writes, deletes and links stay in the run, except the
// paths `passThrough` allows. Any other dev-server write is refused.
export const APP_LOCAL = '/__mnx_dev__/app-local'

const norm = (p) => (p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
const under = (p, dir) => p === dir || p.startsWith(`${dir}/`)

/**
 * @param context a Playwright BrowserContext, before any page loads
 * @param options.app the dev server origin
 * @param options.hide paths treated as absent on disk (and everything under them)
 * @param options.passThrough (path) => true for writes that may reach the real folder
 * @param options.memory initial in-memory files: path → Buffer
 */
export async function overlayAppLocal(context, { app, hide = [], passThrough = () => false, memory = new Map() }) {
  const tombstones = new Set(hide.map(norm))
  const kept = new Set()
  const passed = new Set()
  const refused = []
  const removed = (p) => [...tombstones].some((t) => under(p, t))

  const readReal = async (path) => {
    const res = await fetch(`${app}${APP_LOCAL}?path=${encodeURIComponent(path)}`)
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null
  }
  const read = async (path) => (memory.has(path) ? memory.get(path) : removed(path) ? null : readReal(path))

  async function appLocal(route, request, url) {
    const path = norm(url.searchParams.get('path'))
    const method = request.method()
    if (method !== 'GET' && passThrough(path)) {
      passed.add(`${method} ${path}`)
      memory.delete(path)
      return route.continue()
    }
    if (method === 'GET' && url.searchParams.get('op') === 'list') {
      const real = removed(path) ? [] : await (await route.fetch()).json()
      const meta = url.searchParams.get('meta') === '1'
      const byName = new Map()
      for (const entry of real) {
        const name = meta ? entry.name : entry
        if (!removed(`${path}/${name}`)) byName.set(name, entry)
      }
      for (const [file, bytes] of memory) {
        const rest = file.startsWith(`${path}/`) ? file.slice(path.length + 1) : null
        if (rest && !rest.includes('/')) byName.set(rest, meta ? { name: rest, size: bytes.length, mtimeMs: Date.now() } : rest)
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...byName.values()]) })
    }
    if (method === 'GET') {
      const bytes = await read(path)
      return bytes
        ? route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bytes })
        : route.fulfill({ status: 404, body: 'File not found.' })
    }
    if (method === 'PUT') {
      memory.set(path, request.postDataBuffer() ?? Buffer.alloc(0))
      kept.add(path)
      return route.fulfill({ status: 204 })
    }
    if (method === 'DELETE') {
      tombstones.add(path)
      for (const file of [...memory.keys()]) if (under(file, path)) memory.delete(file)
      kept.add(`${path} (deleted)`)
      return route.fulfill({ status: 204 })
    }
    if (method === 'POST' && url.searchParams.get('op') === 'link') {
      const [from, to] = await Promise.all([read(norm(url.searchParams.get('from'))), read(path)])
      return route.fulfill({ status: 200, body: from && to && from.equals(to) ? 'linked' : 'different' })
    }
    return route.fulfill({ status: 405, body: 'Method not allowed.' })
  }

  await context.route('**/__mnx_dev__/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === APP_LOCAL) return appLocal(route, request, url)
    if (request.method() === 'GET') return route.continue()
    refused.push(`${request.method()} ${url.pathname}`)
    return route.fulfill({ status: 403, body: 'Refused: isolated run.' })
  })

  return {
    readReal,
    /** What this run did to app-local data, for the report. */
    summary: () => ({ keptInMemory: [...kept].sort(), reachedDisk: [...passed].sort(), refusedDevWrites: refused }),
  }
}
