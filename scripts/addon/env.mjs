// Where the add-on tools live on this machine: the MnemoNexus add-on kit, and a
// headless Chromium for Playwright. Shared by kit.mjs and verify-app.mjs.
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The kit checkout (default ../mnx-addon-kit-release; MNX_ADDON_KIT overrides). */
export function kitDir() {
  const kit = resolve(process.env.MNX_ADDON_KIT ?? join(project, '../mnx-addon-kit-release'))
  if (!existsSync(join(kit, 'tools/src/cli.ts'))) {
    console.error(`The MnemoNexus add-on kit was not found at ${kit}. Set MNX_ADDON_KIT to its folder.`)
    process.exit(1)
  }
  return kit
}

/** Playwright, as installed in the kit. */
export function playwright() {
  return createRequire(join(kitDir(), 'package.json'))('playwright')
}

function playwrightBrowsers() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright')
  if (process.platform === 'darwin') return join(homedir(), 'Library/Caches/ms-playwright')
  return join(homedir(), '.cache/ms-playwright')
}

/** MNX_CHROMIUM, else the newest chromium_headless_shell-<rev>/chrome-headless-shell-*\/chrome-headless-shell[.exe]. */
export function findChromium() {
  if (process.env.MNX_CHROMIUM) return process.env.MNX_CHROMIUM
  const base = playwrightBrowsers()
  if (!existsSync(base)) return undefined
  const revisions = readdirSync(base)
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
  for (const revision of revisions) {
    for (const folder of readdirSync(join(base, revision))) {
      const path = join(base, revision, folder, exe)
      if (folder.startsWith('chrome-headless-shell') && existsSync(path)) return path
    }
  }
  return undefined
}

/**
 * Chromium flags that put headless rendering on the real GPU (D3D11 ANGLE for
 * WebGL, Dawn for WebGPU). Without them the headless shell may fall back to
 * SwiftShader, whose frame times say nothing about the lab. MNX_SOFTWARE_GPU=1
 * keeps the software path (e.g. to reproduce the kit's scenario renderer).
 */
export const GPU_ARGS = process.env.MNX_SOFTWARE_GPU === '1' ? [] : ['--use-angle=d3d11', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']

/**
 * A browser for GPU measurements. The headless shell has no dxil.dll, so Dawn
 * cannot create a D3D12 device and three falls back to WebGL 2; the full
 * Chromium build ships the DirectX shader compiler. MNX_GPU_CHROMIUM overrides.
 */
export function findGpuChromium() {
  if (process.env.MNX_GPU_CHROMIUM) return process.env.MNX_GPU_CHROMIUM
  const base = playwrightBrowsers()
  if (process.env.MNX_SOFTWARE_GPU === '1' || !existsSync(base)) return findChromium()
  const revisions = readdirSync(base).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  const exe = process.platform === 'win32' ? 'chrome-win64/chrome.exe' : process.platform === 'darwin' ? 'chrome-mac/Chromium.app/Contents/MacOS/Chromium' : 'chrome-linux/chrome'
  for (const revision of revisions) if (existsSync(join(base, revision, exe))) return join(base, revision, exe)
  return findChromium()
}
