// Times the loading-screen preparation stages (dev server must be running).
//   node scripts/performance/prepare-timeline.mjs [--preset high]
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'
const args = process.argv.slice(2)
const preset = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : null
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(600000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  const t0 = performance.now()
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('station-sample-prep').click()
  await page.waitForFunction(() => window.__lab?.ready)
  if (preset) {
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
    await page.locator(`[data-preset=${preset}]`).dispatchEvent('click')
    await page.getByRole('button', { name: 'Graphics settings' }).first().dispatchEvent('click')
    await page.waitForFunction(p => window.__lab?.ready && !window.__lab.disposed && window.__lab.settings.lighting === p, preset)
  }
  const info = await page.evaluate(() => ({ settings: window.__lab.settings.lighting, backend: window.__lab.debugInfo().backend, prepareMs: window.__lab.prepareMs, log: window.__lab.debugInfo().bakeLog, memory: window.__lab.renderer.info.memory }))
  console.log(JSON.stringify({ launchMs: Math.round(performance.now() - t0), ...info, errors }, null, 1))
} finally { await browser.close() }
