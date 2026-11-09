import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'
import { RUST_SCIENCE_ABI } from '../../src/runtime/rustScience.ts'
const results = [], errors = []
const experiments = process.env.LAB_EXPERIMENTS?.split(',').filter(Boolean) ?? ['chem6-buffer-capacity', 'micro4-growth-curve']
if (!experiments.length) throw new Error('At least one practical must be selected for mobile verification')
const label = process.env.LAB_REPORT_LABEL ?? ''
if (label && !/^[a-z0-9-]+$/i.test(label)) throw new Error('Report label must contain letters, numbers or hyphens')
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
let activePage
let failure = null
mkdirSync('output/performance/mobile', { recursive: true })
try {
  for (const [profile, viewport] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 1024, height: 768 }]]) {
    const context = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 1 })
    await context.addInitScript(() => {
      const instantiate = WebAssembly.instantiate
      WebAssembly.instantiate = async (...args) => {
        const result = await instantiate(...args)
        const exports = (result.instance ?? result).exports
        if (typeof exports.lab_api_version === 'function') window.__labScienceProbe = { implementation: 'rust-wasm', abi: exports.lab_api_version() }
        return result
      }
    })
    const page = await context.newPage()
    activePage = page
    page.setDefaultTimeout(30000)
    page.on('pageerror', error => errors.push(`${profile}: ${error.message}`))
    const navigate = async () => {
      await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
      if (profile === 'phone') {
        const hit = await page.getByTestId('station-select').evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element })
        assert.ok(hit, 'Mobile station picker is visible and unobstructed')
        await page.getByTestId('station-select').selectOption('practical')
      }
      else await page.getByTestId('station-practical').click()
      await page.getByTestId('practical-launcher').waitFor()
    }
    for (const experiment of experiments) {
      console.log(`START ${profile}/${experiment}`)
      await navigate()
      await page.getByTestId(`practical-${experiment}`).click()
      await page.getByTestId(`practical-start-${experiment}`).click()
      await page.getByTestId('procedure-panel').waitFor()
      let demonstrations = 0
      while (await page.getByTestId('practical-demonstrate').isVisible()) {
        if (++demonstrations > 30) throw new Error(`Procedure did not finish: ${experiment}`)
        await page.getByTestId('practical-demonstrate').click()
      }
      if (profile === 'phone') {
        await page.getByTestId('mobile-bench').click()
        assert.ok(await page.getByTestId('bench-panel').isVisible())
        assert.equal(await page.getByTestId('procedure-panel').isVisible(), false)
        await page.getByTestId('mobile-notebook').click()
      } else await page.getByTestId('practical-notebook').click()
      await page.getByTestId('note-field').fill('migration-check')
      await page.getByTestId('note-value').fill(`${profile}-${experiment}`)
      await page.getByTestId('note-add').click()
      assert.ok((await page.getByTestId('notebook-panel').innerText()).includes(`${profile}-${experiment}`))
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid=notebook-panel]').getBoundingClientRect()
        return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth, notebook: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom }, science: window.__labScienceProbe }
      })
      console.log(JSON.stringify({ profile, experiment, geometry }))
      await page.screenshot({ path: `output/performance/mobile/${profile}-${experiment}.png` })
      assert.ok(geometry.documentWidth <= viewport.width, 'No horizontal page overflow')
      assert.ok(geometry.notebook.left >= 0 && geometry.notebook.right <= viewport.width, 'Notebook fits the viewport')
      assert.equal(geometry.science.implementation, 'rust-wasm')
      assert.equal(geometry.science.abi, RUST_SCIENCE_ABI, 'Current Rust scientific ABI is instantiated')
      await page.screenshot({ path: `output/performance/mobile/${profile}-${experiment}.png` })
      // A real reload, not a remount: persistence must come from standalone IndexedDB.
      console.log(`RELOAD ${profile}/${experiment}`)
      await navigate()
      console.log(`RESUME ${profile}/${experiment}`)
      await page.getByTestId('practical-resume').click()
      await page.getByTestId('practical-shell').waitFor()
      console.log(`RESTORED ${profile}/${experiment}`)
      if (profile === 'phone') await page.getByTestId('mobile-notebook').click()
      else await page.getByTestId('practical-notebook').click()
      assert.ok((await page.getByTestId('notebook-panel').innerText()).includes(`${profile}-${experiment}`), 'Notebook survived reload')
      await page.getByTestId('notebook-close').click()
      await page.getByTestId('practical-finish').click()
      await page.getByTestId('review-view').waitFor()
      results.push({ profile, experiment, demonstrations, geometry, persisted: true, reviewed: true })
      console.log(`PASS ${profile}/${experiment}: Rust science, complete procedure, notebook, reload and review`)
    }
    await context.close()
  }
  assert.equal(errors.length, 0, errors.join('; '))
} catch (error) {
  failure = String(error)
  console.error(String(error))
  if (activePage && !activePage.isClosed()) {
    // A wedged renderer can also block diagnostics; preserve the original
    // failing action instead of replacing it with another timeout.
    try { console.error((await activePage.locator('body').innerText({ timeout: 5000 })).slice(-4000)) } catch (diagnostic) { console.error(`Body diagnostic unavailable: ${diagnostic}`) }
    try { await activePage.screenshot({ path: 'output/performance/mobile/failure.png', timeout: 5000 }) } catch (diagnostic) { console.error(`Screenshot unavailable: ${diagnostic}`) }
  }
  throw error
} finally {
  const report = JSON.stringify({ passed: failure === null && errors.length === 0 && results.length === 2 * experiments.length, failure, results, errors, limitation: 'Chromium touch/viewport emulation; physical iOS/Android and thermal testing remain required.' }, null, 2)
  writeFileSync(`output/performance/mobile/report${label ? `-${label}` : ''}.json`, report)
  mkdirSync('output/performance/mobile/attempts', { recursive: true })
  writeFileSync(`output/performance/mobile/attempts/${new Date().toISOString().replace(/[:.]/g, '-')}${label ? `-${label}` : ''}.json`, report)
  await browser.close()
}
