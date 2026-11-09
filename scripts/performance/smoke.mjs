import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.on('pageerror', error => { errors.push(error.message); console.log('PAGE ERROR', error.message) })
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.log('CONSOLE ERROR', message.text().slice(0, 1800)) } })
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  await page.getByTestId('station-sample-prep').click({ timeout: 120000 })
  await page.waitForFunction(() => window.__lab?.ready || document.body.textContent.includes('3D view unavailable'), null, { timeout: 120000 })
  await page.waitForTimeout(5000)
  const result = await page.evaluate(() => {
    const w = window.__lab
    return { ready: w?.ready, failed: w?.failed, renderer: w?.renderer.constructor.name, backend: w?.renderer.backend.constructor.name, debug: w?.debugInfo(), text: document.body.innerText.slice(-2200) }
  })
  mkdirSync('output/performance', { recursive: true })
  await page.screenshot({ path: 'output/performance/production.png' })
  writeFileSync('output/performance/smoke.json', JSON.stringify({ result, errors }, null, 2))
  console.log(JSON.stringify({ result, errors: errors.length }, null, 2))
  if (errors.length || result.failed || !result.ready) process.exitCode = 1
} finally { await browser.close() }
