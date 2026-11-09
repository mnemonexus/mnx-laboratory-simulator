// Install the built pack in the real MnemoNexus app and use it, headless, in an
// isolated run that leaves the app data untouched. (To install it for real:
// npm run addon:install-app.)
//
//   npm run addon:verify-app
//
// Needs MnemoNexus's dev server running (`bun run dev` in the MnemoNexus
// checkout; default http://127.0.0.1:1420, or set MNX_APP_URL) and a built
// pack (`npm run addon:pack`).
//
// Isolation: a fresh browser profile, and the app-local overlay (appOverlay.mjs)
// keeps every write in memory, so nothing reaches the real app data. It also
// hides this add-on's pack if it is already resident, so the install below is
// a real first install.
//
// Screenshots and report.json go to output/app-verify/.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { overlayAppLocal } from './appOverlay.mjs'
import { findChromium, playwright, project } from './env.mjs'

const APP = (process.env.MNX_APP_URL ?? 'http://127.0.0.1:1420').replace(/\/$/, '')
const manifest = JSON.parse(readFileSync(join(project, 'manifest.json'), 'utf8'))
const PACK = join(project, 'dist', `${manifest.id}-${manifest.version}.mnxpack`)
const OUT = join(project, 'output/app-verify')
const LABEL = manifest.label
// Software WebGL in headless Chromium runs at a few frames a second; give the
// frame time to build the lab rather than fail on a busy main thread.
const SLOW = 120_000

mkdirSync(OUT, { recursive: true })
readFileSync(PACK) // fail early, with the path, if the pack is not built

const steps = []
const errors = []
let shot = 0
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()

