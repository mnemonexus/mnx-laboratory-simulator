// Install the built pack in MnemoNexus for real: it lands in the app data
// folder the desktop app reads, so it is there the next time MnemoNexus starts.
//
//   npm run addon:install-app
//
// Needs MnemoNexus's dev server (default http://127.0.0.1:1420, or MNX_APP_URL)
// and a built pack (`npm run addon:pack`). Only this add-on's pack folder and
// the pack roster reach the disk. Everything else the app writes from this
// browser (it re-saves settings when it loads, for one) stays in memory, through
// the same overlay verify-app uses.
//
// What this cannot do: mark the add-on installed. That mark is a per-profile
// record in the WebView's localStorage, so the desktop app gets it when you
// click Install there (Add-ons → the add-on → Install: nothing is downloaded,
// the pack is already stored). A second fresh browser checks that the app
// registers the stored pack at this version and that that click works.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { overlayAppLocal } from './appOverlay.mjs'
import { findChromium, playwright, project } from './env.mjs'

const APP = (process.env.MNX_APP_URL ?? 'http://127.0.0.1:1420').replace(/\/$/, '')
const manifest = JSON.parse(readFileSync(join(project, 'manifest.json'), 'utf8'))
const PACK = join(project, 'dist', `${manifest.id}-${manifest.version}.mnxpack`)
const PACK_DIR = `mnx-packs/${manifest.id}`
readFileSync(PACK) // fail early, with the path, if the pack is not built

const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })

async function openApp(context, view) {
  const page = await context.newPage()
  await page.goto(`${APP}/app?mnxTest=1&view=${view}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__MNX_TEST__, null, { timeout: 120_000 })
  await page.evaluate(() => window.__MNX_TEST__.waitForReady())
  const skip = page.getByRole('button', { name: 'Skip tour', exact: true })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  return page
}

let ok = false
try {
  // 1. Install. Writes under this add-on's pack folder, and the roster, reach the disk.
  const installing = await browser.newContext()
  const overlay = await overlayAppLocal(installing, {
    app: APP,
    passThrough: (path) => path === 'mnx-packs/roster.json' || path === PACK_DIR || path.startsWith(`${PACK_DIR}/`),
  })
  const page = await openApp(installing, 'addons')
  await page.locator('input[type=file][accept=".mnxpack"]').setInputFiles(PACK)
  const record = `PUT ${PACK_DIR}/${manifest.version}/index.json`
  const status = page.locator('.mnx-store__install-status')
  const deadline = Date.now() + 30_000
  while (!overlay.summary().reachedDisk.includes(record)) {
    const text = (await status.textContent({ timeout: 250 }).catch(() => null))?.trim()
    if (text && !/^Verifying|^Installed /.test(text)) throw new Error(`install refused: ${text}`)
    if (Date.now() > deadline) throw new Error('the pack was not stored within 30 s')
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(1000) // let the roster write follow
  const { reachedDisk, keptInMemory } = overlay.summary()
  await installing.close()
  console.log(`Installed ${manifest.id} ${manifest.version}. Written to disk:\n  ${reachedDisk.join('\n  ')}`)
  console.log(`Kept in memory (not written): ${keptInMemory.length} path(s), e.g. ${keptInMemory.filter((p) => p.startsWith('settings/')).join(', ') || 'none in settings/'}`)

  // 2. A fresh browser, writing nothing to disk, registers the stored pack at
  //    this version, and the Store's Install marks it installed.
  const checking = await browser.newContext()
  await overlayAppLocal(checking, { app: APP })
  const check = await openApp(checking, 'addons')
  await check.getByPlaceholder('Search all add-ons').fill(manifest.label)
  await check.getByRole('button', { name: `View ${manifest.label}`, exact: true }).click()
  await check.getByRole('button', { name: 'Install', exact: true }).first().click({ timeout: 30_000 })
  await check.getByText(`Installed ${manifest.version}`, { exact: true }).first().waitFor({ timeout: 30_000 })
  await checking.close()
  console.log(`\nA fresh MnemoNexus registers the stored pack as ${manifest.label} ${manifest.version}, and Install marks it installed.`)
  console.log(`In the desktop app: Add-ons → search "${manifest.label}" → Install (no download), then Practice → Experiences.`)
  ok = true
} catch (error) {
  console.error(`Install failed: ${String(error.message ?? error).split('\n')[0]}`)
}
await browser.close()
process.exit(ok ? 0 : 1)
