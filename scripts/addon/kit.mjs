// Run the MnemoNexus add-on kit's tools on this project (manifest.json and
// scenarios/ at the root, entry src/main.tsx).
//
//   npm run addon:check [-- --screenshots]   manifest, typecheck + build, static scan, headless scenarios
//   npm run addon:pack                       dist/<id>-<version>.mnxpack
//   npm run addon:dev                        the kit's mock host, with live reload
//
// The kit is a separate checkout (default ../mnx-addon-kit-release; set
// MNX_ADDON_KIT to use another) and runs under Bun. Its headless run needs a
// Chromium: unless MNX_CHROMIUM is set, the newest headless shell Playwright
// has installed on this machine is used.
import { spawnSync } from 'node:child_process'
import { findChromium, kitDir, project } from './env.mjs'

const [command, ...rest] = process.argv.slice(2)
if (!['check', 'pack', 'dev'].includes(command)) {
  console.error('Usage: node scripts/addon/kit.mjs check|pack|dev [kit flags]')
  process.exit(1)
}

const env = { ...process.env }
env.MNX_ACTION_TIMEOUT_MS ??= '60000'
if (command !== 'pack' && !env.MNX_CHROMIUM) {
  const chromium = findChromium()
  if (chromium) env.MNX_CHROMIUM = chromium
}

const run = spawnSync('bun', ['tools/src/cli.ts', command, project, ...rest], { cwd: kitDir(), env, stdio: 'inherit' })
if (run.error) {
  console.error(`Could not run Bun (${run.error.message}). The add-on kit needs Bun: https://bun.sh`)
  process.exit(1)
}
process.exit(run.status ?? 1)