// Start as if this add-on had never been installed: no resident pack, no roster entry.
const memory = new Map()
const overlay = await overlayAppLocal(context, { app: APP, hide: [`mnx-packs/${manifest.id}`], memory })
const roster = await overlay.readReal('mnx-packs/roster.json')
if (roster) {
  const entries = JSON.parse(roster.toString('utf8')).filter((entry) => entry.packId !== manifest.id)
  memory.set('mnx-packs/roster.json', Buffer.from(JSON.stringify(entries)))
}
page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text().slice(0, 300)}`)
})

async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    steps.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (error) {
    steps.push({ name, ok: false, ms: Date.now() - started, error: String(error.message ?? error).split('\n')[0] })
    console.log(`  ✗ ${name}: ${String(error.message ?? error).split('\n')[0]}`)
    await snap(`failed-${name}`)
    throw error
  }
}
async function snap(name) {
  const file = `${String(++shot).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`
  await page.screenshot({ path: join(OUT, file) }).catch(() => {})
  return file
}

const lab = page.frameLocator(`iframe[title="${LABEL}"]`)
const panel = page.locator(`section.mnx-practice__panel[aria-label="${LABEL}"]`)
const runs = panel.locator('.mnx-practice__panel-column').filter({ hasText: 'Your runs' })

async function openInExperiences() {
  await page.evaluate(() => window.__MNX_TEST__.navigate({ view: 'experiences' }))
  for (let i = 0; i < 40 && !(await panel.count()); i++) {
    await page.getByRole('button', { name: 'Next experience', exact: true }).click()
  }
  await panel.waitFor()
}

async function launch() {
  await panel.getByRole('button', { name: /^Start/ }).click()
  await lab.locator('[data-testid=start-experience]').waitFor({ timeout: SLOW })
}

console.log(`Verifying ${manifest.id} ${manifest.version} in ${APP}`)
let failed = false
try {
  await step('app loads (fresh profile, app-local writes in memory)', async () => {
    await page.goto(`${APP}/app?mnxTest=1&view=addons`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__MNX_TEST__, null, { timeout: SLOW })
    await page.evaluate(() => window.__MNX_TEST__.waitForReady())
    const skip = page.getByRole('button', { name: 'Skip tour', exact: true })
    if (await skip.isVisible().catch(() => false)) await skip.click()
  })

  await step('install from file', async () => {
    // The status line is the installer's local state and can vanish when the
    // Store re-renders after an install, so success is the Installed count
    // going up by one; a refusal is any other status the installer shows.
    const tab = page.getByText(/^Installed \d+$/).first()
    const installed = async () => Number((await tab.textContent())?.match(/\d+/)?.[0] ?? NaN)
    const before = await installed()
    await page.locator('input[type=file][accept=".mnxpack"]').setInputFiles(PACK)
    const status = page.locator('.mnx-store__install-status')
    const deadline = Date.now() + 30_000
    for (;;) {
      const text = (await status.textContent({ timeout: 250 }).catch(() => null))?.trim()
      if (text && !/^Verifying|^Installed /.test(text)) throw new Error(`install refused: ${text}`)
      if ((await installed()) === before + 1) break
      if (Date.now() > deadline) throw new Error(`still ${await installed()} installed after 30 s (status: ${text ?? 'none'})`)
      await page.waitForTimeout(250)
    }
    await snap('installed')
    return `installed add-ons ${before} → ${before + 1}`
  })

  await step('settings: Graphics quality is listed and set to Low', async () => {
    await page.getByPlaceholder('Search all add-ons').fill(LABEL)
    await page.getByRole('button', { name: `View ${LABEL}`, exact: true }).click()
    const row = page.getByText('Graphics quality', { exact: true }).first()
    await row.waitFor({ timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    const select = page.locator('select').filter({ has: page.locator('option[value="ultra"]') })
    assert.equal(await select.count(), 1, 'one Graphics quality select')
    assert.equal(await select.inputValue(), 'auto', 'defaults to Automatic')
    await select.selectOption('low')
    await snap('settings')
  })

  await step('listed in Practice → Experiences, never finished', async () => {
    await openInExperiences()
    await panel.getByRole('button', { name: `Start · ${manifest.surfaces.calendar.defaultMinutes} min` }).waitFor()
    assert.match(await runs.innerText(), /never finished/)
  })

  await step('launches in the sandbox with the host theme', async () => {
    await launch()
    const frame = lab.locator('html')
    assert.ok(await frame.getAttribute('data-mnx-scheme'), 'host theme applied')
    assert.equal(await lab.locator('[aria-label="Toggle theme"]').count(), 0, 'no own theme toggle in MnemoNexus')
    await snap('home')
    return `scheme ${await frame.getAttribute('data-mnx-scheme')}`
  })

  await step('the Low setting reached the lab; change it in the lab to Medium', async () => {
    await lab.locator('[aria-label="Graphics settings"]').click({ timeout: SLOW })
    await lab.locator('[data-preset=low][aria-pressed=true]').waitFor({ timeout: SLOW })
    await lab.locator('[data-preset=medium]').click({ timeout: SLOW })
    await lab.locator('[data-preset=medium][aria-pressed=true]').waitFor({ timeout: SLOW })
    await page.keyboard.press('Escape')
  })

  await step('start an experience: the bench', async () => {
    await lab.locator('[data-testid=start-experience]').click({ timeout: SLOW })
    await lab.locator('[data-testid=station-sample-prep].ui-tab-on').waitFor({ timeout: SLOW })
    await page.waitForTimeout(15_000)
    await snap('bench')
  })

  await step('sit in the bench chair and stand up inside the sandbox', async () => {
    const seat = lab.locator('[data-testid=seat-toggle]')
    await seat.filter({ hasText: 'Sit down' }).waitFor({ timeout: SLOW })
    await seat.click({ timeout: SLOW })
    await seat.filter({ hasText: 'Stand up' }).waitFor({ timeout: SLOW })
    await lab.locator('[data-testid=chair-actions]').click({ timeout: SLOW })
    await lab.locator('[data-testid=chair-push-in]').click({ timeout: SLOW })
    await lab.locator('[data-testid=chair-actions]').click({ timeout: SLOW })
    await lab.locator('[data-testid=chair-pull-out]').click({ timeout: SLOW })
    await snap('seated')
    await page.keyboard.press('e')
    await seat.filter({ hasText: 'Sit down' }).waitFor({ timeout: SLOW })
  })

  await step('visit the plate reader', async () => {
    await lab.locator('[data-testid=station-plate-reader]').click({ timeout: SLOW })
    await lab.locator('[data-testid=station-plate-reader].ui-tab-on').waitFor({ timeout: SLOW })
    await page.waitForTimeout(15_000)
    await snap('plate-reader')
  })

  await step('End session completes the run; the app counts it', async () => {
    await lab.locator('[data-testid=end-session]').click({ timeout: SLOW })
    await page.locator(`iframe[title="${LABEL}"]`).waitFor({ state: 'detached', timeout: 30_000 })
    await openInExperiences()
    const text = await runs.innerText()
    assert.match(text, /Run once · last today/)
    await snap('run-counted')
    return text.replace(/\s+/g, ' ').trim()
  })

  await step('relaunch: the in-lab choice came back from mnx.storage', async () => {
    await launch()
    await lab.locator('[aria-label="Graphics settings"]').click({ timeout: SLOW })
    await lab.locator('[data-preset=medium][aria-pressed=true]').waitFor({ timeout: SLOW })
    await page.keyboard.press('Escape')
  })

  await step('End session before doing anything leaves without counting', async () => {
    await lab.locator('[data-testid=end-session]').click({ timeout: SLOW })
    await page.locator(`iframe[title="${LABEL}"]`).waitFor({ state: 'detached', timeout: 30_000 })
    await openInExperiences()
    assert.match(await runs.innerText(), /Run once · last today/)
  })

  await step('no failure screen and no uncaught errors', async () => {
    assert.equal(await page.getByText(/stopped working|could not start|failed/i).count(), 0, 'no failure screen')
    assert.deepEqual(errors, [])
  })
} catch {
  failed = true
}

await browser.close()
const report = {
  app: APP,
  addon: `${manifest.id}@${manifest.version}`,
  passed: !failed,
  steps,
  errors,
  isolation: overlay.summary(),
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const { keptInMemory, reachedDisk, refusedDevWrites } = overlay.summary()
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${steps.filter((s) => s.ok).length}/${steps.length} steps. App-local writes: ${keptInMemory.length} kept in memory, ${reachedDisk.length} reached disk; ${refusedDevWrites.length} other dev write(s) refused.`)
console.log(`Report and screenshots: ${OUT}`)
process.exit(failed ? 1 : 0)
