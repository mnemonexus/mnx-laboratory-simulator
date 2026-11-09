// Destroy an actual WebGPU device, then recover the viewport without replacing
// the scientific session. Requires the development server's opt-in world handle.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'

const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const errors = [], expectedGraphicsErrors = [], checks = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (message.text().startsWith('3D view stopped:')) expectedGraphicsErrors.push(message.text())
    else errors.push(message.text())
  })
  await page.goto(process.env.LAB_URL ?? 'http://localhost:5173')
  await page.getByRole('button', { name: 'Graphics settings' }).first().click()
  await page.locator('[data-preset=low]').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('station-practical').click()
  const experiment = 'chem6-buffer-capacity'
  await page.getByTestId(`practical-${experiment}`).click()
  await page.getByTestId(`practical-start-${experiment}`).click()
  await page.getByTestId('practical-demonstrate').click()
  console.log('Scientific session started; waiting for WebGPU readiness')
  await page.waitForFunction(() => window.__lab?.ready && !window.__lab.failed && window.__lab.renderer.backend.constructor.name === 'WebGPUBackend')
  const before = await page.getByTestId('procedure-panel').innerText()
  console.log('Destroying the live WebGPU device')
  await page.evaluate(() => {
    const w = window.__lab
    window.__lostWorld = w
    w.renderer.backend.device.destroy()
  })
  await page.getByTestId('retry-graphics').waitFor()
  console.log('Loss is contained; checking scientific controls')
  checks.push('Actual WebGPU device destruction is contained by the viewport')
  await page.getByTestId('practical-notebook').click()
  await page.getByTestId('note-field').fill('device-loss-observation')
  await page.getByTestId('note-value').fill('Scientific controls remain active')
  await page.getByTestId('note-add').click()
  assert.ok((await page.getByTestId('notebook-panel').innerText()).includes('Scientific controls remain active'))
  await page.getByTestId('notebook-close').click()
  checks.push('Scientific notebook accepts an operation while the GPU is lost')
  await page.getByTestId('retry-graphics').click()
  console.log('Rebuilding the WebGPU viewport')
  await page.waitForFunction(() => window.__lab !== window.__lostWorld && window.__lab?.ready && !window.__lab.failed)
  assert.equal(await page.getByTestId('retry-graphics').count(), 0)
  assert.equal(await page.getByTestId('procedure-panel').innerText(), before)
  checks.push('Retry creates a new WebGPU world and preserves scientific procedure state')
  await page.getByTestId('practical-notebook').click()
  assert.ok((await page.getByTestId('notebook-panel').innerText()).includes('Scientific controls remain active'))
  await page.getByTestId('notebook-close').click()
  await page.getByTestId('practical-demonstrate').click()
  checks.push('Notebook persists and the next scientific command succeeds after recovery')
  assert.equal(errors.length, 0, errors.join('; '))
  assert.ok(expectedGraphicsErrors.length > 0)
  console.log(`PASS ${checks.length} actual WebGPU device-loss recovery checks`)
} finally {
  mkdirSync('output/performance', { recursive: true })
  writeFileSync('output/performance/device-loss.json', JSON.stringify({ checks, errors, expectedGraphicsErrors, scope: 'Actual Chromium WebGPU device destruction and recovery; not physical driver-reset or mobile OS suspension certification.' }, null, 2))
  await browser.close()
}
