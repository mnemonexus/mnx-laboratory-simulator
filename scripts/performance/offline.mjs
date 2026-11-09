import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { findChromium, playwright } from '../addon/env.mjs'
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.LAB_URL ?? 'http://127.0.0.1:5183')
  await page.getByTestId('open-practicals').waitFor()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  const installed = await page.evaluate(async () => ({ manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'), cache: await caches.keys(), controlled: !!navigator.serviceWorker.controller }))
  assert.ok(installed.manifest)
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByTestId('open-practicals').click()
  await page.getByTestId('practical-chem6-buffer-capacity').click()
  await page.getByTestId('practical-start-chem6-buffer-capacity').click()
  await page.getByTestId('procedure-panel').waitFor()
  await page.getByTestId('practical-demonstrate').click()
  assert.equal(errors.length, 0, errors.join('; '))
  mkdirSync('output/performance', { recursive: true })
  writeFileSync('output/performance/offline.json', JSON.stringify({ installed, offlineLaunch: true, offlinePractical: true, errors, scope: 'Standalone release build offline shell; not app-store installation or physical mobile certification.' }, null, 2))
  console.log('PASS offline reload, practical launch and scientific command')
  await context.close()
} finally { await browser.close() }
