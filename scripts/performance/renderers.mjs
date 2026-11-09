import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = [], warnings = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) warnings.push(message.text()) })
  const forceWebGL = process.argv.includes('--force-webgl')
  await page.goto(`${process.env.LAB_URL ?? 'http://localhost:5173'}/dev/renderer-spike.html${forceWebGL ? '?forceWebGL' : ''}`)
  await page.waitForFunction(() => window.__rendererSpike, null, { timeout: 180000 })
  const report = await page.evaluate(() => window.__rendererSpike.run(5))
  mkdirSync('output/performance', { recursive: true })
  const suffix = forceWebGL ? 'fallback' : 'auto'
  await page.screenshot({ path: `output/performance/renderer-${suffix}.png` })
  writeFileSync(`output/performance/renderer-${suffix}.json`, JSON.stringify({ browser: browser.version(), errors, warnings, ...report }, null, 2))
  console.log(JSON.stringify({ ...report, results: report.results.map(({ rows, ...result }) => result), errors, warnings: warnings.length }, null, 2))
  if (errors.length) throw new Error(errors.join('; '))
} finally { await browser.close() }
