import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'
const label = process.argv[2] ?? 'latest'
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Use a simple label')
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
try {
  const page = await browser.newPage()
  const root = process.env.LAB_URL ?? 'http://localhost:5173'
  await page.route('**/performance-textures', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Texture cache probe</body></html>' }))
  await page.goto(`${root}/performance-textures`)
  const result = await page.evaluate(async () => {
    const { mouldedPlastic } = await import('/src/three/textures.ts')
    const colors = ['#e8eaed', '#ffffff', '#d8dee8', '#1e293b', '#475569', '#cbd5e1', '#334155', '#f8fafc', '#94a3b8', '#f59e0b', '#ef4444', '#2563eb']
    const start = performance.now()
    const sets = colors.map(color => mouldedPlastic(color))
    const buildMs = performance.now() - start
    const maps = new Set(sets.map(set => set.map)), normals = new Set(sets.map(set => set.normalMap))
    return { colors: colors.length, buildMs, colorMaps: maps.size, normalMaps: normals.size, normalPixelBytes: [...normals].reduce((sum, tex) => sum + tex.image.width * tex.image.height * 4, 0), dimensions: sets.map(set => [set.map.image.width, set.normalMap.image.width]), repeatedColorsReuseMaps: mouldedPlastic(colors[0]).map === sets[0].map, repeatedColorsReuseNormals: mouldedPlastic(colors[0]).normalMap === sets[0].normalMap }
  })
  assert.equal(result.colorMaps, result.colors)
  assert.ok(result.repeatedColorsReuseMaps && result.repeatedColorsReuseNormals)
  mkdirSync('output/performance', { recursive: true })
  writeFileSync(`output/performance/texture-cache-${label}.json`, JSON.stringify({ ...result, limitation: 'Synthetic twelve-colour cache workload; pixel bytes exclude GPU mipmaps and canvas/driver overhead.' }, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally { await browser.close() }
