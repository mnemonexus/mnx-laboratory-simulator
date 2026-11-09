import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const errors = [], results = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  if (process.argv.includes('--force-webgl')) await page.addInitScript(() => { window.__labForceWebGL = true })
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => { errors.push(error.message); console.log('ERROR', error.message) })
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.log('ERROR', message.text()) } })
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  for (const preset of ['low', 'medium', 'high']) {
    await page.getByRole('button', { name: 'Graphics settings' }).first().click()
    await page.locator(`[data-preset=${preset}]`).click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(p => window.__lab?.ready && !window.__lab.disposed && window.__lab.settings.lighting === p, preset)
    await page.evaluate(() => {
      const utils = window.__lab.renderer.backend.textureUtils
      if (!utils || utils.__diagnostic) return
      utils.__diagnostic = true
      const original = utils.createTexture
      utils.createTexture = function(texture, options) {
        try { return original.call(this, texture, options) }
        catch (error) { console.error('Texture lifecycle diagnostic', JSON.stringify({ name: texture.name, uuid: texture.uuid, type: texture.constructor.name, renderTarget: texture.isRenderTargetTexture, source: texture.source?.uuid, version: texture.version, initialized: this.backend.get(texture).initialized, options }), error.stack); throw error }
      }
    })
    await page.getByTestId('station-sample-prep').click()
    await page.waitForTimeout(5000)
    await page.getByTestId('station-plate-reader').click()
    await page.waitForTimeout(3000)
    const result = await page.evaluate(() => ({ backend: window.__lab.renderer.backend.constructor.name, failed: window.__lab.failed, ready: window.__lab.ready }))
    results.push({ preset, ...result })
    console.log(JSON.stringify({ preset, ...result }))
    assert.equal(result.failed, false)
  }
  assert.equal(errors.length, 0, errors.join('; '))
} finally {
  mkdirSync('output/performance', { recursive: true })
  writeFileSync(`output/performance/graphics-lifecycle${process.argv.includes('--force-webgl') ? '-fallback' : ''}.json`, JSON.stringify({ results, errors }, null, 2))
  await browser.close()
}
