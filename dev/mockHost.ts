// A stand-in for MnemoNexus, for `npm run dev` and the standalone build only.
//
// It defines just enough of `window.mnx` (protocol 1) for the lab to start
// outside the app: a standalone launch, the manifest's default settings and
// standalone IndexedDB storage, with an in-memory fallback. It does not
// theme the lab, so the lab's own light/dark toggle stays available.
//
// For a faithful host (themes, settings changes, scenarios) use
// `npm run addon:dev`, the add-on kit's mock host.
import type { ExperienceHost, ExperienceResult, Permission } from '@mnemonexus/addon-sdk'
import manifest from '../manifest.json'
import { load, save, remove, keys } from './storage'

const root = document.getElementById('root')!
// Only the standalone entry grants native mouse capture. The shipped add-on
// entry never loads this harness and never reads the surrounding host page.
if (window.top === window) document.documentElement.dataset.labNativeCapture = 'true'

/** MnemoNexus closes the frame when a run ends; here, say so over the page. */
function ended(text: string) {
  const note = document.createElement('div')
  note.textContent = `${text} (In MnemoNexus the lab would close now. Reload to start again.)`
  note.style.cssText =
    'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1000;padding:10px 14px;' +
    'border-radius:8px;background:#161513;color:#f3efe6;font:13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)'
  document.body.appendChild(note)
}

const host: ExperienceHost = {
  protocolVersion: 1,
  capabilities: ['settings-v1', 'wasm-v1'],
  root,
  props: {
    kind: 'experience',
    extensionId: manifest.id,
    surface: 'standalone',
    items: [],
    permissions: manifest.permissions as Permission[],
    settings: Object.fromEntries(manifest.settings.map((s) => [s.id, s.default])),
  },
  complete(result: ExperienceResult) {
    console.info('[dev host] complete', result)
    ended(`Session complete after ${result.elapsedSeconds} s.`)
  },
  exit() {
    console.info('[dev host] exit')
    ended('Session ended without completing.')
  },
  onUpdate() {},
  // the dev server and the standalone build serve the pack's assets from public/
  asset: async (path) => {
    const response = await fetch(`/${path}`)
    if (!response.ok) throw new Error(`No asset "${path}" (${response.status}).`)
    return response.arrayBuffer()
  },
  generate: () => Promise.reject(new Error('Model calls are not available here.')),
  externalApi: () => Promise.reject(new Error('Data sources are not available here.')),
  storage: {
    get: load,
    set: async (key, value) => { await save(key, value); return true },
    delete: remove,
    keys,
  },
}

;(window as unknown as { mnx: ExperienceHost }).mnx = host
